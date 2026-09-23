import test from 'node:test';
import assert from 'node:assert/strict';
import { AxonHubClient, QuotaError, QUOTA_QUERY } from '../src/client.ts';
import { formatSnapshot, summarizeChannel } from '../src/format.ts';

const credentials = { baseUrl: 'https://axon.test', email: 'admin@example.test', password: 'test-secret' };
const window = { used_percent: 18, limit_window_seconds: 18000, reset_at: 1893456000 };
const channel = (id = '1', data: unknown = { rate_limit: { primary_window: window } }) => ({
    id, name: `渠道 ${id}`, type: 'codex', status: 'enabled', providerQuotaStatus: { status: 'available', quotaData: data },
});
const page = (nodes: unknown[], next = false, cursor: string | null = null) => ({ data: {
    queryChannels: { edges: nodes.map(node => ({ node })), pageInfo: { hasNextPage: next, endCursor: cursor } },
} });
const json = (data: unknown, status = 200) => new Response(JSON.stringify(data), { status });
type Call = { path: string; body: Record<string, any>; headers: Record<string, string> };
function mock(handler: (call: Call) => Response | Promise<Response>): typeof fetch {
    return (async (url, init) => handler({ path: String(url), body: JSON.parse(String(init?.body)), headers: init?.headers as Record<string, string> })) as typeof fetch;
}

test('live-shaped primary weekly window, two windows, exhausted and invalid values', () => {
    const summary = summarizeChannel(channel('1', { rate_limit: {
        primary_window: { ...window, used_percent: 22, limit_window_seconds: 604800 },
        secondary_window: { ...window, used_percent: 100, limit_window_seconds: 5400 },
    } }))!;
    assert.equal(summary.windows[0].label, '每周窗口');
    assert.equal(summary.windows[0].remaining, 78);
    assert.equal(summary.windows[1].label, '90 分钟窗口');
    assert.equal(summary.windows[1].remaining, 0);
    const invalid = summarizeChannel(channel('2', { rate_limit: { primary_window: { used_percent: '3', reset_at: '10' } } }))!;
    assert.equal(invalid.windows[0].label, '主窗口');
    assert.equal(invalid.windows[0].remaining, null); assert.equal(invalid.windows[0].resetAt, null);
    assert.equal(summarizeChannel(channel('3', { rate_limit: { primary_window: { used_percent: 120 } } }))!.windows[0].remaining, 0);
});

test('missing/failed data, disabled channels, Beijing time, stale reset and safe long output', () => {
    assert.equal(summarizeChannel(channel('1', {}))!.state, 'missing');
    assert.equal(summarizeChannel(channel('1', { error: 'contains-secret' }))!.state, 'failed');
    assert.equal(summarizeChannel({ ...channel(), status: 'disabled' }), null);
    const normal = summarizeChannel(channel())!;
    const messages = formatSnapshot({ readAt: 1893456000001, channels: [normal] });
    assert.match(messages[0], /2030\/01\/01 08:00/);
    assert.match(messages[0], /等待 AxonHub 更新/);
    assert.match(formatSnapshot({ readAt: 0, channels: [] })[0], /没有可显示/);
    const long = formatSnapshot({ readAt: 0, channels: Array.from({ length: 90 }, (_, i) => ({ ...normal, id: String(i), name: 'a'.repeat(200) })) });
    assert.ok(long.length > 1);
    assert.ok(long.every(text => text.length <= 1800));
    assert.ok(long.every(text => text.includes('数据来源：')));
});

test('one login and one read for concurrent calls, 60 second cache, compact storage', async () => {
    let clock = 100000; const calls: Call[] = [];
    const client = new AxonHubClient(credentials, { now: () => clock, fetch: mock(call => {
        calls.push(call);
        return json(call.path.endsWith('/signin') ? { token: 'secret-token' }
            : page([channel('1', { rate_limit: { primary_window: window }, unused: 'x'.repeat(100000) })]));
    }) });
    const results = await Promise.all(Array.from({ length: 30 }, () => client.getQuota()));
    assert.equal(calls.length, 2);
    assert.equal(results[0], results[29]);
    assert.ok(JSON.stringify(results[0]).length < 600);
    assert.equal(calls[1].headers.Authorization, 'Bearer secret-token');
    assert.ok(!QUOTA_QUERY.includes('credentials'));
    assert.match(QUOTA_QUERY, /providerType/); // Required by the deployed quota resolver.
    clock += 59999; await client.getQuota(); assert.equal(calls.length, 2);
    clock++; await client.getQuota(); assert.equal(calls.length, 3);
    client.dispose();
});

test('all pages, enabled/type filter, and no partial report on repeated cursor', async () => {
    const inputs: any[] = []; let loop = false;
    const client = new AxonHubClient(credentials, { ttlMs: 0, fetch: mock(call => {
        if (call.path.endsWith('/signin')) return json({ token: 't' });
        const input = call.body.variables.input; inputs.push(input);
        return json(input.after ? page([channel('2')], loop, 'next') : page([channel('1')], true, 'next'));
    }) });
    assert.deepEqual((await client.getQuota()).channels.map(c => c.id), ['1', '2']);
    assert.deepEqual(inputs[0].where, { statusIn: ['enabled'], typeIn: ['codex'] });
    assert.equal(inputs[1].after, 'next');
    loop = true; await assert.rejects(client.getQuota(), (e: QuotaError) => e.code === 'pagination');
    client.dispose();
});

for (const graphql of [false, true]) test(`expired login retried only once (${graphql ? 'GraphQL' : 'HTTP'})`, async () => {
    let logins = 0; let queries = 0;
    const client = new AxonHubClient(credentials, { fetch: mock(call => {
        if (call.path.endsWith('/signin')) return json({ token: `t${++logins}` });
        queries++;
        if (queries === 1) return graphql ? json({ errors: [{ extensions: { code: 'UNAUTHENTICATED' } }] }) : json({}, 401);
        return json(page([channel()]));
    }) });
    await Promise.all([client.getQuota(), client.getQuota()]);
    assert.equal(logins, 2); assert.equal(queries, 2); client.dispose();
});

test('persistent expiry stops after retry and cools down', async () => {
    let logins = 0;
    const client = new AxonHubClient(credentials, { fetch: mock(call => call.path.endsWith('/signin')
        ? json({ token: `t${++logins}` }) : json({}, 401)) });
    await assert.rejects(client.getQuota(), (e: QuotaError) => e.code === 'login');
    await assert.rejects(client.getQuota(), (e: QuotaError) => e.code === 'loginCooldown');
    assert.equal(logins, 2); client.dispose();
});

test('bad passwords cool down, never reflect upstream secrets', async () => {
    let count = 0; let clock = 100;
    const client = new AxonHubClient(credentials, { now: () => clock, fetch: mock(() => { count++; return json({ error: 'test-secret' }, 401); }) });
    await assert.rejects(client.getQuota(), (e: QuotaError) => e.code === 'login' && !e.message.includes('test-secret'));
    await assert.rejects(client.getQuota(), (e: QuotaError) => e.code === 'loginCooldown');
    assert.equal(count, 1); clock += 30000;
    await assert.rejects(client.getQuota()); assert.equal(count, 2); client.dispose();
});

test('expired cache is not returned during outage; forbidden is not retried', async () => {
    let broken = false; let clock = 100000; let requests = 0;
    const client = new AxonHubClient(credentials, { now: () => clock, fetch: mock(call => {
        requests++;
        if (call.path.endsWith('/signin')) return json({ token: 't' });
        return broken ? json({ error: 'secret' }, 403) : json(page([channel()]));
    }) });
    await client.getQuota(); broken = true; clock += 60000;
    await assert.rejects(client.getQuota(), (e: QuotaError) => e.code === 'forbidden');
    assert.equal(requests, 3); client.dispose();
});

test('request timeout and unload abort cleanly', async () => {
    const fetcher = ((_url: unknown, init: RequestInit) => new Promise((_resolve, reject) => {
        init.signal!.addEventListener('abort', () => reject(new Error('aborted with secret')), { once: true });
    })) as typeof fetch;
    const keepAlive = setTimeout(() => {}, 1000);
    try {
        const timed = new AxonHubClient(credentials, { fetch: fetcher, timeoutMs: 15 });
        await assert.rejects(timed.getQuota(), (e: QuotaError) => e.code === 'timeout'); timed.dispose();
        const stopped = new AxonHubClient(credentials, { fetch: fetcher });
        const pending = stopped.getQuota(); stopped.dispose();
        await assert.rejects(pending, (e: QuotaError) => e.code === 'cancelled');
        assert.throws(() => stopped.getQuota(), (e: QuotaError) => e.code === 'cancelled');
    } finally { clearTimeout(keepAlive); }
});

test('oversized, malformed, partial-error and network responses are safe', async () => {
    for (const [expected, response] of [
        ['size', () => new Response('x'.repeat(1024 * 1024 + 1))],
        ['shape', () => new Response('<html>secret</html>')],
        ['graphql', () => json({ ...page([channel()]), errors: [{ message: 'secret' }] })],
        ['network', () => { throw new Error('network secret'); }],
    ] as const) {
        const client = new AxonHubClient(credentials, { fetch: mock(call => call.path.endsWith('/signin') ? json({ token: 't' }) : response()) });
        await assert.rejects(client.getQuota(), (e: QuotaError) => e.code === expected && !e.message.includes('secret'));
        client.dispose();
    }
});

test('one explicit query retries a transient timeout once, sharing the result with concurrent callers', async () => {
    let logins = 0, queries = 0;
    const failures: Array<{ path: string; code: string; elapsed: number }> = [];
    const client = new AxonHubClient(credentials, {
        timeoutMs: 10,
        onRequestFailure: (path, code, elapsed) => failures.push({ path, code, elapsed }),
        fetch: mock(call => {
            if (call.path.endsWith('/signin')) { logins++; return json({ token: 'secret-token' }); }
            queries++;
            if (queries === 1) return new Promise((_resolve, reject) => {
                // Model a hung upstream request; the request's AbortSignal is checked by fetch itself.
                setTimeout(() => reject(new DOMException('aborted with secret', 'AbortError')), 15);
            });
            return json(page([channel()]));
        }),
    });
    const [first, second] = await Promise.all([client.getQuota(), client.getQuota()]);
    assert.equal(first, second); assert.equal(first.channels.length, 1);
    assert.equal(logins, 1); assert.equal(queries, 2);
    assert.deepEqual(failures.map(f => [f.path, f.code]), [['graphql', 'timeout']]);
    assert.ok(!JSON.stringify(failures).includes('secret'));
    await client.getQuota(); assert.equal(queries, 2);
    client.dispose();
});

test('failed login transport has no incorrect-password cooldown; subsequent explicit command can recover', async () => {
    let signin = 0, queries = 0;
    const client = new AxonHubClient(credentials, { timeoutMs: 10, fetch: mock(call => {
        if (call.path.endsWith('/signin')) {
            signin++;
            return signin === 1 ? new Promise((_resolve, reject) => setTimeout(() => reject(new Error('timeout secret')), 15)) : json({ token: 't' });
        }
        queries++; return json(page([channel()]));
    }) });
    await assert.rejects(client.getQuota(), (error: QuotaError) => error.code === 'timeout');
    assert.equal((await client.getQuota()).channels.length, 1);
    assert.equal(signin, 2); assert.equal(queries, 1);
    client.dispose();
});

test('repeated GraphQL timeouts stop after one retry with no stale cache', async () => {
    let queries = 0;
    const client = new AxonHubClient(credentials, { timeoutMs: 10, fetch: mock(call => {
        if (call.path.endsWith('/signin')) return json({ token: 't' });
        queries++;
        return new Promise((_resolve, reject) => setTimeout(() => reject(new Error('timeout secret')), 15));
    }) });
    await assert.rejects(client.getQuota(), (error: QuotaError) => error.code === 'timeout');
    assert.equal(queries, 2);
    client.dispose();
});

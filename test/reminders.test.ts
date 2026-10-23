import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ReminderService, ReminderStore, dueCards, REMINDER_INTERVAL_MS, EXPIRY_THRESHOLD_MS } from '../src/reminders.ts';
import { summarizeChannel } from '../src/format.ts';
import { DEFAULT_CONFIG } from '../src/config.ts';
import { AxonHubClient } from '../src/client.ts';
import type { Context, Snapshot, ChannelSummary } from '../src/types.ts';

const NOW = Date.parse('2030-01-01T00:00:00Z');
const id = (n: number) => `gid://axonhub/Channel/${n}`;
const cards = (expiry = NOW + 24 * 3600000, key = 'a'.repeat(64)) => [{ key, expiresAt: expiry }];
const channel = (n = 1, resetCards = cards()): ChannelSummary => ({ id: id(n), name: 'Channel ' + n, state: 'ok', windows: [], resetCards });
function setup(groups = false) {
    const dir = mkdtempSync(join(tmpdir(), 'axon-reminder-')), file = join(dir, 'reminders.json');
    const store = new ReminderStore(file, 'https://axonhub.example.com');
    if (groups) store.setGroup('123456', { enabled: true, channelIds: [id(1)] });
    const sent: any[] = [], selected: string[][] = [], warnings: string[] = [];
    let data: Snapshot = { readAt: NOW, channels: [channel()] };
    let query = async (_ids: readonly string[]) => data;
    let send = async (_params: any): Promise<unknown> => ({ status: 'ok', retcode: 0 });
    const context = { pluginManager: { config: {} }, adapterName: 'test', logger: { warn(message: string) { warnings.push(message); } }, actions: {
        async call(action: string, params: any) { assert.equal(action, 'send_msg'); sent.push(params); return send(params); },
    } } as unknown as Context;
    const client = { getQuotaForChannels(ids: readonly string[]) { selected.push([...ids]); return query(ids); }, async getQuota() { return data; } } as unknown as AxonHubClient;
    let now = NOW;
    const service = new ReminderService(context, { ...DEFAULT_CONFIG, allowedGroups: '123456,234567' }, client, store, () => now);
    return { dir, file, store, sent, selected, warnings, service, client, context, setData(value: Snapshot) { data = value; },
        setQuery(value: typeof query) { query = value; }, setSend(value: typeof send) { send = value; }, setNow(value: number) { now = value; },
        close() { service.dispose(); rmSync(dir, { recursive: true, force: true }); } };
}

test('recharge-card extraction keeps only reliable available card IDs and expiry, never raw card data', () => {
    const raw = (resets: unknown, error?: string) => ({ id: id(1), name: 'test', type: 'codex', status: 'enabled', providerQuotaStatus: { status: 'available', quotaData: { _resets: resets, ...(error ? { error } : {}) } } });
    const item = { id: 'sensitive-card-id', title: 'never-store-card-title', type: 'codex_rate_limits', status: 'available', expiresAt: new Date(NOW + 3600000).toISOString() };
    const summary = summarizeChannel(raw({ supported: true, resets: [item, item, { ...item, id: 'used', status: 'used' }, { ...item, id: 'bad-date', expiresAt: '' }, { ...item, id: '' }] }))!;
    assert.equal(summary.resetCards?.length, 1); assert.equal(summary.resetCards[0].expiresAt, NOW + 3600000);
    assert.ok(!JSON.stringify(summary).includes('sensitive-card-id')); assert.ok(!JSON.stringify(summary).includes('never-store-card-title'));
    assert.equal(summarizeChannel(raw({ supported: true, error: 'failed', resets: [item] }))!.resetCards, undefined);
    assert.equal(summarizeChannel(raw({ supported: true, resets: [item] }, 'quota-failed'))!.resetCards, undefined);
    assert.equal(summarizeChannel(raw({ supported: false, resets: [item] }))!.resetCards, undefined);
});

test('expiry threshold is strictly under 48h, excludes expired, malformed and failed data', () => {
    const c = channel(1, [
        ...cards(NOW - 1), ...cards(NOW), ...cards(NOW + 1), ...cards(NOW + EXPIRY_THRESHOLD_MS - 1, 'b'.repeat(64)),
        ...cards(NOW + EXPIRY_THRESHOLD_MS, 'c'.repeat(64)), ...cards(NaN, 'd'.repeat(64)), ...cards(NOW + 1, 'bad'),
    ]);
    assert.equal(dueCards(c, NOW).length, 2); assert.equal(dueCards({ ...c, state: 'failed' }, NOW).length, 0);
    assert.equal(dueCards({ ...c, resetCards: undefined }, NOW).length, 0);
});

test('default-off means zero timers and zero upstream calls; enable starts checks, disable cancels them', async t => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const state = setup();
    try {
        t.mock.timers.tick(REMINDER_INTERVAL_MS * 2); await Promise.resolve(); assert.equal(state.selected.length, 0);
        await state.service.checkNow(); assert.equal(state.selected.length, 0);
        state.service.setGroup('123456', { enabled: true, channelIds: [id(1)] });
        t.mock.timers.tick(999); assert.equal(state.selected.length, 0);
        t.mock.timers.tick(1); await state.service.checkNow(); assert.equal(state.selected.length, 1); assert.equal(state.sent.length, 1);
        await Promise.resolve();
        t.mock.timers.tick(REMINDER_INTERVAL_MS); await state.service.checkNow(); assert.equal(state.selected.length, 2); assert.equal(state.sent.length, 1);
        state.service.setGroup('123456', { enabled: false, channelIds: [id(1)] });
        t.mock.timers.tick(REMINDER_INTERVAL_MS * 3); await state.service.checkNow(); assert.equal(state.selected.length, 2);
    } finally { state.close(); t.mock.timers.reset(); }
});

test('active groups share selected-channel query; dedupe survives restart and new expiry can notify', async () => {
    const state = setup(true);
    try {
        state.service.setGroup('234567', { enabled: true, channelIds: [id(2)] });
        state.setData({ readAt: NOW, channels: [channel(), channel(2), channel(3)] });
        await state.service.checkNow(); assert.equal(state.selected.length, 1); assert.deepEqual(state.selected[0].sort(), [id(1), id(2)]);
        assert.equal(state.sent.length, 2); assert.ok(state.sent.every(s => s.message[0].type === 'text' && !s.message[0].data.text.includes('Channel 3')));
        await state.service.checkNow(); assert.equal(state.sent.length, 2);
        assert.equal(statSync(state.file).mode & 0o777, 0o600);
        state.service.dispose();
        const reloaded = new ReminderStore(state.file, 'https://axonhub.example.com');
        const restarted = new ReminderService(state.context, { ...DEFAULT_CONFIG, allowedGroups: '123456,234567' }, state.client, reloaded, () => NOW);
        try { await restarted.checkNow(); assert.equal(state.sent.length, 2);
            state.setData({ readAt: NOW, channels: [channel(1, cards(NOW + 3600000)), channel(2)] });
            await restarted.checkNow(); assert.equal(state.sent.length, 3);
        } finally { restarted.dispose(); }
    } finally { state.close(); }
});

test('global disable, removed whitelist, empty or failed quota prevent scheduled reads or messages', async () => {
    const state = setup(true);
    try {
        for (const config of [{ ...DEFAULT_CONFIG, enabled: false, allowedGroups: '123456' }, { ...DEFAULT_CONFIG, allowedGroups: '' }]) {
            const service = new ReminderService(state.context, config, state.client, state.store, () => NOW);
            await service.checkNow(); assert.equal(state.selected.length, 0); service.dispose();
        }
        assert.throws(() => state.service.setGroup('999999', { enabled: true, channelIds: [id(1)] }));
        state.setData({ readAt: NOW, channels: [{ ...channel(), state: 'failed' }] });
        await state.service.checkNow(); assert.equal(state.sent.length, 0);
        state.setQuery(async () => { throw new Error('network'); }); await state.service.checkNow(); assert.equal(state.sent.length, 0); assert.ok(state.warnings.length);
    } finally { state.close(); }
});

test('checks coalesce; disable, new selection and disposal during an upstream read suppress stale sends', async () => {
    for (const action of ['disable', 'selection', 'dispose'] as const) {
        const state = setup(true); let resolve!: (snapshot: Snapshot) => void;
        state.setQuery(() => new Promise(r => { resolve = r; }));
        try {
            const first = state.service.checkNow(), second = state.service.checkNow(); assert.equal(first, second); assert.equal(state.selected.length, 1);
            if (action === 'disable') state.service.setGroup('123456', { enabled: false, channelIds: [id(1)] });
            if (action === 'selection') state.service.setGroup('123456', { enabled: true, channelIds: [id(2)] });
            if (action === 'dispose') state.service.dispose();
            resolve({ readAt: NOW, channels: [channel()] }); await first; assert.equal(state.sent.length, 0);
        } finally { state.close(); }
    }
});

test('a failed QQ send stays retryable and does not block other groups', async () => {
    const state = setup(true); let broken = true;
    try {
        state.service.setGroup('234567', { enabled: true, channelIds: [id(1)] });
        state.setSend(async params => params.group_id === '123456' && broken ? { status: 'failed', retcode: 1 } : { status: 'ok', retcode: 0 });
        await state.service.checkNow(); assert.equal(state.sent.length, 2);
        broken = false; await state.service.checkNow(); assert.equal(state.sent.length, 3); assert.equal(state.sent[2].group_id, '123456');
    } finally { state.close(); }
});

test('successful in-flight delivery is acknowledged after group disable; site reset cannot inherit old acknowledgement', async () => {
    for (const switchSite of [false, true]) {
        const state = setup(true); let sent!: (value: unknown) => void;
        state.setSend(() => new Promise(resolve => { sent = resolve; }));
        try {
            const checking = state.service.checkNow(); await Promise.resolve();
            assert.equal(state.sent.length, 1);
            if (switchSite) state.store.resetSite('https://new.example.com');
            else state.service.setGroup('123456', { enabled: false, channelIds: [id(1)] });
            sent({ status: 'ok', retcode: 0 }); await checking;
            if (switchSite) assert.equal(Object.keys(JSON.parse(readFileSync(state.file, 'utf8')).delivered).length, 0);
            else {
                state.setSend(async () => ({ status: 'ok', retcode: 0 })); state.service.setGroup('123456', { enabled: true, channelIds: [id(1)] });
                await state.service.checkNow(); assert.equal(state.sent.length, 1);
            }
        } finally { state.close(); }
    }
});

test('configuration changes during a long check schedule the new selection promptly', async t => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const state = setup(true); let resolve!: (snapshot: Snapshot) => void;
    state.setQuery(() => new Promise(r => { resolve = r; }));
    try {
        t.mock.timers.tick(1000); const pending = state.service.checkNow();
        state.service.setGroup('123456', { enabled: true, channelIds: [id(2)] });
        t.mock.timers.tick(1000); assert.equal(state.selected.length, 1);
        resolve({ readAt: NOW, channels: [channel()] }); await pending;
        state.setQuery(async () => ({ readAt: NOW, channels: [channel(2)] }));
        t.mock.timers.tick(1000); await state.service.checkNow(); assert.equal(state.selected.length, 2);
        assert.deepEqual(state.selected[1], [id(2)]);
    } finally { state.close(); t.mock.timers.reset(); }
});

test('reminder state validates storage, fails closed and does not follow a different site', () => {
    const state = setup(true);
    try {
        assert.equal(new ReminderStore(state.file, 'https://other.example.com').groups().length, 0);
        assert.throws(() => state.store.setGroup('123456', { enabled: true, channelIds: [] }));
        assert.throws(() => state.store.setGroup('123456', { enabled: true, channelIds: ['bad'] }));
        writeFileSync(state.file, JSON.stringify({ site: 'https://axonhub.example.com', groups: {}, delivered: [] }));
        assert.throws(() => new ReminderStore(state.file, 'https://axonhub.example.com'));
        writeFileSync(state.file, '{broken'); assert.throws(() => new ReminderStore(state.file, 'https://axonhub.example.com'));
        assert.equal(readFileSync(state.file, 'utf8'), '{broken');
    } finally { state.close(); }
});

test('scoped quota filters requests, coalesces, caches and never poisons the full quota cache', async () => {
    let login = 0, reads = 0; const inputs: any[] = [];
    const client = new AxonHubClient({ baseUrl: 'https://axonhub.example.com', email: 'admin@example.test', password: 'fixture' }, { fetch: async (url, init) => {
        if (String(url).endsWith('/signin')) { login++; return new Response(JSON.stringify({ token: 'fixture' })); }
        reads++; const input = JSON.parse(String(init?.body)).variables.input; inputs.push(input);
        const channels = input.where.idIn ?? [id(1), id(2)];
        return new Response(JSON.stringify({ data: { queryChannels: { edges: channels.map((id: string) => ({ node: { id, name: 'fixture', type: 'codex', status: 'enabled', providerQuotaStatus: { status: 'available', quotaData: {} } } })), pageInfo: { hasNextPage: false } } } }));
    } });
    try {
        const [a, b] = await Promise.all([client.getQuotaForChannels([id(1)]), client.getQuotaForChannels([id(1)])]);
        assert.equal(a, b); assert.equal(reads, 1); assert.equal(login, 1); assert.deepEqual(inputs[0].where.idIn, [id(1)]);
        assert.equal((await client.getQuota()).channels.length, 2); assert.equal(reads, 2);
        assert.equal((await client.getQuotaForChannels([id(2)])).channels.length, 1); assert.equal(reads, 2);
        assert.equal((await client.getQuotaForChannels([])).channels.length, 0); assert.equal(reads, 2);
        assert.throws(() => client.getQuotaForChannels(['invalid']));
    } finally { client.dispose(); }
});

test('cards that expire while another group is sending are not announced as upcoming', async () => {
    const state = setup(true);
    try {
        state.service.setGroup('234567', { enabled: true, channelIds: [id(1)] });
        state.setSend(async () => { state.setNow(NOW + 25 * 3600000); return { status: 'ok', retcode: 0 }; });
        await state.service.checkNow(); assert.equal(state.sent.length, 1);
    } finally { state.close(); }
});

test('same-site service replacement cannot duplicate a still-pending QQ send', async () => {
    const state = setup(true); let delivered!: (result: unknown) => void;
    state.setSend(() => new Promise(resolve => { delivered = resolve; }));
    let replacement: ReminderService | undefined;
    try {
        const original = state.service.checkNow(); await Promise.resolve(); assert.equal(state.sent.length, 1);
        state.service.dispose();
        replacement = new ReminderService(state.context, { ...DEFAULT_CONFIG, allowedGroups: '123456' }, state.client, state.store, () => NOW);
        await replacement.checkNow(); assert.equal(state.sent.length, 1);
        delivered({ status: 'ok', retcode: 0 }); await original;
        await replacement.checkNow(); assert.equal(state.sent.length, 1);
    } finally { replacement?.dispose(); state.close(); }
});

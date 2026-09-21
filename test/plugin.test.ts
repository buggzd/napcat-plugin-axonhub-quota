import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DEFAULT_CONFIG, updateConfig, publicConfig, loadConfig, saveConfig } from '../src/config.ts';
import { MessageHandler, isAllowedCommand } from '../src/messages.ts';
import { AxonHubClient } from '../src/client.ts';
import type { Context, MessageEvent, Config, RouteHandler, Snapshot } from '../src/types.ts';
import * as plugin from '../src/index.ts';

const config: Config = { ...DEFAULT_CONFIG, email: 'admin@example.test', password: 'never-return-this', allowedGroups: '123456', allowedUsers: '234567' };
const group: MessageEvent = { post_type: 'message', message_type: 'group', user_id: '345678', self_id: '456789', group_id: '123456', message: [
    { type: 'at', data: { qq: '456789' } }, { type: 'text', data: { text: ' /额度 ' } },
] };
const privateMessage: MessageEvent = { ...group, message_type: 'private', user_id: '234567', message: '/额度' };
function context(sent: unknown[] = [], routes = new Map<string, RouteHandler>()): Context {
    return { pluginName: 'napcat-plugin-axonhub-quota', configPath: '/unused/config.json', adapterName: 'mock', pluginManager: { config: {} },
        logger: { info() {}, warn() {} }, actions: { async call(_action, params) { sent.push(params); } },
        router: { get(path, handler) { routes.set('GET ' + path, handler); }, post(path, handler) { routes.set('POST ' + path, handler); }, page() {} },
    };
}

test('strict QQ whitelist, mention, message type, own messages and exact command', () => {
    assert.equal(isAllowedCommand(group, config), true);
    assert.equal(isAllowedCommand(privateMessage, config), true);
    for (const event of [
        { ...group, group_id: '999999' }, { ...group, message: '/额度' },
        { ...group, message: '[CQ:at,qq=999999] /额度' },
        { ...group, message: '[CQ:at,qq=456789] /额度更多' },
        { ...group, message: '[CQ:at,qq=all] /额度' },
        { ...group, user_id: group.self_id }, { ...group, post_type: 'notice' },
        { ...privateMessage, user_id: '999999' }, { ...privateMessage, message_type: 'guild' },
    ]) assert.equal(isAllowedCommand(event, config), false);
    assert.equal(isAllowedCommand(group, DEFAULT_CONFIG), false);
    assert.equal(isAllowedCommand(privateMessage, DEFAULT_CONFIG), false);
    assert.equal(isAllowedCommand({ ...group, message: '[CQ:at,qq=456789] /额度' }, config), true);
});

test('write-only password semantics and private atomic persistence', () => {
    assert.equal(publicConfig(config).password, ''); assert.equal(publicConfig(config).hasPassword, true);
    assert.equal(updateConfig(config, publicConfig(config)).password, config.password);
    assert.equal(updateConfig(config, { clearPassword: true }).password, '');
    assert.equal(updateConfig(config, { password: ' changed ' }).password, ' changed ');
    assert.equal(updateConfig(config, { allowedGroups: '123456， 234567\n123456' }).allowedGroups, '123456,234567');
    assert.throws(() => updateConfig(config, { baseUrl: 'https://user:secret@example.test' }));
    assert.throws(() => updateConfig(config, { baseUrl: 'http://public.example.test' }));
    assert.throws(() => updateConfig(config, { allowedUsers: '@all' }));
    const dir = mkdtempSync(join(tmpdir(), 'axon-quota-test-')); const file = join(dir, 'settings.json');
    try {
        saveConfig(file, config); assert.equal(statSync(file).mode & 0o777, 0o600);
        assert.equal(statSync(dir).mode & 0o777, 0o700);
        assert.deepEqual(loadConfig(file), config);
        writeFileSync(file, '{broken'); assert.throws(() => loadConfig(file));
        assert.equal(readFileSync(file, 'utf8'), '{broken');
    } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('per-user cooldown across groups and text-only replies', async () => {
    let clock = 10000; let calls = 0; const sent: any[] = [];
    const fake = { async getQuota() { calls++; return { readAt: clock, channels: [] }; } } as unknown as AxonHubClient;
    const handler = new MessageHandler(context(sent), config, fake, () => clock);
    await handler.handle(group); await handler.handle(group);
    assert.equal(calls, 1); assert.equal(sent.length, 1);
    assert.equal(sent[0].message[0].type, 'text'); assert.equal(sent[0].group_id, '123456');
    clock += 5000; await handler.handle(group); assert.equal(calls, 2);
    handler.dispose(); await handler.handle(privateMessage); assert.equal(sent.length, 2);
});

test('unloading suppresses pending replies', async () => {
    const sent: any[] = []; let resolve!: (value: Snapshot) => void;
    const fake = { getQuota() { return new Promise<Snapshot>(r => { resolve = r; }); } } as unknown as AxonHubClient;
    const handler = new MessageHandler(context(sent), config, fake);
    const pending = handler.handle(group); handler.dispose(); resolve({ readAt: 0, channels: [] });
    await pending; assert.equal(sent.length, 0);
});

test('real lifecycle routes stay protected, config changes clear auth/cache, preview never sends QQ', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'axon-quota-lifecycle-'));
    const previousDir = process.env.AXONHUB_QUOTA_CONFIG_DIR;
    const previousFetch = globalThis.fetch;
    process.env.AXONHUB_QUOTA_CONFIG_DIR = dir;
    let loginCount = 0; let queryCount = 0;
    globalThis.fetch = (async (url, init) => {
        if (String(url).endsWith('/signin')) { loginCount++; return new Response(JSON.stringify({ token: 't' })); }
        queryCount++; assert.match(String(init?.body), /NapCatCodexQuotas/);
        return new Response(JSON.stringify({ data: { queryChannels: { edges: [], pageInfo: { hasNextPage: false } } } }));
    }) as typeof fetch;
    const routes = new Map<string, RouteHandler>(); const sent: unknown[] = []; const ctx = context(sent, routes);
    try {
        await plugin.plugin_init(ctx);
        assert.deepEqual([...routes.keys()], ['GET /config', 'POST /config', 'GET /preview', 'GET /catalog', 'POST /binding']);
        await plugin.plugin_set_config(ctx, config);
        const sanitized = await plugin.plugin_get_config(); assert.ok(!JSON.stringify(sanitized).includes(config.password));
        const preview = routes.get('GET /preview')!;
        const response = { status() { return this; }, json(body: any) { assert.equal(body.code, 0); } };
        await preview({}, response); await preview({}, response);
        assert.equal(loginCount, 1); assert.equal(queryCount, 1); assert.equal(sent.length, 0);
        await plugin.plugin_set_config(ctx, { email: 'new@example.test' }); await preview({}, response);
        assert.equal(loginCount, 2); assert.equal(queryCount, 2);
        await plugin.plugin_cleanup(); await plugin.plugin_init(ctx);
        assert.equal((await plugin.plugin_get_config() as any).hasPassword, true);
    } finally {
        await plugin.plugin_cleanup(); globalThis.fetch = previousFetch;
        if (previousDir === undefined) delete process.env.AXONHUB_QUOTA_CONFIG_DIR;
        else process.env.AXONHUB_QUOTA_CONFIG_DIR = previousDir;
        rmSync(dir, { recursive: true, force: true });
    }
});

test('/help works without upstream or binding, obeys mention/access and command cooldown', async () => {
    const sent: any[] = []; let now = 10000;
    const fake = { getQuota() { throw new Error('Help must not query upstream'); } } as unknown as AxonHubClient;
    const handler = new MessageHandler(context(sent), config, fake, () => now);
    const helpGroup = { ...group, message: '[CQ:at,qq=456789] /help' };
    await handler.handle(helpGroup); assert.equal(sent.length, 1);
    assert.match(sent[0].message[0].data.text, /\/绑定APIKEY/);
    assert.match(sent[0].message[0].data.text, /\/解绑/);
    await handler.handle(helpGroup); assert.equal(sent.length, 1);
    now += 5000;
    await handler.handle({ ...group, message: '/help' });
    await handler.handle({ ...helpGroup, group_id: '999999' });
    await handler.handle({ ...helpGroup, message: '[CQ:at,qq=456789] /help extra' });
    assert.equal(sent.length, 1);
    await handler.handle({ ...privateMessage, user_id: '999999', message: '/help' }); assert.equal(sent.length, 2);
    handler.dispose();
    const restricted = new MessageHandler(context(sent), { ...config, privateBinding: false }, fake, () => now);
    await restricted.handle({ ...privateMessage, user_id: '999999', message: '/help' }); assert.equal(sent.length, 2);
    await restricted.handle({ ...privateMessage, message: '/help' }); assert.equal(sent.length, 3);
    restricted.dispose();
    const disabled = new MessageHandler(context(sent), { ...config, enabled: false }, fake);
    await disabled.handle(helpGroup); assert.equal(sent.length, 3); disabled.dispose();
});

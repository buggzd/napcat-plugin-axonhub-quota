import test from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_CONFIG } from '../src/config.ts';
import { ReminderCommands, type ReminderCommandService } from '../src/reminder-commands.ts';
import type { Config, Context, MessageEvent } from '../src/types.ts';

const channel = (id: number, name = 'Channel ' + id) => ({ id: `gid://axonhub/Channel/${id}`, name });
const event = (text = '', user = '345678'): MessageEvent => ({
    post_type: 'message', message_type: 'group', group_id: '123456', user_id: user, self_id: '456789',
    message: [{ type: 'at', data: { qq: '456789' } }, { type: 'text', data: { text: ' /到期提醒' + (text ? ' ' + text : '') } }],
});
function setup(options: { config?: Partial<Config>; channels?: Array<{ id: string; name: string }>; role?: unknown } = {}) {
    const sent: any[] = [], actions: string[] = [], changes: any[] = [];
    const groups = new Map<string, { enabled: boolean; channelIds: string[] }>();
    let role: unknown = options.role ?? { status: 'ok', retcode: 0, data: { role: 'admin' } };
    let roleCall: (() => Promise<unknown>) | undefined;
    let catalog: () => Promise<Array<{ id: string; name: string }>> = async () => options.channels ?? [channel(2), channel(15)];
    const service: ReminderCommandService = {
        getGroup: group => groups.get(group) ?? { enabled: false, channelIds: [] },
        setGroup(group, value) { changes.push({ group, ...value }); groups.set(group, value); },
        getChannels() { return catalog(); },
    };
    const context = { adapterName: 'test', pluginManager: { config: {} }, logger: { warn() {} }, actions: {
        async call(action: string, params: any) {
            actions.push(action);
            if (action === 'get_group_member_info') {
                assert.equal(params.no_cache, true); assert.equal(params.group_id, '123456');
                return roleCall ? roleCall() : role;
            }
            assert.equal(action, 'send_msg'); assert.equal(params.message_type, 'group');
            sent.push(params); return { status: 'ok', retcode: 0 };
        },
    } } as unknown as Context;
    const handler = new ReminderCommands(context, { ...DEFAULT_CONFIG, allowedGroups: '123456', ...options.config }, service);
    return { handler, sent, actions, changes, groups, service, setRole(value: unknown) { role = value; },
        setRoleCall(value: () => Promise<unknown>) { roleCall = value; }, setCatalog(value: typeof catalog) { catalog = value; } };
}
const text = (state: ReturnType<typeof setup>) => state.sent.map(message => message.message[0].data.text).join('\n');

test('reminder management requires an enabled, whitelisted group and exact self mention', async () => {
    const state = setup();
    for (const invalid of [
        { ...event(), group_id: '999999' }, { ...event(), message_type: 'private' },
        { ...event(), message: '/到期提醒' }, { ...event(), user_id: '456789' },
        { ...event(), message: '[CQ:at,qq=999999] /到期提醒' },
        { ...event(), message: '[CQ:at,qq=456789] /到期提醒更多' },
        { ...event(), message: '[CQ:at,qq=456789][CQ:image,file=x] /到期提醒' },
        { ...event(), post_type: 'notice' },
    ]) assert.equal(await state.handler.handle(invalid), false);
    assert.equal(state.actions.length, 0);
    assert.equal(await setup({ config: { enabled: false } }).handler.handle(event()), false);
    assert.equal(await state.handler.handle({ ...event(), message: '[CQ:reply,id=1][CQ:at,qq=456789] /到期提醒' }), true);
    assert.match(text(state), /默认关闭/); assert.match(text(state), /每小时/); assert.match(text(state), /48 小时/);
    assert.equal(state.changes.length, 0); state.handler.dispose();
});

test('current owner/admin lookup is required and member, malformed or failed results cannot mutate settings', async () => {
    for (const role of [
        { role: 'member' }, {}, { data: { role: 'admin' }, status: 'failed' },
        { data: { role: 'admin' }, retcode: 1 }, { data: { role: 'admin' }, status: 'async' }, { data: null },
        { role: 'owner', user_id: '999999' }, { role: 'admin', group_id: '999999' },
    ]) {
        const state = setup({ role });
        await state.handler.handle({ ...event('开启 2'), sender: { role: 'owner' } } as MessageEvent);
        assert.equal(state.changes.length, 0); assert.match(text(state), /未能确认权限/); state.handler.dispose();
    }
    const failed = setup(); failed.setRoleCall(async () => { throw new Error('lookup failed'); });
    await failed.handler.handle(event('开启 2')); assert.equal(failed.changes.length, 0); failed.handler.dispose();
    for (const role of [{ role: 'owner' }, { status: 'ok', retcode: 0, data: { role: 'admin' } }]) {
        const state = setup({ role }); await state.handler.handle(event('开启 2'));
        assert.deepEqual(state.changes[0], { group: '123456', enabled: true, channelIds: [channel(2).id] }); state.handler.dispose();
    }
});

test('selected channels accept short/full IDs and exact names; every selection must resolve uniquely', async () => {
    const valid = setup();
    await valid.handler.handle(event('开启 2，gid://axonhub/Channel/15,Channel 2'));
    assert.deepEqual(valid.changes[0].channelIds, [channel(2).id, channel(15).id]);
    assert.match(text(valid), /已开启/); valid.handler.dispose();
    for (const request of ['开启 2,999', '开启 Channel', '开启 2,,15', '开启 duplicate', '开启 ' + Array(101).fill('2').join(',')]) {
        const invalid = setup({ channels: [channel(2), channel(15), channel(3, 'duplicate'), channel(4, 'duplicate')] });
        await invalid.handler.handle(event(request)); assert.equal(invalid.changes.length, 0); invalid.handler.dispose();
    }
});

test('status/help/close avoid catalog queries, default off, close retains selection, reopen validates it', async () => {
    const state = setup(); let catalogCalls = 0;
    state.setCatalog(async () => { catalogCalls++; return [channel(2)]; });
    await state.handler.handle(event('状态')); assert.match(text(state), /已关闭/); assert.equal(catalogCalls, 0);
    await state.handler.handle(event('开启', '345679')); assert.equal(state.changes.length, 0); assert.equal(catalogCalls, 0);
    state.groups.set('123456', { enabled: true, channelIds: [channel(2).id] });
    await state.handler.handle(event('关闭', '345680')); assert.deepEqual(state.groups.get('123456'), { enabled: false, channelIds: [channel(2).id] });
    assert.equal(catalogCalls, 0);
    await state.handler.handle(event('开启', '345681')); assert.equal(state.groups.get('123456')!.enabled, true); assert.equal(catalogCalls, 1);
    state.setCatalog(async () => []); const count = state.changes.length;
    await state.handler.handle(event('开启', '345682')); assert.equal(state.changes.length, count); state.handler.dispose();
});

test('channel list uses safe text segments and chunks long messages at 1800 characters', async () => {
    const state = setup({ channels: Array.from({ length: 40 }, (_, i) => channel(i + 1, '[CQ:image,file=x]\n' + '长'.repeat(190))) });
    await state.handler.handle(event('渠道'));
    assert.ok(state.sent.length > 1);
    for (const message of state.sent) { assert.equal(message.message[0].type, 'text'); assert.ok(message.message[0].data.text.length <= 1800); }
    assert.match(text(state), /1：\[CQ:image/); state.handler.dispose();
});

test('cooldown is per group and sender, and competing commands serialize state changes', async () => {
    const state = setup(); let resolve!: (value: unknown) => void, lookups = 0;
    state.setRoleCall(async () => { lookups++; return lookups === 1 ? new Promise(done => { resolve = done; }) : { role: 'admin' }; });
    const first = state.handler.handle(event('开启 2'));
    const repeated = state.handler.handle(event('关闭'));
    const second = state.handler.handle(event('关闭', '345679'));
    await Promise.resolve(); await Promise.resolve(); assert.equal(lookups, 1); assert.equal(state.changes.length, 0);
    resolve({ role: 'admin' }); await Promise.all([first, repeated, second]);
    assert.deepEqual(state.changes.map(change => change.enabled), [true, false]);
    assert.equal(lookups, 2); state.handler.dispose();
});

test('unload suppresses mutations and sends after an asynchronous role or catalog request', async () => {
    for (const phase of ['role', 'catalog']) {
        const state = setup(); let resolve!: (value: any) => void;
        const pending = new Promise<any>(done => { resolve = done; });
        if (phase === 'role') state.setRoleCall(() => pending); else state.setCatalog(() => pending);
        const command = state.handler.handle(event('开启 2'));
        await Promise.resolve(); await Promise.resolve(); await Promise.resolve(); await Promise.resolve();
        state.handler.dispose(); resolve(phase === 'role' ? { role: 'admin' } : [channel(2)]);
        await command; assert.equal(state.changes.length, 0); assert.equal(state.sent.length, 0);
        assert.equal(await state.handler.handle(event('开启 2')), false);
    }
});

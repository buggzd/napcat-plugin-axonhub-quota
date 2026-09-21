import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AxonHubClient } from '../src/client.ts';
import { PersonalClient, siteDay } from '../src/personal.ts';
import { BindingStore } from '../src/bindings.ts';
import { DEFAULT_CONFIG, updateConfig } from '../src/config.ts';
import { MessageHandler, filterQuota } from '../src/messages.ts';
import { usageLines, usageCard } from '../src/usage-card.ts';
import { ImageRenderer } from '../src/images.ts';
import type { Context, UsageSummary } from '../src/types.ts';
const uid = (n: number) => `gid://axonhub/User/${n}`;
const user = (id: string) => ({ id, firstName: 'User', lastName: id.split('/').pop(), status: 'activated' });
const overview = { totalTokens: 1234, totalInputTokens: 1000, totalCachedInputTokens: 900, totalOutputTokens: 234, totalCost: 1.25, totalRequests: 8 };
function mockClient(run: (q: string, v: any) => any) { return { graphql: async (q: string, v: any = {}) => run(q, v) } as unknown as AxonHubClient; }

test('personal cache is isolated by identity and day; concurrent requests coalesce and never omit user filter', async () => {
    let now = Date.parse('2026-09-20T15:59:59Z'), queries = 0;
    const client = new PersonalClient(mockClient((q, v) => {
        if (q.includes('systemGeneralSettings')) return { systemGeneralSettings: { timezone: 'Asia/Singapore', currencyCode: 'USD' } };
        if (q.includes('on User')) return { node: user(v.id) };
        queries++; assert.equal(v.filter.startTime, v.filter.endTime); assert.match(v.filter.startTime, /^\d{4}-\d{2}-\d{2}$/);
        assert.equal(v.filter.userIDs.length, 1); assert.ok(v.filter.userIDs[0]); assert.equal(v.filter.channelIDs, undefined);
        return { analyticsOverview: { ...overview, totalRequests: v.filter.userIDs[0] === uid(1) ? 8 : 9 } };
    }), () => now);
    const binding = { userId: uid(1), name: 'one' };
    const [a, b] = await Promise.all([client.today(binding), client.today(binding)]);
    assert.equal(a, b); assert.equal(queries, 1); assert.equal(a.day, '2026-09-20');
    assert.equal((await client.today({ userId: uid(2), name: 'two' })).totalRequests, 9);
    assert.equal(queries, 2); assert.equal((await client.today(binding)).totalRequests, 8);
    now += 2000; assert.equal((await client.today(binding)).day, '2026-09-21'); assert.equal(queries, 3);
    assert.equal(siteDay(now, 'UTC'), '2026-09-20');
    await assert.rejects(client.today({ userId: '', name: '' }));
    const lines = usageLines(a).join('\n'); assert.match(lines, /总 Tokens：1,234/); assert.match(lines, /其中缓存输入：900/);
    client.dispose(); await assert.rejects(client.today(binding));
});

test('API key exact match selects no secrets and rejects invalid, service, disabled and ambiguous keys', async () => {
    const key = 'sk-test-secret-123456789'; let nodes: any[] = [{ id: 'gid://axonhub/APIKey/1', status: 'enabled', type: 'user', user: user(uid(1)) }];
    const client = new PersonalClient(mockClient((q, v) => {
        assert.equal(v.key, key); assert.match(q, /where: \{key: \$key/);
        assert.ok(!q.includes('node {key')); return { apiKeys: { edges: nodes.map(node => ({ node })), pageInfo: { hasNextPage: false } } };
    }));
    const binding = await client.bindKey(key); assert.equal(binding.userId, uid(1)); assert.equal(binding.keyId, 'gid://axonhub/APIKey/1'); assert.ok(!JSON.stringify(binding).includes(key));
    nodes[0].type = 'service_account'; await assert.rejects(client.bindKey(key));
    nodes[0].type = 'user'; nodes[0].status = 'disabled'; await assert.rejects(client.bindKey(key));
    nodes = []; await assert.rejects(client.bindKey(key)); await assert.rejects(client.bindKey('short'));
    nodes = [{}, {}]; await assert.rejects(client.bindKey(key));
});

test('disabled or moved binding key blocks usage; missing numbers remain unknown', async () => {
    let valid = false, calls = 0;
    const client = new PersonalClient(mockClient((q, v) => {
        if (q.includes('systemGeneralSettings')) return { systemGeneralSettings: { timezone: 'Asia/Shanghai', currencyCode: 'USD' } };
        if (q.includes('on User')) return { node: user(v.id) };
        if (q.includes('on APIKey')) return { node: {id: v.id, status: valid ? 'enabled' : 'disabled', type: 'personal', userID: uid(1)} };
        calls++; return { analyticsOverview: {totalRequests:0} };
    }));
    const binding = { userId:uid(1),name:'one',keyId:'gid://axonhub/APIKey/1' };
    await assert.rejects(client.today(binding)); assert.equal(calls, 0);
    valid = true; const result = await client.today(binding); assert.equal(result.totalCost, null); assert.equal(result.totalRequests, 0);
});

test('bindings persist private identity metadata; usernames are pending, removal and site switch revoke', () => {
    const dir = mkdtempSync(join(tmpdir(), 'axon-binding-')), file = join(dir, 'bindings.json');
    try {
        const store = new BindingStore(file, 'https://a.test');
        store.request('123456', 'Someone', 1); assert.equal(store.get('123456'), undefined);
        assert.equal(store.list().requests.length, 1);
        store.bind('123456', { userId: uid(1), name: 'One' });
        assert.equal(store.list().requests.length, 0); assert.equal(statSync(file).mode & 0o777, 0o600);
        assert.equal(new BindingStore(file, 'https://a.test').get('123456')?.userId, uid(1));
        assert.equal(new BindingStore(file, 'https://b.test').get('123456'), undefined);
        assert.throws(() => store.request('123456', 'sk-secret', 2));
        store.remove('123456'); assert.equal(store.get('123456'), undefined);
        store.bind('123456', { userId: uid(1), name: 'One' }); store.clearForSite('https://b.test');
        assert.equal(store.get('123456'), undefined); assert.ok(!readFileSync(file, 'utf8').includes(uid(1)));
    } finally { rmSync(dir, {recursive: true, force: true}); }
});

test('selected channels preserve identity cache; zero or stale selection never means all', () => {
    const a = { id:'gid://axonhub/Channel/1',name:'same',state:'ok' as const,windows:[] }, b = {...a,id:'gid://axonhub/Channel/2'};
    const snapshot = {readAt:1,channels:[a,b]};
    const config = updateConfig(DEFAULT_CONFIG, {channelMode:'selected',channelIds:[b.id]});
    assert.deepEqual(filterQuota(snapshot,config).channels,[b]); assert.equal(filterQuota(snapshot,config),filterQuota(snapshot,config));
    assert.equal(filterQuota(snapshot,{...config,channelIds:[]}).channels.length,0);
    assert.equal(filterQuota(snapshot,{...config,channelIds:['gone']}).channels.length,0);
    assert.equal(filterQuota(snapshot,DEFAULT_CONFIG),snapshot);
});

test('private binding bypasses quota whitelist only for personal commands; group cannot bind; usage is sender scoped', async () => {
    const dir = mkdtempSync(join(tmpdir(),'axon-msg-')); const sent: any[] = []; const lookedUp: string[] = [];
    const store = new BindingStore(join(dir,'bindings.json'),'https://test');
    const context = { actions:{async call(_a:string,p:any){sent.push(p);}}, logger:{warn(){},info(){}},pluginManager:{config:{}},adapterName:'test' } as unknown as Context;
    let now = 1000;
    const usage = {userId:uid(1),name:'one',day:'2026-09-21',timezone:'Asia/Shanghai',currency:'USD',readAt:1,...overview};
    const personal = {async bindKey(){return {userId:uid(1),name:'one'};},async today(binding:any){lookedUp.push(binding.userId);return usage;}} as unknown as PersonalClient;
    const handler = new MessageHandler(context,{...DEFAULT_CONFIG,allowedGroups:'999999'},{} as AxonHubClient,()=>now,undefined,{store,client:personal,render:async()=>[]});
    const event = {post_type:'message',message_type:'private',user_id:'123456',self_id:'888888',message:'/用量'};
    const send = async (message:string,extra = {}) => {now+=31000;await handler.handle({...event,message,...extra});};
    try {
        await send('/用量'); assert.equal(lookedUp.length,0); assert.match(sent.at(-1).message[0].data.text,/尚未绑定/);
        await send('/额度'); assert.equal(sent.length,1);
        await send('/绑定账号 Admin'); assert.equal(store.get('123456'),undefined); assert.equal(store.list().requests.length,1);
        await send('/绑定APIKEY sk-my-secret-123456789'); assert.equal(store.get('123456')?.userId,uid(1));
        await send('/用量'); assert.deepEqual(lookedUp,[uid(1)]); assert.ok(!JSON.stringify(sent).includes('sk-my-secret'));
        await send('/用量 '+uid(2)); assert.equal(lookedUp.length,1);
        await send('/用量',{user_id:'234567'}); assert.equal(lookedUp.length,1);
        await send('[CQ:at,qq=888888] /绑定APIKEY sk-other',{message_type:'group',group_id:'999999'}); assert.equal(lookedUp.length,1);
        await send('[CQ:at,qq=888888] /用量',{message_type:'group',group_id:'999999'}); assert.equal(lookedUp.length,2);
        await send('/解绑'); assert.equal(store.get('123456'),undefined);
    } finally {handler.dispose();rmSync(dir,{recursive:true,force:true});}
});

test('usage image uses existing worker, escapes names and renders real PNG', async () => {
    const usage: UsageSummary = {userId:uid(1),name:'<script>&',day:'2026-09-21',timezone:'Asia/Shanghai',currency:'USD',readAt:1,...overview};
    assert.ok(usageCard(usage)[0].includes('&lt;script&gt;&amp;'));
    const renderer = new ImageRenderer(new URL('../dist/render-worker.mjs',import.meta.url));
    try {const [png] = await renderer.render(usage);assert.equal(Buffer.from(png,'base64').subarray(1,4).toString(),'PNG');} finally {renderer.dispose();}
});

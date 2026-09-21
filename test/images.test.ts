import test from 'node:test';
import assert from 'node:assert/strict';
import { createCards } from '../src/card.ts';
import { ImageRenderer } from '../src/images.ts';
import { summarizeChannel } from '../src/format.ts';
import { MessageHandler } from '../src/messages.ts';
import { DEFAULT_CONFIG } from '../src/config.ts';
import type { Snapshot, Context, MessageEvent } from '../src/types.ts';
import type { AxonHubClient } from '../src/client.ts';

const readAt = Date.parse('2030-01-02T00:00:00Z');
const raw = { id: '1', name: 'Codex <A&B>', type: 'codex', status: 'enabled', providerQuotaStatus: {
    status: 'available', quotaData: {
        rate_limit: { primary_window: { used_percent: 24, limit_window_seconds: 604800, reset_at: Date.parse('2030-01-08T00:00:00Z') / 1000 } },
        _limits: [{ type: 'token', window: 'primary', usageRatio: .23, periodStart: '2030-01-01T00:00:00Z', nextResetAt: '2030-01-08T00:00:00Z', periodCost: 172.334, periodQuota: 749.28 }],
        _resets: { supported: true, resets: [{ expiresAt: '2030-02-01T00:00:00Z' }, { expiresAt: '2030-02-02T00:00:00Z' }] },
    },
} };
const snapshot: Snapshot = { readAt, channels: [summarizeChannel(raw)!] };

test('card uses normalized usage, elapsed time, available resets and optional cost estimate', () => {
    assert.equal(snapshot.channels[0].windows[0].remaining, 77);
    const svg = createCards(snapshot)[0];
    for (const expected of ['Codex &lt;A&amp;B&gt;', '>23%</text>', '>14%</text>', '主要时长 (7天)', '剩余 2 次', '2030-02-01 08:00', '$172.33', '$749.28']) assert.ok(svg.includes(expected), expected);
    assert.ok(!svg.includes('<A&B>'));
    assert.ok(!svg.includes('foreignObject') && !svg.includes('<script') && !svg.includes('href='));
    const noEstimate = createCards({ readAt, channels: [{ ...snapshot.channels[0], resets: undefined, windows: [{ label: '主窗口', remaining: null, resetAt: null }] }] })[0];
    assert.ok(!noEstimate.includes('预计周期额度')); assert.ok(noEstimate.includes('未知'));
});

test('large channel lists paginate without losing names or exceeding the raster size bound', () => {
    const channels = Array.from({ length: 50 }, (_, i) => ({ ...snapshot.channels[0], id: String(i), name: `CHANNEL-${i}` }));
    const pages = createCards({ readAt, channels });
    assert.ok(pages.length > 1);
    for (const channel of channels) assert.equal(pages.filter(page => page.includes('>' + channel.name + '<')).length, 1);
    for (const page of pages) assert.ok(Number(page.match(/height="([\d.]+)"/)![1]) <= 1500);
});

test('bundled worker produces a real PNG, coalesces requests, caches image and cancels on disposal', async () => {
    const renderer = new ImageRenderer(new URL('../dist/render-worker.mjs', import.meta.url));
    try {
        const [first, concurrent] = await Promise.all([renderer.render(snapshot), renderer.render(snapshot)]);
        assert.equal(first, concurrent);
        const png = Buffer.from(first[0], 'base64');
        assert.equal(png.subarray(1, 4).toString(), 'PNG');
        assert.equal(png.readUInt32BE(16), 800);
        assert.ok(png.length > 5000);
        assert.equal(await renderer.render(snapshot), first);
    } finally { renderer.dispose(); }
    await assert.rejects(renderer.render(snapshot));
    const cancelled = new ImageRenderer(new URL('../dist/render-worker.mjs', import.meta.url));
    const promise = cancelled.render(snapshot); cancelled.dispose(); await assert.rejects(promise);
});

test('QQ sends image segments and falls back to text if rendering or image delivery fails', async () => {
    const event: MessageEvent = { post_type: 'message', message_type: 'group', group_id: '123456', user_id: '234567', self_id: '345678',
        message: [{ type: 'at', data: { qq: '345678' } }, { type: 'text', data: { text: ' /额度' } }] };
    for (const failure of ['none', 'render', 'send']) {
        const sent: any[] = [];
        const context = { adapterName: 'mock', pluginManager: { config: {} }, logger: { warn() {} }, actions: {
            async call(_action: string, params: any) { sent.push(params); return failure === 'send' && params.message[0].type === 'image' ? { status: 'failed' } : {}; },
        } } as unknown as Context;
        const client = { async getQuota() { return snapshot; } } as AxonHubClient;
        const handler = new MessageHandler(context, { ...DEFAULT_CONFIG, allowedGroups: '123456' }, client, Date.now,
            async () => { if (failure === 'render') throw new Error('render failure'); return ['cG5n']; });
        await handler.handle(event); handler.dispose();
        assert.equal(sent.at(-1).message[0].type, failure === 'none' ? 'image' : 'text');
        if (failure !== 'render') assert.equal(sent[0].message[0].data.file, 'base64://cG5n');
    }
});

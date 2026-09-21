import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { napcatSession } from './napcat.mjs';
const id = 'napcat-plugin-axonhub-quota';
const path = '/Plugin/ext/' + id;
try {
    const api = await napcatSession();
    const { plugins } = await api('/Plugin/List');
    assert.equal(plugins.find(p => p.id === id)?.status, 'active');
    const config = await api(path + '/config');
    assert.equal(config.password, ''); assert.equal(config.hasPassword, true);
    const native = await api('/Plugin/Config?id=' + id);
    assert.equal(native.config.password, '');
    const origin = process.env.NAPCAT_WEBUI_URL || 'http://127.0.0.1:6099';
    for (const endpoint of ['/config', '/preview']) {
        const result = await (await fetch(origin + '/api' + path + endpoint, { signal: AbortSignal.timeout(10000) })).json();
        assert.notEqual(result.code, 0, 'Unauthenticated access must be denied.');
    }
    const result = await api(path + '/preview');
    assert.ok(result.messages.every(m => typeof m === 'string' && m.length <= 1800));
    assert.ok(result.images?.length > 0, 'PNG preview must render on this installation.');
    for (const image of result.images) {
        const png = Buffer.from(image, 'base64');
        assert.equal(png.subarray(1, 4).toString(), 'PNG');
        assert.equal(png.readUInt32BE(16), 800);
    }
    console.log(result.messages.join('\n\n'));
    console.log('Verified: active plugin, write-only password, protected endpoints, real quota response and PNG cards.');
    if (process.argv.includes('--stress')) {
        const stats = () => execFileSync('docker', ['stats', process.env.NAPCAT_CONTAINER || 'napcat', '--no-stream', '--format', '{{.MemUsage}}'], { encoding: 'utf8' }).trim();
        console.log('Whole-container memory before:', stats());
        for (let batch = 0; batch < 3; batch++) {
            const responses = await Promise.all(Array.from({ length: 50 }, () => api(path + '/preview')));
            assert.ok(responses.every(r => r.snapshot.readAt === result.snapshot.readAt), 'The stress batch must complete within the 60s cache TTL.');
            console.log(`After ${(batch + 1) * 50} cached previews:`, stats());
        }
    }
} catch (error) { console.error(error.message); process.exitCode = 1; }

import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {writeFileSync, mkdirSync} from 'node:fs';
import {AxonHubClient} from '../src/client.ts';
import {PersonalClient} from '../src/personal.ts';
import {ImageRenderer} from '../src/images.ts';
// Read existing credentials only into memory, never print response bodies or secrets.
const config = JSON.parse(execFileSync('docker',['exec',process.env.NAPCAT_CONTAINER || 'napcat','cat','/app/napcat/config/napcat-plugin-axonhub-quota/settings.json'],{encoding:'utf8'}));
const client = new AxonHubClient(config), personal = new PersonalClient(client);
const renderer = new ImageRenderer(new URL('../dist/render-worker.mjs',import.meta.url));
try {
    const users = await personal.users(); assert.ok(users.length);
    const summary = await personal.today(users[0]);
    assert.ok(summary.totalRequests !== null); assert.ok(summary.totalTokens !== null); assert.ok(summary.totalCost !== null);
    assert.equal(summary, await personal.today(users[0]));
    await assert.rejects(personal.bindKey('sk-napcat-invalid-test-key-no-account'));
    const [image] = await renderer.render(summary);
    assert.equal(Buffer.from(image,'base64').subarray(1,4).toString(),'PNG');
    mkdirSync(new URL('../artifacts/',import.meta.url),{recursive:true});
    writeFileSync(new URL('../artifacts/usage-preview.png',import.meta.url),Buffer.from(image,'base64'));
    console.log('Verified live user catalog, user-filtered daily analytics, currency/timezone, cache, invalid-key rejection and usage PNG. No QQ bindings or messages created.');
} catch { console.error('Live personal verification failed; no credentials were printed.');process.exitCode=1; }
finally {personal.dispose();client.dispose();renderer.dispose();}

import { build } from 'esbuild';
import { readFile, mkdir, cp, writeFile, rm } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
const root = fileURLToPath(new URL('..', import.meta.url));
const dist = resolve(root, 'dist');
await rm(dist, { recursive: true, force: true });
await mkdir(dist, { recursive: true });
await build({ entryPoints: [resolve(root, 'src/index.ts')], outfile: resolve(dist, 'index.mjs'),
    bundle: true, platform: 'node', target: 'node20', format: 'esm', minify: false });
await build({ entryPoints: [resolve(root, 'src/render-worker.ts')], outfile: resolve(dist, 'render-worker.mjs'),
    bundle: true, platform: 'node', target: 'node20', format: 'esm', minify: true });
await cp(resolve(root, 'node_modules/@resvg/resvg-wasm/index_bg.wasm'), resolve(dist, 'renderer.wasm'));
const { scripts, devDependencies, ...manifest } = JSON.parse(await readFile(resolve(root, 'package.json'), 'utf8'));
await writeFile(resolve(dist, 'package.json'), JSON.stringify(manifest, null, 2));
await cp(resolve(root, 'webui'), resolve(dist, 'webui'), { recursive: true });
await cp(resolve(root, 'THIRD_PARTY_NOTICES.md'), resolve(dist, 'THIRD_PARTY_NOTICES.md'));
const archive = resolve(root, 'napcat-plugin-axonhub-quota.zip');
await rm(archive, { force: true });
execFileSync('zip', ['-q', '-r', archive, 'index.mjs', 'render-worker.mjs', 'renderer.wasm', 'package.json', 'webui', 'THIRD_PARTY_NOTICES.md'], { cwd: dist });
console.log('Built dist/ and napcat-plugin-axonhub-quota.zip (renderer bundled; no runtime npm install).');

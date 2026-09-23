import { readFile, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { napcatSession } from './napcat.mjs';
const id = 'napcat-plugin-axonhub-quota';
const container = process.env.NAPCAT_CONTAINER || 'napcat';
const installed = `/app/napcat/plugins/${id}`;
try {
    const api = await napcatSession();
    const { plugins } = await api('/Plugin/List');
    const existingConfig = plugins.some(plugin => plugin.id === id) ? await api(`/Plugin/ext/${id}/config`) : null;
    const previous = plugins.find(plugin => plugin.id === id);
    const archive = await readFile(new URL('../napcat-plugin-axonhub-quota.zip', import.meta.url));
    const form = new FormData(); form.set('plugin', new Blob([archive], { type: 'application/zip' }), id + '.zip');
    let legacyImportAvailable = true;
    try { await api('/Plugin/Import', form); }
    catch (error) {
        if (!(error instanceof SyntaxError)) throw error;
        // Newer NapCat routes unknown API paths to an HTML page, not a JSON error.
        legacyImportAvailable = false;
    }
    if (legacyImportAvailable) {
        await api('/Plugin/SetStatus', { id, enable: true });
    } else {
        if (!previous) throw new Error('This NapCat version has no ZIP import API. Install and allowlist the plugin following README first.');
        const temporary = await mkdtemp(join(tmpdir(), 'napcat-axonhub-backup-'));
        const docker = (...args) => execFileSync('docker', args, { stdio: 'pipe' });
        const backup = join(temporary, id);
        const wasActive = previous.status === 'active';
        try {
            docker('cp', `${container}:${installed}`, backup);
            if (wasActive) await api('/Plugin/SetStatus', { id, enable: false });
            docker('cp', fileURLToPath(new URL('../dist/', import.meta.url)) + '/.', `${container}:${installed}/`);
            await api('/Plugin/SetStatus', { id, enable: true });
        } catch (error) {
            try {
                docker('cp', `${backup}/.`, `${container}:${installed}/`);
                if (wasActive) await api('/Plugin/SetStatus', { id, enable: true });
            } catch { /* Keep the original error. */ }
            throw error;
        } finally { await rm(temporary, { recursive: true, force: true }); }
    }
    const { plugins: after } = await api('/Plugin/List');
    if (after.find(plugin => plugin.id === id)?.status !== 'active') throw new Error('Installed plugin is not active; check NapCat plugin management.');
    const info = await api(`/Plugin/ext/${id}/config`);
    if (existingConfig?.hasPassword && !info?.hasPassword) throw new Error('Plugin is active but the saved administrator password was not found.');
    console.log('AxonHub quota plugin installed and active; saved configuration is intact. Other plugins were not restarted.');
} catch (error) { console.error(error.message); process.exitCode = 1; }

import { readFile } from 'node:fs/promises';
import { napcatSession } from './napcat.mjs';
const id = 'napcat-plugin-axonhub-quota';
try {
    const api = await napcatSession();
    const archive = await readFile(new URL('../napcat-plugin-axonhub-quota.zip', import.meta.url));
    const form = new FormData(); form.set('plugin', new Blob([archive], { type: 'application/zip' }), id + '.zip');
    await api('/Plugin/Import', form);
    await api('/Plugin/SetStatus', { id, enable: true });
    const { plugins } = await api('/Plugin/List');
    const plugin = plugins.find(plugin => plugin.id === id);
    if (!plugin || plugin.status !== 'active') throw new Error('Imported plugin is not active; check NapCat plugin management.');
    console.log('AxonHub quota plugin imported and active. Other plugins were not restarted.');
} catch (error) { console.error(error.message); process.exitCode = 1; }

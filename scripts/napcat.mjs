import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
export async function napcatSession() {
    const container = process.env.NAPCAT_CONTAINER || 'napcat';
    const base = process.env.NAPCAT_WEBUI_URL || 'http://127.0.0.1:6099';
    // Read the local container's existing token in memory; never print or store it.
    const settings = JSON.parse(execFileSync('docker', ['exec', container, 'cat', '/app/napcat/config/webui.json'], { encoding: 'utf8' }));
    const hash = createHash('sha256').update(settings.token + '.napcat').digest('hex');
    const login = await (await fetch(base + '/api/auth/login', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ hash }), signal: AbortSignal.timeout(10000),
    })).json();
    const credential = login.data?.Credential;
    if (login.code !== 0 || !credential) throw new Error('NapCat WebUI login failed.');
    return async (path, body) => {
        const form = body instanceof FormData;
        const response = await fetch(base + '/api' + path, {
            method: body === undefined ? 'GET' : 'POST',
            headers: { Authorization: `Bearer ${credential}`, ...(form ? {} : { 'Content-Type': 'application/json' }) },
            body: body === undefined ? undefined : form ? body : JSON.stringify(body), signal: AbortSignal.timeout(120000),
        });
        const result = await response.json();
        if (!response.ok || result.code !== 0) {
            const error = new Error('NapCat operation failed: ' + path);
            // Allow callers to inspect a plugin's own sanitized error without logging credentials.
            error.result = result;
            throw error;
        }
        return result.data;
    };
}

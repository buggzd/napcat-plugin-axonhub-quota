import { mkdirSync, readFileSync, writeFileSync, renameSync, chmodSync, existsSync, rmSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import type { Config } from './types.ts';
import { record } from './types.ts';

export const PLUGIN_ID = 'napcat-plugin-axonhub-quota';
export const DEFAULT_CONFIG: Config = {
    enabled: true, baseUrl: 'https://axonhub.example.com', email: '', password: '',
    allowedGroups: '', allowedUsers: '', channelMode: 'all', channelIds: [], privateBinding: true,
};

export function normalizeIds(value: unknown): string {
    if (typeof value !== 'string' || value.length > 16000) throw new Error('白名单必须是 QQ 号或群号列表。');
    const ids = value.trim().split(/[\s,，;；]+/u).filter(Boolean);
    if (ids.some(id => !/^[1-9]\d{4,19}$/.test(id))) throw new Error('白名单只接受数字 QQ 号或群号，以逗号或空格分隔。');
    return [...new Set(ids)].join(',');
}

export function updateConfig(previous: Config, input: unknown): Config {
    const raw = record(input);
    if (Object.keys(raw).length === 0) throw new Error('配置不能为空。');
    const next = { ...previous };
    if ('enabled' in raw) {
        if (typeof raw.enabled !== 'boolean') throw new Error('启用状态无效。');
        next.enabled = raw.enabled;
    }
    for (const key of ['email', 'baseUrl', 'password'] as const) {
        if (!(key in raw)) continue;
        if (typeof raw[key] !== 'string' || raw[key].length > 2048) throw new Error('账号配置格式无效。');
        // A blank write-only password keeps the saved value. Clearing is explicit.
        if (key === 'password') { if (raw[key] !== '') next[key] = raw[key]; }
        else next[key] = raw[key].trim();
    }
    if (raw.clearPassword === true) next.password = '';
    for (const key of ['allowedGroups', 'allowedUsers'] as const) {
        if (key in raw) next[key] = normalizeIds(raw[key]);
    }
    if ('privateBinding' in raw) {
        if (typeof raw.privateBinding !== 'boolean') throw new Error('私聊绑定设置无效。');
        next.privateBinding = raw.privateBinding;
    }
    if ('channelMode' in raw) {
        if (!['all', 'selected'].includes(String(raw.channelMode))) throw new Error('渠道筛选模式无效。');
        next.channelMode = raw.channelMode as Config['channelMode'];
    }
    if ('channelIds' in raw) {
        if (!Array.isArray(raw.channelIds) || raw.channelIds.length > 5000 || raw.channelIds.some(id => typeof id !== 'string' || !/^gid:\/\/axonhub\/Channel\/\d+$/.test(id))) throw new Error('渠道选择无效。');
        next.channelIds = [...new Set(raw.channelIds as string[])];
    }
    let url: URL;
    try { url = new URL(next.baseUrl); } catch { throw new Error('AxonHub 地址无效。'); }
    const localHttp = url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]', 'host.docker.internal'].includes(url.hostname);
    if ((!localHttp && url.protocol !== 'https:') || url.username || url.password || url.search || url.hash) {
        throw new Error('请使用 HTTPS 地址（本机地址可使用 HTTP），不要在地址中填写账号、参数或片段。');
    }
    next.baseUrl = url.toString().replace(/\/+$/, '');
    if (next.email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(next.email)) throw new Error('管理员邮箱格式无效。');
    return next;
}

export function publicConfig(config: Config) {
    return { ...config, password: '', hasPassword: config.password !== '' };
}

export function configFile(napcatConfigPath: string): string {
    const root = process.env.AXONHUB_QUOTA_CONFIG_DIR || (
        existsSync('/app/napcat/config') ? join('/app/napcat/config', PLUGIN_ID)
            : join(dirname(napcatConfigPath), PLUGIN_ID)
    );
    return join(resolve(root), 'settings.json');
}

export function loadConfig(file: string): Config {
    if (!existsSync(file)) return { ...DEFAULT_CONFIG };
    try {
        const config = updateConfig(DEFAULT_CONFIG, JSON.parse(readFileSync(file, 'utf8')));
        chmodSync(file, 0o600);
        return config;
    } catch { throw new Error('无法读取插件配置，请检查专属配置目录；原文件未覆盖。'); }
}

export function saveConfig(file: string, config: unknown): void {
    const temporary = `${file}.tmp`;
    try {
        mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
        chmodSync(dirname(file), 0o700);
        writeFileSync(temporary, JSON.stringify(config, null, 2), { mode: 0o600, flag: 'w' });
        chmodSync(temporary, 0o600);
        renameSync(temporary, file);
    } catch {
        rmSync(temporary, { force: true });
        throw new Error('无法保存插件配置，请检查专属配置目录权限。');
    }
}

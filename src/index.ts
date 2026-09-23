import { AxonHubClient, safeError } from './client.ts';
import { configFile, loadConfig, PLUGIN_ID, publicConfig, saveConfig, updateConfig } from './config.ts';
import { formatSnapshot } from './format.ts';
import { MessageHandler, filterQuota } from './messages.ts';
import { ImageRenderer } from './images.ts';
import { record, type Config, type Context, type MessageEvent } from './types.ts';
import { BindingStore } from './bindings.ts';
import { PersonalClient } from './personal.ts';
import { join, dirname } from 'node:path';

export const plugin_config_ui = [
    { key: '_guide', type: 'text', label: '', default: '账号和密码请在插件扩展页「AxonHub 额度设置」配置；密码保存后不回传。' },
    { key: 'enabled', type: 'boolean', label: '启用插件', default: true },
    { key: 'baseUrl', type: 'string', label: 'AxonHub 地址', default: 'https://axonhub.example.com' },
    { key: 'email', type: 'string', label: '管理员邮箱', default: '' },
    { key: 'allowedGroups', type: 'string', label: '允许查询的群号', default: '', description: '逗号或空格分隔；群内必须 @机器人 /额度；空名单关闭群查询。' },
    { key: 'allowedUsers', type: 'string', label: '允许私聊的 QQ 号', default: '', description: '逗号或空格分隔；私聊发送 /额度；空名单关闭私聊查询。' },
];

class Runtime {
    config: Config;
    client: AxonHubClient;
    handler: MessageHandler;
    images: ImageRenderer;
    personal: PersonalClient;
    bindings: BindingStore;
    file: string;
    context: Context;
    closed = false;
    constructor(context: Context) {
        this.context = context; this.file = configFile(context.configPath);
        this.config = loadConfig(this.file);
        this.client = this.makeClient(this.config);
        this.images = new ImageRenderer();
        this.bindings = new BindingStore(join(dirname(this.file), 'bindings.json'), this.config.baseUrl);
        this.personal = new PersonalClient(this.client);
        this.handler = this.makeHandler();
    }
    private makeClient(config: Config) {
        return new AxonHubClient(config, { onRequestFailure: (phase, code, elapsedMs) => {
            this.context.logger.warn(`AxonHub ${phase} 请求失败：${code}（${elapsedMs} ms）。`);
        } });
    }
    private makeHandler() {
        return new MessageHandler(this.context, this.config, this.client, Date.now, snapshot => this.images.render(snapshot),
            { store: this.bindings, client: this.personal, render: summary => this.images.render(summary) });
    }
    configure(input: unknown): void {
        if (this.closed) throw new Error('插件已卸载。');
        const next = updateConfig(this.config, input);
        if (next.baseUrl !== this.config.baseUrl) {
            next.channelMode = 'selected'; next.channelIds = [];
            this.bindings.clearForSite(next.baseUrl);
        }
        saveConfig(this.file, next);
        this.handler.dispose(); this.personal.dispose(); this.client.dispose(); this.images.dispose();
        this.config = next;
        this.client = this.makeClient(next);
        this.images = new ImageRenderer();
        this.personal = new PersonalClient(this.client);
        this.handler = this.makeHandler();
    }
    dispose(): void {
        this.closed = true; this.handler.dispose(); this.personal.dispose(); this.client.dispose(); this.images.dispose(); this.config.password = '';
    }
}
let runtime: Runtime | undefined;

export async function plugin_init(context: Context): Promise<void> {
    runtime?.dispose();
    const current = new Runtime(context); runtime = current;
    context.router.page({ path: 'settings', title: 'AxonHub 额度设置', htmlFile: 'webui/index.html', description: '账号配置与额度预览' });
    // These routes are behind NapCat WebUI authentication. Never register NoAuth routes.
    context.router.get('/config', (_req, res) => res.json({ code: 0, data: publicConfig(current.config) }));
    context.router.post('/config', (req, res) => {
        try { current.configure(req.body); res.json({ code: 0, data: publicConfig(current.config) }); }
        catch (error) { res.status(400).json({ code: -1, message: error instanceof Error ? error.message : '配置保存失败。' }); }
    });
    context.router.get('/preview', async (_req, res) => {
        const client = current.client;
        const renderer = current.images;
        try {
            const snapshot = filterQuota(await client.getQuota(), current.config);
            if (current.closed || current.client !== client) { res.status(409).json({ code: -1, message: '配置已变更，请重新查询。' }); return; }
            let images: string[] = [];
            try { images = await renderer.render(snapshot); } catch { /* Text remains available if rendering fails. */ }
            if (current.closed || current.client !== client) { res.status(409).json({ code: -1, message: '配置已变更，请重新查询。' }); return; }
            res.json({ code: 0, data: { snapshot, messages: formatSnapshot(snapshot), images } });
        } catch (error) { res.status(502).json({ code: -1, message: safeError(error) }); }
    });
    context.router.get('/catalog', async (_req, res) => {
        const client = current.client, personal = current.personal;
        try {
            const [quota, users] = await Promise.all([client.getQuota(), personal.users()]);
            if (current.closed || client !== current.client) throw new Error('配置已变更，请重试。');
            res.json({ code: 0, data: { channels: quota.channels.map(c => ({ id: c.id, name: c.name })), users, ...current.bindings.list() } });
        } catch { res.status(502).json({ code: -1, message: '无法读取账号或渠道，请检查配置后重试。' }); }
    });
    context.router.post('/binding', async (req, res) => {
        const body = record(req.body), personal = current.personal, revision = current.bindings.revision;
        try {
            if (typeof body.qq !== 'string' || !/^[1-9]\d{4,19}$/.test(body.qq)) throw new Error('QQ 号无效。');
            if (body.action === 'remove') current.bindings.remove(body.qq);
            else if (body.action === 'approve' && typeof body.userId === 'string') {
                const binding = await personal.user(body.userId);
                if (current.closed || current.personal !== personal || current.bindings.revision !== revision) throw new Error('绑定或配置已变更，请重试。');
                current.bindings.bind(body.qq, binding);
            } else throw new Error('绑定操作无效。');
            res.json({ code: 0, data: current.bindings.list() });
        } catch { res.status(400).json({ code: -1, message: '绑定操作失败，请检查 QQ 号与所选账号。' }); }
    });
    context.logger.info(`${PLUGIN_ID} 已加载（按需查询，无后台轮询）。`);
}

export async function plugin_onmessage(_context: Context, event: MessageEvent): Promise<void> { await runtime?.handler.handle(event); }
export async function plugin_cleanup(): Promise<void> { runtime?.dispose(); runtime = undefined; }
export async function plugin_get_config() { return runtime ? publicConfig(runtime.config) : {}; }
export async function plugin_set_config(_context: Context, input: unknown): Promise<void> {
    if (!runtime) throw new Error('插件尚未初始化。');
    runtime.configure(input);
}

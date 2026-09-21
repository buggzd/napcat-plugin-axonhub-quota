import { record, type Config, type Context, type MessageEvent, type Snapshot } from './types.ts';
import { AxonHubClient, safeError } from './client.ts';
import { formatSnapshot } from './format.ts';
import { PersonalClient } from './personal.ts';
import { BindingStore } from './bindings.ts';
import { usageLines } from './usage-card.ts';
import type { UsageSummary } from './types.ts';

export const HELP_TEXT = [
    'AxonHub 查询帮助',
    '',
    '/额度 — 查看已选渠道的订阅窗口',
    '/用量 或 /今日用量 — 查看本人今日金额、Tokens 和调用次数',
    '/help — 显示本帮助',
    '',
    '以下指令仅限私聊：',
    '/绑定APIKEY 你的Key — 验证后自动绑定个人账号',
    '/绑定账号 账户名 — 提交申请，等待管理员确认',
    '/绑定状态 — 查看当前绑定',
    '/解绑 — 解除绑定并取消申请',
    '',
    '群内查询需在允许的群中 @机器人；用量只查询发送者本人。',
    '私聊额度查询需在白名单中；个人绑定和查询需管理员开放入口。',
    '请勿在群里发送 API Key。插件不保存 Key 原文，QQ 聊天记录仍会保留。',
    '结果缓存 60 秒，指令间隔至少 5 秒；渠道显示由管理员在插件设置页勾选。',
].join('\n');

const filtered = new WeakMap<Snapshot, { config: Config; snapshot: Snapshot }>();
export function filterQuota(snapshot: Snapshot, config: Config): Snapshot {
    const cached = filtered.get(snapshot); if (cached?.config === config) return cached.snapshot;
    const result = config.channelMode === 'selected' ? { ...snapshot, channels: snapshot.channels.filter(channel => config.channelIds.includes(channel.id)) } : snapshot;
    filtered.set(snapshot, { config, snapshot: result }); return result;
}
function plainText(event: MessageEvent): string | undefined {
    if (typeof event.message === 'string') return event.message.includes('[CQ:') ? undefined : event.message.trim();
    if (!Array.isArray(event.message) || event.message.some(s => s.type !== 'text')) return undefined;
    return event.message.map(s => String(s.data.text ?? '')).join('').trim();
}
interface PersonalServices { store: BindingStore; client: PersonalClient; render: (summary: UsageSummary) => Promise<string[]> }


export function isAllowedCommand(event: MessageEvent, config: Config, command = '/额度'): boolean {
    if (!config.enabled || event.post_type !== 'message' || !event.user_id || !event.self_id
        || String(event.user_id) === String(event.self_id)) return false;
    const group = event.message_type === 'group';
    if (!group && event.message_type !== 'private') return false;
    const allowed = (group ? config.allowedGroups : config.allowedUsers).split(',');
    if (!allowed.includes(String(group ? event.group_id ?? '' : event.user_id))) return false;
    let mentioned = false;
    let text = '';
    if (Array.isArray(event.message)) {
        for (const segment of event.message) {
            if (segment.type === 'text') text += String(segment.data.text ?? '');
            else if (segment.type === 'at' && String(segment.data.qq) === String(event.self_id)) mentioned = true;
            else if (segment.type !== 'reply') return false;
        }
    } else if (typeof event.message === 'string') {
        text = event.message.replace(/\[CQ:at,qq=(\d+)\]/g, (whole, qq: string) => {
            if (qq !== String(event.self_id)) return whole;
            mentioned = true; return '';
        }).replace(/\[CQ:reply,id=-?\d+\]/g, '');
    } else return false;
    return (!group || mentioned) && text.trim() === command;
}

export class MessageHandler {
    private cooldown = new Map<string, number>();
    private active = true;
    private inFlight = 0;
    private context: Context;
    private config: Config;
    private client: AxonHubClient;
    private now: () => number;
    private personal?: PersonalServices;
    private bindingAttempts = new Map<string, number>();
    private renderImage?: (snapshot: Snapshot) => Promise<string[]>;
    constructor(context: Context, config: Config, client: AxonHubClient, now = Date.now, renderImage?: (snapshot: Snapshot) => Promise<string[]>, personal?: PersonalServices) {
        this.context = context; this.config = config; this.client = client; this.now = now;
        this.renderImage = renderImage; this.personal = personal;
    }
    dispose(): void { this.active = false; this.cooldown.clear(); this.bindingAttempts.clear(); }
    async handle(event: MessageEvent): Promise<void> {
        if (!this.active || !this.config.enabled || event.post_type !== 'message' || !event.user_id || !event.self_id || String(event.user_id) === String(event.self_id)) return;
        const privateText = event.message_type === 'private' ? plainText(event) : undefined;
        const helpCommand = isAllowedCommand(event, this.config, '/help')
            || (this.config.privateBinding && privateText === '/help');
        const personalCommand = this.personal && (isAllowedCommand(event, this.config, '/用量') || isAllowedCommand(event, this.config, '/今日用量')
            || (this.config.privateBinding && privateText !== undefined && (['/用量', '/今日用量', '/绑定', '/解绑', '/绑定状态'].includes(privateText)
                || /^\/绑定(?:账号|APIKEY|apikey)?\s+\S/u.test(privateText) || (!privateText.startsWith('/') && privateText.length > 0 && privateText.length <= 512))));
        if (!helpCommand && !personalCommand && !isAllowedCommand(event, this.config)) return;
        const now = this.now(); const user = String(event.user_id);
        for (const [id, expires] of this.cooldown) if (expires <= now) this.cooldown.delete(id);
        if ((this.cooldown.get(user) ?? 0) > now || this.inFlight >= 32) return;
        if (this.cooldown.size >= 4096) this.cooldown.delete(this.cooldown.keys().next().value!);
        this.cooldown.set(user, now + 5000); this.inFlight++;
        try {
            if (helpCommand) { await this.send(event, [{ type: 'text', data: { text: HELP_TEXT } }]); return; }
            if (personalCommand) { await this.handlePersonal(event, privateText); return; }
            let messages: string[];
            try {
                const snapshot = filterQuota(await this.client.getQuota(), this.config);
                messages = formatSnapshot(snapshot);
                if (this.renderImage && this.active) {
                    try {
                        const images = await this.renderImage(snapshot);
                        for (const png of images) {
                            if (!this.active) return;
                            await this.send(event, [{ type: 'image', data: { file: 'base64://' + png } }]);
                        }
                        if (images.length) return;
                    } catch { this.context.logger.warn('额度图片不可用，回退文字回复。'); }
                }
            }
            catch (error) { messages = [safeError(error)]; }
            for (const text of messages) {
                if (!this.active) break;
                // Text segments prevent channel names from becoming CQ codes.
                await this.send(event, [{ type: 'text', data: { text } }]);
            }
        } catch { this.context.logger.warn('额度回复发送失败。'); }
        finally { this.inFlight--; }
    }
    private async handlePersonal(event: MessageEvent, text?: string): Promise<void> {
        const services = this.personal!; const qq = String(event.user_id);
        const reply = async (message: string) => { if (this.active) await this.send(event, [{ type: 'text', data: { text: message } }]); };
        try {
            if (event.message_type === 'group' || text === '/用量' || text === '/今日用量') {
                const binding = services.store.get(qq);
                if (!binding) { await reply('尚未绑定账号。请私聊机器人发送 /绑定APIKEY 你的Key，或 /绑定账号 账户名（待管理员确认）。'); return; }
                const usage = await services.client.today(binding);
                if (!this.active || services.store.get(qq) !== binding) return;
                try {
                    const images = await services.render(usage);
                    if (!this.active || services.store.get(qq) !== binding) return;
                    for (const png of images) await this.send(event, [{ type: 'image', data: { file: 'base64://' + png } }]);
                    if (images.length) return;
                } catch { /* A plain text report remains usable if rasterization fails. */ }
                if (services.store.get(qq) === binding) await reply(usageLines(usage).join('\n')); return;
            }
            if (text === '/解绑') { services.store.remove(qq); await reply('已解除绑定并取消待确认申请。'); return; }
            if (text === '/绑定状态') { await reply(services.store.get(qq) ? '已绑定：' + services.store.get(qq)!.name : '尚未绑定，账户名申请需要管理员确认。'); return; }
            if (text === '/绑定') { await reply('私聊发送：\n/绑定APIKEY 你的Key（自动验证）\n/绑定账号 账户名（管理员确认）\n/用量 查询今日统计\n/解绑 解除绑定\n也可直接发送 sk- 开头的 Key 或账户名。插件不保存 Key；QQ 聊天记录仍会保留原消息。'); return; }
            const now = this.now();
            for (const [id, until] of this.bindingAttempts) if (until <= now) this.bindingAttempts.delete(id);
            if ((this.bindingAttempts.get(qq) ?? 0) > now) { await reply('绑定操作每 30 秒可重试一次。'); return; }
            if (this.bindingAttempts.size >= 4096) this.bindingAttempts.delete(this.bindingAttempts.keys().next().value!);
            this.bindingAttempts.set(qq, now + 30000);
            const argument = (text ?? '').replace(/^\/绑定(?:账号|APIKEY|apikey)?\s+/u, '').trim();
            const keyMode = /^\/绑定APIKEY\s/i.test(text ?? '') || /^sk-/i.test(argument) || /^[A-Za-z0-9_-]{32,}$/.test(argument);
            if (keyMode) {
                const revision = services.store.revision;
                const binding = await services.client.bindKey(argument);
                if (!this.active || services.store.revision !== revision) { await reply('绑定状态已变更，请重新提交。'); return; }
                services.store.bind(qq, binding);
                await reply('已绑定：' + binding.name + '。发送 /用量 查看今日金额、Tokens 和调用次数。');
            } else {
                services.store.request(qq, argument, now);
                await reply('账户名绑定申请已提交，管理员确认后生效。也可发送 /绑定APIKEY 你的Key 自动验证。');
            }
        } catch (error) { await reply(error instanceof Error && error.constructor === Error ? '绑定保存失败，请检查输入或联系管理员。' : safeError(error)); }
    }
    private async send(event: MessageEvent, message: unknown[]): Promise<void> {
        const result = record(await this.context.actions.call('send_msg', {
            message_type: event.message_type,
            ...(event.message_type === 'group' ? { group_id: String(event.group_id) } : { user_id: String(event.user_id) }),
            message,
        }, this.context.adapterName, this.context.pluginManager.config));
        if (result.status === 'failed' || (typeof result.retcode === 'number' && result.retcode !== 0)) throw new Error('QQ send failed');
    }
}

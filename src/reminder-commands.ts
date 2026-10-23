import { record, type Config, type Context, type MessageEvent } from './types.ts';

export interface ReminderCommandService {
    getGroup(groupId: string): { enabled: boolean; channelIds: string[] };
    setGroup(groupId: string, value: { enabled: boolean; channelIds: string[] }): void;
    getChannels(): Promise<Array<{ id: string; name: string }>>;
}

const HELP = [
    '充值卡到期提醒（默认关闭）',
    '@机器人 /到期提醒 渠道 — 列出可选渠道及编号',
    '@机器人 /到期提醒 开启 2,15 — 为本群选择渠道并开启',
    '也可填写完整渠道 ID 或准确名称，多个渠道用逗号分隔。',
    '@机器人 /到期提醒 开启 — 沿用本群已保存的渠道',
    '@机器人 /到期提醒 状态 — 查看本群设置',
    '@机器人 /到期提醒 关闭 — 关闭本群提醒，保留渠道选择',
    '仅群主和管理员可配置；仅在开启后每小时轻量检查。',
    '充值卡剩余不足 48 小时且尚未到期时提醒，同一张卡的同一次到期仅提醒一次。',
].join('\n');
const CHANNEL_ID = /^gid:\/\/axonhub\/Channel\/([1-9]\d*)$/;
const shortId = (id: string) => CHANNEL_ID.exec(id)?.[1] ?? id;
const safeName = (name: string) => name.replace(/[\p{Cc}\p{Cf}]/gu, ' ').slice(0, 200);

function commandText(event: MessageEvent, config: Config): string | undefined {
    if (!config.enabled || event.post_type !== 'message' || event.message_type !== 'group'
        || !event.user_id || !event.self_id || !event.group_id || String(event.user_id) === String(event.self_id)
        || !config.allowedGroups.split(',').includes(String(event.group_id))) return undefined;
    let mentioned = false, text = '';
    if (Array.isArray(event.message)) {
        for (const segment of event.message) {
            if (segment.type === 'text') text += String(segment.data.text ?? '');
            else if (segment.type === 'at' && String(segment.data.qq) === String(event.self_id)) mentioned = true;
            else if (segment.type !== 'reply') return undefined;
        }
    } else if (typeof event.message === 'string') {
        text = event.message.replace(/\[CQ:at,qq=(\d+)\]/g, (whole, qq: string) => {
            if (qq !== String(event.self_id)) return whole;
            mentioned = true; return '';
        }).replace(/\[CQ:reply,id=-?\d+\]/g, '');
        if (text.includes('[CQ:')) return undefined;
    } else return undefined;
    const match = /^\/到期提醒(?:\s+(.*))?$/su.exec(text.trim());
    return mentioned && match ? (match[1] ?? '').trim() : undefined;
}

function parts(text: string): string[] {
    const result: string[] = []; let pending = '';
    for (const line of text.split('\n')) {
        if (pending && pending.length + line.length + 1 > 1800) { result.push(pending); pending = ''; }
        let remaining = line;
        while (remaining.length > 1800) { result.push(remaining.slice(0, 1800)); remaining = remaining.slice(1800); }
        pending += (pending ? '\n' : '') + remaining;
    }
    if (pending) result.push(pending);
    return result;
}

export class ReminderCommands {
    private active = true;
    private cooldown = new Map<string, number>();
    private queues = new Map<string, Promise<void>>();
    private inFlight = 0;
    private context: Context;
    private config: Config;
    private service: ReminderCommandService;
    constructor(context: Context, config: Config, service: ReminderCommandService) {
        this.context = context; this.config = config; this.service = service;
    }
    dispose(): void { this.active = false; this.cooldown.clear(); this.queues.clear(); }

    async handle(event: MessageEvent): Promise<boolean> {
        if (!this.active) return false;
        const text = commandText(event, this.config);
        if (text === undefined) return false;
        const group = String(event.group_id), key = group + ':' + String(event.user_id), now = Date.now();
        for (const [id, until] of this.cooldown) if (until <= now) this.cooldown.delete(id);
        if ((this.cooldown.get(key) ?? 0) > now || this.inFlight >= 32) return true;
        if (this.cooldown.size >= 4096) this.cooldown.delete(this.cooldown.keys().next().value!);
        this.cooldown.set(key, now + 5000); this.inFlight++;
        // Keep updates in arrival order even when role or catalog requests finish out of order.
        const previous = this.queues.get(group) ?? Promise.resolve();
        const pending = previous.catch(() => {}).then(() => this.run(event, text));
        this.queues.set(group, pending);
        try { await pending; }
        finally { this.inFlight--; if (this.queues.get(group) === pending) this.queues.delete(group); }
        return true;
    }

    private async run(event: MessageEvent, text: string): Promise<void> {
        if (!this.active) return;
        try {
            if (!await this.isAdmin(event)) {
                if (this.active) await this.reply(event, '到期提醒仅允许本群群主或管理员配置；未能确认权限时不会修改设置。');
                return;
            }
            if (!this.active) return;
            const group = String(event.group_id);
            if (!text) { await this.reply(event, HELP); return; }
            if (text === '状态') {
                const saved = this.service.getGroup(group);
                await this.reply(event, `本群到期提醒：${saved.enabled ? '已开启' : '已关闭'}\n渠道编号：${saved.channelIds.length ? saved.channelIds.map(shortId).join('、') : '尚未选择'}\n开启后每小时检查，剩余不足 48 小时且尚未到期时提醒；同一张卡的同一次到期仅提醒一次。`);
                return;
            }
            if (text === '关闭') {
                const saved = this.service.getGroup(group);
                this.service.setGroup(group, { enabled: false, channelIds: [...saved.channelIds] });
                await this.reply(event, '本群到期提醒已关闭，已保留渠道选择。'); return;
            }
            if (text === '渠道') {
                const channels = await this.service.getChannels();
                if (!this.active) return;
                await this.reply(event, channels.length ? '可选渠道（编号：名称）\n' + channels.map(channel => `${shortId(channel.id)}：${safeName(channel.name)}`).join('\n') : '当前没有可选择的渠道。');
                return;
            }
            const enable = /^开启(?:\s+(.*))?$/su.exec(text);
            if (!enable) { await this.reply(event, '到期提醒指令格式无效。\n' + HELP); return; }
            const argument = enable[1]?.trim();
            const requested = argument ? argument.split(/[,，]/u).map(value => value.trim()) : [...this.service.getGroup(group).channelIds];
            if (!requested.length || requested.some(value => !value) || requested.length > 100) {
                await this.reply(event, '请先选择 1 至 100 个渠道，例如 /到期提醒 开启 2,15；发送 /到期提醒 渠道 查看编号。'); return;
            }
            const channels = await this.service.getChannels();
            if (!this.active) return;
            const selected: Array<{ id: string; name: string }> = [];
            for (const value of requested) {
                const id = /^[1-9]\d*$/.test(value) ? `gid://axonhub/Channel/${value}` : value;
                const matches = channels.filter(channel => CHANNEL_ID.test(id) ? channel.id === id : channel.name === value);
                if (matches.length !== 1 || !CHANNEL_ID.test(matches[0].id)) {
                    await this.reply(event, '存在无效或重名的渠道，设置未修改。请发送 /到期提醒 渠道，使用渠道编号重新配置。'); return;
                }
                if (!selected.some(channel => channel.id === matches[0].id)) selected.push(matches[0]);
            }
            if (!this.active) return;
            this.service.setGroup(group, { enabled: true, channelIds: selected.map(channel => channel.id) });
            await this.reply(event, '本群到期提醒已开启。\n渠道：' + selected.map(channel => `${shortId(channel.id)} ${safeName(channel.name)}`).join('、')
                + '\n每小时轻量检查；充值卡剩余不足 48 小时且尚未到期时提醒，同一张卡的同一次到期仅提醒一次。');
        } catch {
            if (this.active) {
                try { await this.reply(event, '到期提醒操作失败，请检查 AxonHub 和机器人权限后重试。'); }
                catch { this.context.logger.warn('到期提醒回复发送失败。'); }
            }
        }
    }

    private async isAdmin(event: MessageEvent): Promise<boolean> {
        try {
            const result = record(await this.context.actions.call('get_group_member_info', {
                group_id: String(event.group_id), user_id: String(event.user_id), no_cache: true,
            }, this.context.adapterName, this.context.pluginManager.config));
            if (!this.active || (result.status !== undefined && result.status !== 'ok') || (result.retcode !== undefined && result.retcode !== 0)) return false;
            const member = 'data' in result ? record(result.data) : result;
            if ((member.group_id !== undefined && String(member.group_id) !== String(event.group_id))
                || (member.user_id !== undefined && String(member.user_id) !== String(event.user_id))) return false;
            return member.role === 'admin' || member.role === 'owner';
        } catch { return false; }
    }

    private async reply(event: MessageEvent, text: string): Promise<void> {
        for (const part of parts(text)) {
            if (!this.active) return;
            const result = record(await this.context.actions.call('send_msg', {
                message_type: 'group', group_id: String(event.group_id), message: [{ type: 'text', data: { text: part } }],
            }, this.context.adapterName, this.context.pluginManager.config));
            if (result.status === 'failed' || (result.retcode !== undefined && result.retcode !== 0)) throw new Error('QQ send failed');
        }
    }
}

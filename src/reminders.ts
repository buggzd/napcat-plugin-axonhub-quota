import { createHash } from 'node:crypto';
import { chmodSync, existsSync, readFileSync } from 'node:fs';
import { record, type Config, type Context, type Snapshot, type ChannelSummary } from './types.ts';
import { saveConfig } from './config.ts';
import { beijingTime } from './format.ts';
import type { AxonHubClient } from './client.ts';

export const REMINDER_INTERVAL_MS = 3600000;
export const EXPIRY_THRESHOLD_MS = 48 * 3600000;
const MAX_GROUPS = 128, MAX_CHANNELS = 100, MAX_DELIVERIES = 20000;
export interface GroupReminder { enabled: boolean; channelIds: string[] }
interface ReminderState { site: string; groups: Record<string, GroupReminder>; delivered: Record<string, number> }
const validGroup = (id: string) => /^[1-9]\d{4,19}$/.test(id);
const validChannel = (id: unknown): id is string => typeof id === 'string' && /^gid:\/\/axonhub\/Channel\/\d+$/.test(id);

// Separate from account configuration so group changes do not reset credentials or query caches.
export class ReminderStore {
    epoch = 0;
    private retired = false;
    private sending = new Set<string>();
    private file: string;
    private state: ReminderState;
    constructor(file: string, site: string) {
        this.file = file; this.state = { site, groups: {}, delivered: {} };
        if (!existsSync(file)) return;
        try {
            const raw = record(JSON.parse(readFileSync(file, 'utf8')));
            if (raw.site !== site) return;
            if (!raw.groups || typeof raw.groups !== 'object' || Array.isArray(raw.groups) || !raw.delivered || typeof raw.delivered !== 'object' || Array.isArray(raw.delivered)) throw new Error('shape');
            const groups = record(raw.groups), delivered = record(raw.delivered);
            if (Object.keys(groups).length > MAX_GROUPS || Object.keys(delivered).length > MAX_DELIVERIES) throw new Error('size');
            for (const [group, value] of Object.entries(groups)) {
                const entry = record(value);
                if (!validGroup(group) || typeof entry.enabled !== 'boolean' || !Array.isArray(entry.channelIds)
                    || entry.channelIds.length > MAX_CHANNELS || entry.channelIds.some(id => !validChannel(id))
                    || (entry.enabled && entry.channelIds.length === 0)) throw new Error('group');
                this.state.groups[group] = { enabled: entry.enabled, channelIds: [...new Set(entry.channelIds)] as string[] };
            }
            for (const [key, expiry] of Object.entries(delivered)) {
                if (!/^[a-f0-9]{64}$/.test(key) || typeof expiry !== 'number' || !Number.isFinite(expiry) || expiry <= 0) throw new Error('delivery');
                this.state.delivered[key] = expiry;
            }
            chmodSync(file, 0o600);
        } catch { throw new Error('无法读取到期提醒配置；原文件未覆盖，请检查 reminders.json。'); }
    }
    getGroup(group: string): GroupReminder {
        const saved = this.state.groups[group];
        return saved ? { enabled: saved.enabled, channelIds: [...saved.channelIds] } : { enabled: false, channelIds: [] };
    }
    groups(): Array<[string, GroupReminder]> { return Object.keys(this.state.groups).map(id => [id, this.getGroup(id)]); }
    setGroup(group: string, value: GroupReminder): void {
        if (!validGroup(group) || typeof value.enabled !== 'boolean' || !Array.isArray(value.channelIds)
            || value.channelIds.some(id => !validChannel(id)) || value.channelIds.length > MAX_CHANNELS
            || (value.enabled && value.channelIds.length === 0)) throw new Error('提醒渠道配置无效。');
        if (!this.state.groups[group] && Object.keys(this.state.groups).length >= MAX_GROUPS) throw new Error('提醒群数量已达上限。');
        const next = { ...this.state, groups: { ...this.state.groups, [group]: { enabled: value.enabled, channelIds: [...new Set(value.channelIds)] } } };
        const union = new Set(Object.values(next.groups).filter(group => group.enabled).flatMap(group => group.channelIds));
        if (union.size > 5000) throw new Error('所有群的提醒渠道总数已达上限。');
        saveConfig(this.file, next); this.state = next;
    }
    resetSite(site: string): void {
        const next = { site, groups: {}, delivered: {} };
        saveConfig(this.file, next); this.state = next; this.epoch++; this.sending.clear();
    }
    retire(): void { this.retired = true; }
    prune(now: number): void {
        // Expired identities cannot cause a future duplicate because expired cards are never notified.
        for (const [key, expiry] of Object.entries(this.state.delivered)) if (expiry <= now) delete this.state.delivered[key];
    }
    hasDelivered(key: string): boolean { return Object.hasOwn(this.state.delivered, key); }
    isSending(key: string): boolean { return this.sending.has(key); }
    reserve(items: Array<{ key: string }>, epoch: number): boolean {
        if (this.retired || epoch !== this.epoch || items.some(item => this.hasDelivered(item.key) || this.isSending(item.key))) return false;
        for (const item of items) this.sending.add(item.key);
        return true;
    }
    release(items: Array<{ key: string }>, epoch: number): void {
        if (epoch === this.epoch) for (const item of items) this.sending.delete(item.key);
    }
    hasRoom(count: number): boolean { return Object.keys(this.state.delivered).length + count <= MAX_DELIVERIES; }
    markDelivered(items: Array<{ key: string; expiresAt: number }>): void {
        if (this.retired) return;
        // Keep in-memory acknowledgement even if persistence fails after the successful QQ send.
        for (const item of items) this.state.delivered[item.key] = item.expiresAt;
        saveConfig(this.file, this.state);
    }
}

interface Notice { key: string; expiresAt: number; channelId: string; channelName: string }
function identity(group: string, channel: string, card: { key: string; expiresAt: number }): string {
    return createHash('sha256').update(JSON.stringify([group, channel, card.key, card.expiresAt])).digest('hex');
}
export function dueCards(channel: ChannelSummary, now: number): Array<{ key: string; expiresAt: number }> {
    if (channel.state === 'failed' || !Array.isArray(channel.resetCards)) return [];
    return channel.resetCards.filter(card => /^[a-f0-9]{64}$/.test(card.key) && Number.isFinite(card.expiresAt)
        && card.expiresAt > now && card.expiresAt - now < EXPIRY_THRESHOLD_MS);
}
function noticeText(items: Notice[], now: number): string {
    return '重制卡到期提醒\n\n' + items.map(item => {
        const hours = Math.ceil((item.expiresAt - now) / 3600000);
        return `${item.channelName.replace(/[\p{Cc}\p{Cf}]/gu, ' ').slice(0, 200)}\n一张重制卡将于 ${beijingTime(item.expiresAt)} 到期（北京时间，剩余约 ${hours} 小时）`;
    }).join('\n\n') + '\n\n请及时在 AxonHub 查看和处理；本提醒不会使用或重置重制卡。';
}

export class ReminderService {
    private context: Context;
    private config: Config;
    private client: AxonHubClient;
    private store: ReminderStore;
    private now: () => number;
    private timer?: ReturnType<typeof setTimeout>;
    private running?: Promise<void>;
    private closed = false;
    private generation = 0;
    private storeEpoch: number;
    private followup = false;
    constructor(context: Context, config: Config, client: AxonHubClient, store: ReminderStore, now = Date.now) {
        this.context = context; this.config = config; this.client = client; this.store = store; this.now = now; this.storeEpoch = store.epoch;
        this.schedule(1000);
    }
    private eligible(): Array<[string, GroupReminder]> {
        if (this.closed || !this.config.enabled || this.store.epoch !== this.storeEpoch) return [];
        const allowed = new Set(this.config.allowedGroups.split(','));
        return this.store.groups().filter(([group, value]) => value.enabled && value.channelIds.length > 0 && allowed.has(group));
    }
    private schedule(delay: number): void {
        if (this.timer || !this.eligible().length) return;
        this.timer = setTimeout(() => {
            this.timer = undefined;
            void this.checkNow().finally(() => this.schedule(REMINDER_INTERVAL_MS)).catch(() => {});
        }, delay);
        this.timer.unref?.();
    }
    getGroup(group: string): GroupReminder { return this.store.getGroup(group); }
    setGroup(group: string, value: GroupReminder): void {
        if (this.closed || !this.config.enabled || !this.config.allowedGroups.split(',').includes(group)) throw new Error('该群未开放提醒配置。');
        this.store.setGroup(group, value); this.generation++;
        if (this.timer) { clearTimeout(this.timer); this.timer = undefined; }
        if (this.running) this.followup = true; else this.schedule(1000);
    }
    async getChannels(): Promise<Array<{ id: string; name: string }>> {
        const snapshot = await this.client.getQuota();
        return snapshot.channels.map(channel => ({ id: channel.id, name: channel.name }));
    }
    checkNow(): Promise<void> {
        if (this.running) return this.running;
        const groups = this.eligible();
        if (!groups.length) return Promise.resolve();
        const generation = this.generation;
        const pending = this.check(groups, generation).catch(() => {
            if (!this.closed) this.context.logger.warn('重制卡到期检查失败，将在下个检查周期重试。');
        });
        this.running = pending;
        void pending.finally(() => {
            if (this.running === pending) this.running = undefined;
            if (this.followup && !this.closed) { this.followup = false; this.schedule(1000); }
        }).catch(() => {});
        return pending;
    }
    private async check(groups: Array<[string, GroupReminder]>, generation: number): Promise<void> {
        const channelIds = [...new Set(groups.flatMap(([, value]) => value.channelIds))];
        const snapshot: Snapshot = await this.client.getQuotaForChannels(channelIds);
        if (this.closed || generation !== this.generation || this.store.epoch !== this.storeEpoch) return;
        const now = this.now(); this.store.prune(now);
        for (const [group, settings] of groups) {
            const unique = new Map<string, Notice>();
            for (const channel of snapshot.channels) {
                if (!settings.channelIds.includes(channel.id)) continue;
                for (const card of dueCards(channel, now)) {
                    const key = identity(group, channel.id, card);
                    if (!this.store.hasDelivered(key) && !this.store.isSending(key)) unique.set(key, { key, expiresAt: card.expiresAt, channelId: channel.id, channelName: channel.name });
                }
            }
            const notices = [...unique.values()].sort((a, b) => a.expiresAt - b.expiresAt);
            // Bound text size and avoid excessive individual messages for unusually large accounts.
            try {
                for (let start = 0; start < notices.length; start += 5) {
                    if (this.closed || generation !== this.generation || this.store.epoch !== this.storeEpoch) return;
                    const sendAt = this.now();
                    const batch = notices.slice(start, start + 5).filter(item => item.expiresAt > sendAt && !this.store.hasDelivered(item.key) && !this.store.isSending(item.key));
                    if (!batch.length) continue;
                    if (!this.store.hasRoom(batch.length)) { this.context.logger.warn('重制卡提醒去重记录已达上限，跳过本次新提醒。'); return; }
                    if (!this.store.reserve(batch, this.storeEpoch)) continue;
                    try {
                        const message = [{ type: 'text', data: { text: noticeText(batch, sendAt) } }];
                        const result = record(await this.context.actions.call('send_msg', { message_type: 'group', group_id: group, message }, this.context.adapterName, this.context.pluginManager.config));
                        if (result.status === 'failed' || (typeof result.retcode === 'number' && result.retcode !== 0)) throw new Error('QQ reminder delivery failed');
                        // A successful send still needs acknowledgement when the group was disabled
                        // while QQ was responding. A site switch must never receive old acknowledgements.
                        if (this.store.epoch === this.storeEpoch) this.store.markDelivered(batch);
                        if (this.closed || generation !== this.generation || this.store.epoch !== this.storeEpoch) return;
                    } finally { this.store.release(batch, this.storeEpoch); }
                }
            } catch {
                if (!this.closed) this.context.logger.warn('一个群的重制卡提醒发送或保存失败，其余群继续检查。');
            }
        }
    }
    dispose(): void {
        this.closed = true; this.generation++;
        if (this.timer) clearTimeout(this.timer);
        this.timer = undefined;
    }
}

import { AxonHubClient, QuotaError } from './client.ts';
import { record, type UsageSummary } from './types.ts';
import type { Binding } from './bindings.ts';

const USER_FIELDS = 'id firstName lastName status';
export const BIND_KEY_QUERY = `query NapCatBindKey($key: String!) {
 apiKeys(first: 2, where: {key: $key, status: enabled, typeIn: [user, personal]}) {
  edges {node {id type status user {${USER_FIELDS}}}} pageInfo {hasNextPage}
 }
}`;
export const USAGE_QUERY = `query NapCatTodayUsage($filter: AnalyticsFilter) {
 analyticsOverview(filter: $filter) {totalTokens totalInputTokens totalCachedInputTokens totalOutputTokens totalRequests totalCost}
}`;
export function siteDay(now: number, timezone: string): string {
    return new Intl.DateTimeFormat('sv-SE', { timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(now);
}
function userBinding(value: unknown): Binding {
    const user = record(value);
    if (typeof user.id !== 'string' || !/^gid:\/\/axonhub\/User\/\d+$/.test(user.id) || user.status !== 'activated') throw new QuotaError('binding', '账号不存在或已停用，请重新绑定或联系管理员。');
    return { userId: user.id, name: [user.firstName, user.lastName].filter(v => typeof v === 'string').join(' ').slice(0, 100) || 'AxonHub 用户' };
}
export class PersonalClient {
    private client: AxonHubClient;
    private now: () => number;
    private cache = new Map<string, UsageSummary>();
    private pending = new Map<string, Promise<UsageSummary>>();
    private settings?: { timezone: string; currency: string; readAt: number };
    private settingsPending?: Promise<{ timezone: string; currency: string; readAt: number }>;
    private closed = false;
    constructor(client: AxonHubClient, now = Date.now) { this.client = client; this.now = now; }
    dispose() { this.closed = true; this.cache.clear(); this.pending.clear(); this.settings = undefined; }
    async bindKey(key: string): Promise<Binding> {
        if (key.length < 16 || key.length > 512 || /\s/.test(key)) throw new QuotaError('binding', 'API Key 格式无效。');
        const data = await this.client.graphql(BIND_KEY_QUERY, { key });
        const connection = record(data.apiKeys);
        if (!Array.isArray(connection.edges) || connection.edges.length !== 1 || record(connection.pageInfo).hasNextPage !== false) throw new QuotaError('binding', '无法验证 API Key，请使用当前站点已启用的个人账号 Key。');
        const node = record(record(connection.edges[0]).node);
        if (typeof node.id !== 'string' || node.status !== 'enabled' || !['user', 'personal'].includes(String(node.type))) throw new QuotaError('binding', '此 Key 不能用于个人绑定。');
        return { ...userBinding(node.user), keyId: node.id };
    }
    async user(id: string): Promise<Binding> {
        if (!/^gid:\/\/axonhub\/User\/\d+$/.test(id)) throw new QuotaError('binding', '账号 ID 无效。');
        const data = await this.client.graphql(`query($id: ID!) {node(id: $id) {... on User {${USER_FIELDS}}}}`, { id });
        const binding = userBinding(data.node);
        if (binding.userId !== id) throw new QuotaError('binding', '账号不匹配。');
        return binding;
    }
    async users(): Promise<Binding[]> {
        const result: Binding[] = [], cursors = new Set<string>(); let after: string | undefined;
        for (let page = 0; page < 100; page++) {
            const data = await this.client.graphql(`query($after: Cursor) {users(first: 50, after: $after) {edges {node {${USER_FIELDS}}} pageInfo {hasNextPage endCursor}}}`, { after });
            const connection = record(data.users), info = record(connection.pageInfo);
            if (!Array.isArray(connection.edges) || typeof info.hasNextPage !== 'boolean') throw new QuotaError('shape', '用户列表格式不兼容。');
            for (const edge of connection.edges) { const node = record(record(edge).node); if (node.status === 'activated') result.push(userBinding(node)); }
            if (!info.hasNextPage) return result;
            if (typeof info.endCursor !== 'string' || !info.endCursor || cursors.has(info.endCursor)) break;
            after = info.endCursor; cursors.add(after);
        }
        throw new QuotaError('pagination', '无法完整读取用户列表。');
    }
    private getSettings() {
        if (this.settings && this.now() - this.settings.readAt < 600000) return Promise.resolve(this.settings);
        if (this.settingsPending) return this.settingsPending;
        const pending = this.client.graphql('query {systemGeneralSettings {currencyCode timezone}}').then(data => {
            const raw = record(data.systemGeneralSettings);
            if (typeof raw.timezone !== 'string' || typeof raw.currencyCode !== 'string' || !/^[A-Z]{3}$/.test(raw.currencyCode)) throw new QuotaError('shape', '无法读取站点时区或币种。');
            try { siteDay(this.now(), raw.timezone); } catch { throw new QuotaError('shape', '站点时区无效。'); }
            return this.settings = { timezone: raw.timezone, currency: raw.currencyCode, readAt: this.now() };
        });
        this.settingsPending = pending;
        void pending.finally(() => { if (this.settingsPending === pending) this.settingsPending = undefined; }).catch(() => {});
        return pending;
    }
    async today(binding: Binding): Promise<UsageSummary> {
        if (this.closed) throw new QuotaError('cancelled', '查询已取消。');
        // Always require an explicit validated user identity; an empty filter would expose site totals.
        if (!/^gid:\/\/axonhub\/User\/\d+$/.test(binding.userId)) throw new QuotaError('binding', '请先绑定账号。');
        const settings = await this.getSettings(), day = siteDay(this.now(), settings.timezone);
        const key = JSON.stringify([binding.userId, binding.keyId, day, settings.timezone, settings.currency]);
        for (const [id, item] of this.cache) if (this.now() - item.readAt >= 60000) this.cache.delete(id);
        const cached = this.cache.get(key); if (cached) return cached;
        const existing = this.pending.get(key); if (existing) return existing;
        if (this.pending.size >= 32) throw new QuotaError('busy', '查询繁忙，请稍后重试。');
        const pending = (async () => {
            const user = await this.user(binding.userId);
            if (binding.keyId) {
                const data = await this.client.graphql('query($id: ID!) {node(id: $id) {... on APIKey {id status type userID}}}', { id: binding.keyId });
                const node = record(data.node);
                if (node.id !== binding.keyId || node.userID !== binding.userId || node.status !== 'enabled' || !['user', 'personal'].includes(String(node.type))) throw new QuotaError('binding', '绑定 Key 已停用或失效，请重新绑定。');
            }
            const data = await this.client.graphql(USAGE_QUERY, { filter: { startTime: day, endTime: day, userIDs: [binding.userId] } });
            if (siteDay(this.now(), settings.timezone) !== day) throw new QuotaError('dayChanged', '日期已切换，请重新查询今日用量。');
            if (!data.analyticsOverview || this.closed) throw new QuotaError('shape', '个人用量暂不可用。');
            const raw = record(data.analyticsOverview);
            const value = (name: string) => typeof raw[name] === 'number' && Number.isFinite(raw[name]) && raw[name] >= 0 ? raw[name] as number : null;
            const summary: UsageSummary = { userId: binding.userId, name: user.name, day, timezone: settings.timezone, currency: settings.currency, readAt: this.now(), totalTokens: value('totalTokens'), totalInputTokens: value('totalInputTokens'), totalCachedInputTokens: value('totalCachedInputTokens'), totalOutputTokens: value('totalOutputTokens'), totalRequests: value('totalRequests'), totalCost: value('totalCost') };
            if (this.cache.size >= 128) this.cache.delete(this.cache.keys().next().value!);
            this.cache.set(key, summary); return summary;
        })();
        this.pending.set(key, pending);
        void pending.finally(() => { if (this.pending.get(key) === pending) this.pending.delete(key); }).catch(() => {});
        return pending;
    }
}

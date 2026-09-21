import { existsSync, readFileSync } from 'node:fs';
import { saveConfig } from './config.ts';

export interface Binding { userId: string; name: string; keyId?: string }
export interface BindingRequest { qq: string; account: string; requestedAt: number }
interface State { site: string; bindings: Record<string, Binding>; requests: BindingRequest[] }
// Store only identity metadata. API keys are never persisted.
export class BindingStore {
    revision = 0;
    private state: State;
    private file: string;
    constructor(file: string, site: string) {
        this.file = file; this.state = { site, bindings: {}, requests: [] };
        if (existsSync(file)) {
            const saved = JSON.parse(readFileSync(file, 'utf8')) as State;
            if (saved.site === site && saved.bindings && Array.isArray(saved.requests)) this.state = saved;
        }
    }
    get(qq: string): Binding | undefined { return this.state.bindings[qq]; }
    list() { return { bindings: Object.entries(this.state.bindings).map(([qq, binding]) => ({ qq, ...binding })), requests: this.state.requests }; }
    private commit(next: State) { saveConfig(this.file, next); this.state = next; this.revision++; }
    bind(qq: string, binding: Binding) {
        if (!/^[1-9]\d{4,19}$/.test(qq) || !binding.userId) throw new Error('绑定信息无效。');
        if (!this.get(qq) && Object.keys(this.state.bindings).length >= 4096) throw new Error('绑定数量已达上限。');
        this.commit({ ...this.state, bindings: { ...this.state.bindings, [qq]: { ...binding } }, requests: this.state.requests.filter(r => r.qq !== qq) });
    }
    request(qq: string, account: string, now: number) {
        if (!account || account.length > 100 || /[\r\n\x00-\x1f]/u.test(account) || /^sk-/i.test(account) || /^[A-Za-z0-9_-]{32,}$/.test(account)) throw new Error('请填写账户名；API Key 请使用 /绑定APIKEY。');
        const requests = this.state.requests.filter(r => r.qq !== qq && now - r.requestedAt < 7 * 86400000);
        if (requests.length >= 256) throw new Error('待确认申请已满，请联系管理员。');
        this.commit({ ...this.state, requests: [...requests, { qq, account, requestedAt: now }] });
    }
    remove(qq: string) {
        const bindings = { ...this.state.bindings }; delete bindings[qq];
        this.commit({ ...this.state, bindings, requests: this.state.requests.filter(r => r.qq !== qq) });
    }
    clearForSite(site: string) { this.commit({ site, bindings: {}, requests: [] }); }
}

import { record, type Config, type Snapshot, type ChannelSummary, type UsageSummary } from './types.ts';
import { summarizeChannel } from './format.ts';

export class QuotaError extends Error {
    code: string;
    constructor(code: string, message: string) { super(message); this.code = code; }
}
export function safeError(error: unknown): string {
    return error instanceof QuotaError ? error.message : '额度查询失败，请稍后重试。';
}

// Keep providerType: the deployed AxonHub fails quota resolution without this
// selection ("unsupported provider quota type"), even though we only display Codex.
export const QUOTA_QUERY = `query NapCatCodexQuotas($input: QueryChannelInput!) {
  queryChannels(input: $input) {
    edges { node { id name type status providerQuotaStatus { status ready nextResetAt quotaData providerType } } }
    pageInfo { hasNextPage endCursor }
  }
}`;

type Options = { fetch?: typeof fetch; now?: () => number; timeoutMs?: number; ttlMs?: number; onRequestFailure?: (path: 'signin' | 'graphql', code: string, elapsedMs: number) => void };
export class AxonHubClient {
    private config: Pick<Config, 'baseUrl' | 'email' | 'password'>;
    private fetcher: typeof fetch;
    private now: () => number;
    private timeoutMs: number;
    private ttlMs: number;
    private token = '';
    private loginPending?: Promise<string>;
    private pending?: Promise<Snapshot>;
    private cache?: Snapshot;
    private loginBlockedUntil = 0;
    private closed = false;
    private controllers = new Set<AbortController>();
    private onRequestFailure?: Options['onRequestFailure'];

    constructor(config: Pick<Config, 'baseUrl' | 'email' | 'password'>, options: Options = {}) {
        this.config = { ...config }; this.fetcher = options.fetch ?? fetch;
        this.now = options.now ?? Date.now; this.timeoutMs = options.timeoutMs ?? 10000;
        this.ttlMs = options.ttlMs ?? 60000; this.onRequestFailure = options.onRequestFailure;
    }

    dispose(): void {
        this.closed = true; this.token = ''; this.config.password = ''; this.cache = undefined;
        this.pending = undefined; this.loginPending = undefined;
        for (const controller of this.controllers) controller.abort();
        this.controllers.clear();
    }
    private assertOpen(): void {
        if (this.closed) throw new QuotaError('cancelled', '查询已取消。');
    }

    private async request(path: string, body: unknown, token = ''): Promise<Record<string, unknown>> {
        this.assertOpen();
        const started = this.now();
        const controller = new AbortController(); this.controllers.add(controller);
        const timer = setTimeout(() => controller.abort(), this.timeoutMs); timer.unref?.();
        try {
            const response = await this.fetcher(this.config.baseUrl + path, {
                method: 'POST', redirect: 'error', signal: controller.signal,
                headers: { 'Content-Type': 'application/json', 'User-Agent': 'NapCat-AxonHub-Quota/1.0',
                    ...(token ? { Authorization: `Bearer ${token}` } : {}) },
                body: JSON.stringify(body),
            });
            if (!response.ok) {
                await response.body?.cancel();
                if (response.status === 401) throw new QuotaError('unauthenticated', 'AxonHub 登录已失效。');
                if (response.status === 403) throw new QuotaError('forbidden', 'AxonHub 拒绝访问，请检查账号权限或站点访问策略。');
                if (response.status === 429) throw new QuotaError('rate', 'AxonHub 请求受限，请稍后重试。');
                throw new QuotaError('http', 'AxonHub 服务暂不可用，请稍后重试。');
            }
            // Bound the body even when the server omits Content-Length.
            const reader = response.body?.getReader();
            if (!reader) throw new QuotaError('shape', 'AxonHub 返回的数据格式不兼容。');
            const chunks: Uint8Array[] = []; let size = 0;
            while (true) {
                const { done, value } = await reader.read();
                if (done) break;
                size += value.byteLength;
                if (size > 1024 * 1024) { await reader.cancel(); throw new QuotaError('size', 'AxonHub 返回的数据过大，查询已停止。'); }
                chunks.push(value);
            }
            this.assertOpen();
            return record(JSON.parse(Buffer.concat(chunks).toString('utf8')));
        } catch (error) {
            const failure = this.closed ? new QuotaError('cancelled', '查询已取消。')
                : controller.signal.aborted ? new QuotaError('timeout', 'AxonHub 请求超时，请稍后重试。')
                : error instanceof QuotaError ? error
                : error instanceof SyntaxError ? new QuotaError('shape', 'AxonHub 返回的数据格式不兼容。')
                : new QuotaError('network', '无法连接 AxonHub，请检查地址和网络。');
            if (!this.closed) {
                // Only stage, reason and duration; never log token, URL, body or upstream response.
                try { this.onRequestFailure?.(path.endsWith('/signin') ? 'signin' : 'graphql', failure.code, this.now() - started); } catch { /* Diagnostics cannot break requests. */ }
            }
            throw failure;
        } finally { clearTimeout(timer); this.controllers.delete(controller); }
    }

    private login(): Promise<string> {
        this.assertOpen();
        if (this.token) return Promise.resolve(this.token);
        if (this.loginPending) return this.loginPending;
        if (!this.config.email || !this.config.password) throw new QuotaError('config', '请先在 NapCat 插件配置页填写 AxonHub 管理员账号。');
        if (this.now() < this.loginBlockedUntil) throw new QuotaError('loginCooldown', 'AxonHub 登录暂时冷却，请稍后重试或检查账号配置。');
        const pending = (async () => {
            try {
                const response = await this.request('/admin/auth/signin', { email: this.config.email, password: this.config.password });
                if (typeof response.token !== 'string' || !response.token) throw new QuotaError('login', 'AxonHub 登录失败，请检查管理员账号。');
                this.assertOpen(); this.token = response.token; return this.token;
            } catch (error) {
                if (error instanceof QuotaError && ['unauthenticated', 'login'].includes(error.code)) {
                    this.loginBlockedUntil = this.now() + 30000; throw new QuotaError('login', 'AxonHub 登录失败，请检查管理员邮箱和密码（30 秒后可重试）。');
                }
                throw error;
            }
        })();
        this.loginPending = pending;
        void pending.finally(() => { if (this.loginPending === pending) this.loginPending = undefined; }).catch(() => {});
        return pending;
    }

    async graphql(query: string, variables: Record<string, unknown> = {}): Promise<Record<string, unknown>> {
        let authRetries = 0, transientRetries = 0;
        // All callers use read-only GraphQL queries. Retry a failed transport once only
        // while processing that command; never poll or refresh in the background.
        for (let attempt = 0; attempt < 3; attempt++) {
            const token = await this.login();
            try {
                const response = await this.request('/admin/graphql', { query, variables }, token);
                if (Array.isArray(response.errors) && response.errors.length) {
                    const codes = response.errors.map(e => record(record(e).extensions).code);
                    if (codes.includes('UNAUTHENTICATED')) throw new QuotaError('unauthenticated', 'AxonHub 登录已失效。');
                    if (codes.includes('FORBIDDEN')) throw new QuotaError('forbidden', 'AxonHub 账号无权读取渠道额度。');
                    throw new QuotaError('graphql', 'AxonHub 额度接口返回错误，请检查服务状态或版本兼容性。');
                }
                return record(response.data);
            } catch (error) {
                if (!(error instanceof QuotaError)) throw error;
                if (error.code === 'unauthenticated') {
                    if (this.token === token) this.token = '';
                    if (authRetries++ < 1 && attempt < 2) continue;
                    this.loginBlockedUntil = this.now() + 30000;
                    throw new QuotaError('login', 'AxonHub 登录状态异常，请检查账号配置后重试。');
                }
                if (['timeout', 'network'].includes(error.code) && transientRetries++ < 1 && attempt < 2) continue;
                throw error;
            }
        }
        throw new QuotaError('login', 'AxonHub 登录失败。');
    }

    getQuota(): Promise<Snapshot> {
        this.assertOpen();
        if (this.cache && this.now() - this.cache.readAt < this.ttlMs) return Promise.resolve(this.cache);
        this.cache = undefined;
        if (this.pending) return this.pending;
        const pending = this.readAll(); this.pending = pending;
        void pending.finally(() => { if (this.pending === pending) this.pending = undefined; }).catch(() => {});
        return pending;
    }

    private async readAll(): Promise<Snapshot> {
        const channels: ChannelSummary[] = []; const cursors = new Set<string>(); const ids = new Set<string>();
        let after: string | undefined;
        // Stop pathological or looping pagination with an explicit error, never a partial report.
        for (let page = 0; page < 100; page++) {
            const data = await this.graphql(QUOTA_QUERY, { input: { first: 50, ...(after ? { after } : {}), where: { statusIn: ['enabled'], typeIn: ['codex'] } } });
            const connection = record(data.queryChannels); const info = record(connection.pageInfo);
            if (!Array.isArray(connection.edges) || typeof info.hasNextPage !== 'boolean') throw new QuotaError('shape', 'AxonHub 渠道分页数据格式不兼容。');
            for (const edge of connection.edges) {
                const summary = summarizeChannel(record(edge).node);
                if (summary && !ids.has(summary.id)) { ids.add(summary.id); channels.push(summary); }
            }
            if (!info.hasNextPage) {
                this.assertOpen(); const snapshot = { readAt: this.now(), channels };
                this.cache = snapshot; return snapshot;
            }
            if (typeof info.endCursor !== 'string' || !info.endCursor || cursors.has(info.endCursor)) throw new QuotaError('pagination', 'AxonHub 分页异常，无法完整读取渠道。');
            after = info.endCursor; cursors.add(after);
        }
        throw new QuotaError('pagination', '渠道数量超出本插件单次查询上限，未返回不完整结果。');
    }
}

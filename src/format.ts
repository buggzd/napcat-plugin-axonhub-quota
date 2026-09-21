import { record, type ChannelSummary, type Snapshot, type WindowSummary } from './types.ts';

function windowLabel(seconds: unknown, fallback: string): string {
    if (typeof seconds !== 'number' || !Number.isFinite(seconds) || seconds <= 0) return fallback;
    if (seconds === 604800) return '每周窗口';
    if (seconds % 86400 === 0) return `${seconds / 86400} 天窗口`;
    if (seconds % 3600 === 0) return `${seconds / 3600} 小时窗口`;
    if (seconds % 60 === 0) return `${seconds / 60} 分钟窗口`;
    return `${seconds} 秒窗口`;
}

function parseWindow(raw: unknown, fallback: string): WindowSummary {
    const window = record(raw);
    const used = window.used_percent;
    const reset = window.reset_at;
    return {
        label: windowLabel(window.limit_window_seconds, fallback),
        remaining: typeof used === 'number' && Number.isFinite(used) && used >= 0
            ? Math.round(Math.max(0, 100 - used) * 10) / 10 : null,
        resetAt: typeof reset === 'number' && reset > 0 && Number.isFinite(reset)
            && Number.isFinite(new Date(reset * 1000).getTime()) ? reset * 1000 : null,
    };
}

function finite(value: unknown): number | null {
    return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null;
}
function timestamp(value: unknown): number | null {
    const date = typeof value === 'string' ? Date.parse(value) : NaN;
    return Number.isFinite(date) ? date : null;
}

export function summarizeChannel(raw: unknown): ChannelSummary | null {
    const node = record(raw);
    if (node.type !== 'codex' || node.status !== 'enabled') return null;
    const quota = record(node.providerQuotaStatus);
    const data = record(quota.quotaData);
    const limits = record(data.rate_limit);
    const windows: WindowSummary[] = [];
    const normalized = Array.isArray(data._limits) ? data._limits.map(record).filter(limit => limit.type === 'token') : [];
    // A primary window can itself be weekly (observed on the live deployment).
    for (const [key, label] of [['primary_window', '主窗口'], ['secondary_window', '次窗口']]) {
        const shortKey = key === 'primary_window' ? 'primary' : 'secondary';
        const rawWindow = record(limits[key]);
        const limit = normalized.find(item => item.window === shortKey
            || (rawWindow.limit_window_seconds === 18000 && item.window === '5h')
            || (rawWindow.limit_window_seconds === 604800 && item.window === '7d'));
        if (limits[key] === null || limits[key] === undefined) continue;
        const summary = parseWindow(limits[key], label);
        const ratio = finite(limit?.usageRatio);
        const used = limit?.status === 'exhausted' ? 100 : ratio !== null ? ratio * 100 : finite(rawWindow.used_percent);
        const resetAt = timestamp(limit?.nextResetAt) ?? summary.resetAt;
        const startAt = timestamp(limit?.periodStart);
        windows.push({ ...summary, key: shortKey, usedPercent: used,
            remaining: used === null ? null : Math.round(Math.max(0, 100 - used) * 10) / 10,
            resetAt, durationSeconds: finite(rawWindow.limit_window_seconds) ?? (
                startAt !== null && resetAt !== null && resetAt > startAt ? (resetAt - startAt) / 1000 : null),
            periodStart: startAt, periodCost: finite(limit?.periodCost), periodQuota: finite(limit?.periodQuota),
        });
    }
    const failed = Boolean(data.error) || ['error', 'failed', 'unavailable', 'unknown'].includes(String(quota.status));
    return {
        id: String(node.id ?? ''),
        name: typeof node.name === 'string' ? node.name.replace(/[\p{Cc}\p{Cf}]/gu, ' ').slice(0, 200) : '未命名渠道',
        state: failed ? 'failed' : windows.length === 0 ? 'missing' : 'ok',
        windows: failed ? [] : windows,
        quotaStatus: typeof quota.status === 'string' ? quota.status : 'unknown',
        ...(() => {
            const resets = record(data._resets);
            if (resets.supported !== true) return {};
            const list = Array.isArray(resets.resets) ? resets.resets.map(record) : [];
            const expiry = list.map(item => timestamp(item.expiresAt)).filter((date): date is number => date !== null);
            return { resets: { count: resets.error || !Array.isArray(resets.resets) ? null : list.length,
                expiresAt: expiry.length ? Math.min(...expiry) : null } };
        })(),
    };
}

const dateFormat = new Intl.DateTimeFormat('zh-CN', {
    timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
});
export function beijingTime(value: number): string { return dateFormat.format(value); }

export function formatSnapshot(snapshot: Snapshot): string[] {
    const sections = snapshot.channels.map(channel => {
        const lines = [channel.name];
        if (channel.state === 'failed') lines.push('额度采集失败，请检查 AxonHub。');
        else if (channel.state === 'missing') lines.push('暂无订阅窗口数据。');
        else for (const window of channel.windows) {
            lines.push(`${window.label}：${window.remaining === null ? '剩余额度未知' : `剩余 ${window.remaining}%`}`);
            lines.push(`重置时间：${window.resetAt === null ? '未知' : beijingTime(window.resetAt)}`);
            if (window.resetAt !== null && window.resetAt <= snapshot.readAt) lines.push('该重置时间已过，等待 AxonHub 更新。');
        }
        return lines.join('\n');
    });
    if (sections.length === 0) sections.push('没有可显示的 Codex 渠道。');
    const footer = `\n\n数据来源：AxonHub 已采集额度\n读取时间：${beijingTime(snapshot.readAt)}（北京时间）\n查询结果缓存 60 秒，上游采集可能有延迟。`;
    const parts: string[] = [];
    let part = 'Codex 订阅额度';
    for (const section of sections) {
        if (part.length + section.length + footer.length + 2 > 1800) { parts.push(part + footer); part = 'Codex 订阅额度（续）'; }
        part += '\n\n' + section;
    }
    parts.push(part + footer);
    return parts;
}

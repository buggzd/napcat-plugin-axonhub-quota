import type { ChannelSummary, Snapshot, WindowSummary } from './types.ts';

// Deterministic, local-only SVG. No HTML, remote assets, scripts or browser runtime.
const W = 400, LEFT = 26, RIGHT = 374;
const colors = { bg: '#32322f', text: '#c7c7bc', muted: '#abab9f', track: '#252522', border: '#494941' };
const xml = (value: string) => value.replace(/[&<>"']/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' })[ch]!);
function text(x: number, y: number, value: string, size = 14, fill = colors.text, weight = 500, end = false): string {
    return `<text x="${x}" y="${y}" font-size="${size}" font-weight="${weight}" fill="${fill}"${end ? ' text-anchor="end"' : ''}>${xml(value)}</text>`;
}
function shorten(value: string, max: number): string {
    let width = 0, result = '';
    for (const ch of value) {
        width += /[\u0020-\u007e]/u.test(ch) ? 0.56 : 1;
        if (width > max) return result + '…';
        result += ch;
    }
    return result;
}
const fmt = new Intl.DateTimeFormat('sv-SE', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
function date(value: number, full = false): string { const result = fmt.format(value); return full ? result : result.slice(5); }
function clamp(value: number): number { return Math.min(100, Math.max(0, value)); }
function color(used: number, elapsed: number | null): string {
    let severity = used / 100;
    if (elapsed !== null && elapsed > 0) severity *= severity / Math.max(elapsed / 100, 0.01);
    severity = Math.min(1, Math.max(0, severity));
    const hue = severity < .5 ? 142 - severity * 2 * 97 : 45 - (severity - .5) * 2 * 45;
    return `hsl(${Math.round(hue)}, 72%, 46%)`;
}
function progress(y: number, value: number | null, fill: string): string {
    return `<rect x="${LEFT}" y="${y}" width="${RIGHT - LEFT}" height="7" rx="3.5" fill="${colors.track}"/>`
        + (value !== null && value > 0 ? `<rect x="${LEFT}" y="${y}" width="${(RIGHT - LEFT) * clamp(value) / 100}" height="7" rx="3.5" fill="${fill}"/>` : '');
}
function duration(seconds: number | null | undefined): string {
    if (!seconds || seconds <= 0) return '未知';
    if (seconds % 86400 === 0) return `${seconds / 86400}天`;
    if (seconds % 3600 === 0) return `${seconds / 3600}小时`;
    return `${Math.round(seconds / 60)}分钟`;
}
function until(reset: number, readAt: number): string {
    const minutes = Math.floor((reset - readAt) / 60000);
    if (minutes <= 0) return '等待额度更新';
    const days = Math.floor(minutes / 1440), hours = Math.floor(minutes % 1440 / 60);
    const interval = days ? `${days} 天 ${hours} 小时` : hours ? `${hours} 小时 ${minutes % 60} 分钟` : `${minutes} 分钟`;
    return `重置于 ${interval} (${date(reset)})`;
}
function label(window: WindowSummary): string { return window.key === 'primary' ? '主要窗口' : window.key === 'secondary' ? '次要窗口' : window.label; }

function channelCard(channel: ChannelSummary, start: number, readAt: number): { svg: string; bottom: number } {
    let y = start; const parts: string[] = [];
    const status = channel.state === 'failed' ? '采集失败' : channel.state === 'missing' ? '暂无数据'
        : channel.quotaStatus === 'exhausted' ? '已耗尽' : channel.quotaStatus === 'warning' ? '预警' : '可用';
    const statusColor = status === '可用' ? '#10b953' : status === '预警' ? '#dfb948' : colors.muted;
    const badgeWidth = status.length * 13 + 20;
    parts.push(`<g stroke="${colors.muted}" fill="none" stroke-width="1.4"><rect x="27" y="${y - 11}" width="12" height="9" rx="1"/><path d="M30 ${y - 9}v5m3 -5v5m3 -5v5m6 -4v3"/></g>`);
    parts.push(text(54, y, shorten(channel.name, 13), 18, colors.text, 600));
    parts.push(`<rect x="${RIGHT - badgeWidth}" y="${y - 17}" width="${badgeWidth}" height="24" rx="12" fill="${statusColor}" fill-opacity=".12" stroke="${statusColor}" stroke-opacity=".35"/>`);
    parts.push(text(RIGHT - badgeWidth / 2, y, status, 13, statusColor, 600).replace('<text ', '<text text-anchor="middle" '));
    y += 40;
    if (channel.state !== 'ok') { parts.push(text(LEFT, y, channel.state === 'failed' ? '额度采集失败，请检查 AxonHub。' : '暂无订阅窗口数据。')); y += 28; }
    for (const window of channel.windows) {
        const used = window.usedPercent ?? (window.remaining === null ? null : 100 - window.remaining);
        const seconds = window.durationSeconds;
        const startAt = window.periodStart ?? (window.resetAt !== null && seconds ? window.resetAt - seconds * 1000 : null);
        const elapsed = startAt !== null && window.resetAt !== null && window.resetAt > startAt
            ? clamp((readAt - startAt) / (window.resetAt - startAt) * 100) : null;
        parts.push(text(LEFT, y, label(window)), text(RIGHT, y, used === null ? '未知' : `${Math.round(used)}%`, 14, colors.text, 600, true));
        parts.push(progress(y + 11, used, color(used ?? 0, elapsed))); y += 44;
        parts.push(text(LEFT, y, `${window.key === 'secondary' ? '次要' : '主要'}时长 (${duration(seconds)})`));
        parts.push(text(RIGHT, y, elapsed === null ? '未知' : `${Math.round(elapsed)}%`, 14, colors.text, 600, true));
        parts.push(progress(y + 11, elapsed, '#858583')); y += 47;
        parts.push(text(RIGHT, y, window.resetAt === null ? '重置时间未知' : until(window.resetAt, readAt), 12, colors.muted, 400, true)); y += 28;
    }
    if (channel.resets) {
        parts.push(`<path d="M${LEFT} ${y - 8}H${RIGHT}" stroke="${colors.border}" stroke-dasharray="2 4"/>`); y += 18;
        parts.push(text(LEFT, y, '可用重置次数'), text(RIGHT, y, channel.resets.count === null ? '未知' : `剩余 ${channel.resets.count} 次`, 14, colors.text, 600, true)); y += 29;
        if (channel.resets.expiresAt !== null) { parts.push(text(LEFT, y, '到期时间'), text(RIGHT, y, date(channel.resets.expiresAt, true), 13, colors.text, 600, true)); y += 24; }
    }
    const priced = channel.windows.filter(window => window.periodQuota !== null && window.periodQuota !== undefined);
    if (priced.length) {
        y += 16; parts.push(text(LEFT, y, '预计周期额度')); y += 26;
        for (const window of priced) {
            parts.push(text(LEFT, y, label(window), 13));
            parts.push(text(RIGHT, y, `已用 ${window.periodCost === null || window.periodCost === undefined ? '未知' : '$' + window.periodCost.toFixed(2)} / 约 $${window.periodQuota!.toFixed(2)}`, 13, colors.text, 600, true)); y += 25;
        }
    }
    return { svg: parts.join(''), bottom: y };
}

export function createCards(snapshot: Snapshot): string[] {
    const pages: string[] = []; let parts: string[] = []; let y = 70;
    const finish = () => {
        const height = y + 67;
        pages.push(`<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${height}" viewBox="0 0 ${W} ${height}">`
            + `<rect x=".5" y=".5" width="${W - 1}" height="${height - 1}" rx="13" fill="${colors.bg}" stroke="${colors.border}"/>`
            + `<g font-family="WenQuanYi Zen Hei, Heiti SC, Noto Sans CJK SC, sans-serif">`
            + text(22, 31, '提供商配额', 14, colors.muted, 600)
            + `<g transform="translate(360 19)" fill="none" stroke="${colors.muted}" stroke-width="1.5" stroke-linecap="round"><path d="M2 6a7 7 0 0 1 12-3l2 2m0-5v5h-5M16 10A7 7 0 0 1 4 13l-2-2m0 5v-5h5"/></g>`
            + parts.join('')
            + `<path d="M${LEFT} ${y + 5}H${RIGHT}" stroke="${colors.border}"/>`
            + text(LEFT, y + 29, `读取于 ${date(snapshot.readAt)} · 北京时间`, 11, colors.muted, 400)
            + text(LEFT, y + 48, '百分比为已用量 · 灰条为时间进度 · 缓存 60 秒', 10, colors.muted, 400)
            + '</g></svg>');
    };
    if (!snapshot.channels.length) { parts.push(text(LEFT, y, '没有可显示的 Codex 渠道。')); y += 25; }
    for (const channel of snapshot.channels) {
        let card = channelCard(channel, y, snapshot.readAt);
        if (card.bottom > 1350 && parts.length) { finish(); parts = []; y = 70; card = channelCard(channel, y, snapshot.readAt); }
        if (parts.length) parts.push(`<path d="M${LEFT} ${y - 30}H${RIGHT}" stroke="${colors.border}"/>`);
        parts.push(card.svg); y = card.bottom + 28;
    }
    finish(); return pages;
}

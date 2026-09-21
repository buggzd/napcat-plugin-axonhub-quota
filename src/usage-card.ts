import type { UsageSummary } from './types.ts';
const number = (value: number | null) => value === null ? '未知' : value.toLocaleString('en-US', { maximumFractionDigits: 0 });
export function usageLines(s: UsageSummary): string[] {
    return ['今日用量', s.name, `${s.day} · ${s.timezone}`, `使用金额：${s.totalCost === null ? '未知' : s.totalCost.toFixed(4)} ${s.currency}`,
        `总 Tokens：${number(s.totalTokens)}`, `调用次数：${number(s.totalRequests)}`,
        `输入 Tokens：${number(s.totalInputTokens)}`, `其中缓存输入：${number(s.totalCachedInputTokens)}`, `输出 Tokens：${number(s.totalOutputTokens)}`,
        '统计范围：该账号全部 API Key', '调用次数按 AxonHub 用量记录统计', '缓存输入已包含在输入 Tokens 中',
        `读取时间：${new Intl.DateTimeFormat('sv-SE', { timeZone: s.timezone, hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' }).format(s.readAt)}`];
}
export function usageCard(s: UsageSummary): string[] {
    const xml = (v: string) => v.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' })[c]!);
    const lines = usageLines(s); let y = 35;
    const content = lines.map((line, i) => {
        y += i === 3 || i === 9 ? 22 : 0;
        const text = `<text x="26" y="${y}" fill="${i === 3 ? '#4ade80' : i >= 9 ? '#abab9f' : '#c7c7bc'}" font-size="${i === 0 ? 22 : i === 3 ? 20 : i >= 9 ? 12 : 15}" font-weight="${i < 6 ? 600 : 400}">${xml([...line].slice(0, 36).join(''))}</text>`;
        y += i === 0 ? 35 : 27; return text;
    }).join('');
    return [`<svg xmlns="http://www.w3.org/2000/svg" width="400" height="${y + 12}" viewBox="0 0 400 ${y + 12}"><rect width="400" height="${y + 12}" rx="14" fill="#32322f"/><g font-family="WenQuanYi Zen Hei, sans-serif">${content}</g></svg>`];
}

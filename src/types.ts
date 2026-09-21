// The small structural surface used by this plugin, verified against the installed NapCat.
// No NapCat package or application framework is loaded at runtime.
export interface Context {
    pluginName: string;
    configPath: string;
    adapterName: string;
    pluginManager: { config: unknown };
    actions: { call(action: string, params: unknown, adapter: string, config: unknown): Promise<unknown> };
    logger: { info(message: string): void; warn(message: string): void };
    router: {
        get(path: string, handler: RouteHandler): void;
        post(path: string, handler: RouteHandler): void;
        page(page: { path: string; title: string; htmlFile: string; description: string }): void;
    };
}
export type RouteHandler = (request: { body?: unknown }, response: {
    status(code: number): { json(body: unknown): void };
    json(body: unknown): void;
}) => void | Promise<void>;
export interface MessageEvent {
    post_type?: string;
    message_type?: string;
    user_id?: number | string;
    self_id?: number | string;
    group_id?: number | string;
    message?: string | Array<{ type: string; data: Record<string, unknown> }>;
}
export interface Config {
    channelMode: 'all' | 'selected';
    channelIds: string[];
    privateBinding: boolean;
    enabled: boolean;
    baseUrl: string;
    email: string;
    password: string;
    allowedGroups: string;
    allowedUsers: string;
}
export interface WindowSummary {
    label: string;
    remaining: number | null;
    resetAt: number | null;
    key?: string;
    usedPercent?: number | null;
    durationSeconds?: number | null;
    periodStart?: number | null;
    periodCost?: number | null;
    periodQuota?: number | null;
}
export interface ChannelSummary {
    id: string;
    name: string;
    state: 'ok' | 'missing' | 'failed';
    windows: WindowSummary[];
    quotaStatus?: string;
    resets?: { count: number | null; expiresAt: number | null };
}
export interface Snapshot { readAt: number; channels: ChannelSummary[] }

export function record(value: unknown): Record<string, unknown> {
    return value !== null && typeof value === 'object' && !Array.isArray(value)
        ? value as Record<string, unknown> : {};
}

export interface UsageSummary {
    userId: string; name: string; day: string; timezone: string; currency: string; readAt: number;
    totalTokens: number | null; totalInputTokens: number | null; totalCachedInputTokens: number | null;
    totalOutputTokens: number | null; totalRequests: number | null; totalCost: number | null;
}

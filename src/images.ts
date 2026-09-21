import { Worker } from 'node:worker_threads';
import type { Snapshot, UsageSummary } from './types.ts';
import { createCards } from './card.ts';
import { usageCard } from './usage-card.ts';
type RenderData = Snapshot | UsageSummary;

export class ImageRenderer {
    private cache?: { snapshot: RenderData; images: string[] };
    private pending?: { snapshot: RenderData; promise: Promise<string[]> };
    private worker?: Worker;
    private closed = false;
    private rejectPending?: () => void;
    private workerUrl: URL;

    constructor(workerUrl = new URL('./render-worker.mjs', import.meta.url)) { this.workerUrl = workerUrl; }

    render(snapshot: RenderData): Promise<string[]> {
        if (this.closed) return Promise.reject(new Error('Renderer closed'));
        if (this.cache?.snapshot === snapshot) return Promise.resolve(this.cache.images);
        if (this.pending?.snapshot === snapshot) return this.pending.promise;
        if (this.pending) return this.pending.promise.then(() => this.render(snapshot));
        this.cache = undefined;
        const promise = this.renderOnce(snapshot);
        this.pending = { snapshot, promise };
        void promise.finally(() => { if (this.pending?.promise === promise) this.pending = undefined; }).catch(() => {});
        return promise;
    }

    private renderOnce(snapshot: RenderData): Promise<string[]> {
        return new Promise((resolve, reject) => {
            const svgs = 'channels' in snapshot ? createCards(snapshot) : usageCard(snapshot);
            // Bound image memory for unusually large installations; callers fall back to text.
            if (svgs.length > 20) { reject(new Error('Too many image pages')); return; }
            const worker = new Worker(this.workerUrl, { workerData: { svgs } });
            this.worker = worker;
            let done = false; let bytes = 0; const images: string[] = [];
            const finish = (success: boolean) => {
                if (done) return; done = true; clearTimeout(timer); this.rejectPending = undefined;
                worker.removeAllListeners();
                // Release the WASM heap, font and raster buffers before fulfilling the request.
                void worker.terminate().then(() => {
                    if (this.worker === worker) this.worker = undefined;
                    if (success && !this.closed && images.length === svgs.length) {
                        this.cache = { snapshot, images }; resolve(images);
                    } else reject(new Error('Quota image rendering failed'));
                }, () => reject(new Error('Quota image rendering failed')));
            };
            const timer = setTimeout(() => finish(false), 20000); timer.unref?.();
            this.rejectPending = () => finish(false);
            worker.on('message', (message: { png?: string; done?: boolean; failed?: boolean }) => {
                if (message.png) {
                    bytes += message.png.length;
                    if (bytes > 8 * 1024 * 1024) { finish(false); return; }
                    images.push(message.png);
                }
                if (message.done) finish(true);
                if (message.failed) finish(false);
            });
            worker.on('error', () => finish(false));
            worker.on('exit', () => { if (!done) finish(false); });
        });
    }

    dispose(): void {
        this.closed = true; this.cache = undefined; this.rejectPending?.();
        this.pending = undefined;
    }
}

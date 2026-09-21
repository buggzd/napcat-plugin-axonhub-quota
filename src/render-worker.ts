import { parentPort, workerData } from 'node:worker_threads';
import { readFileSync, existsSync } from 'node:fs';
import { Resvg, initWasm } from '@resvg/resvg-wasm';

try {
    const fontPath = [process.env.AXONHUB_QUOTA_FONT,
        '/usr/share/fonts/truetype/wqy/wqy-zenhei.ttc',
        '/usr/share/fonts/opentype/noto/NotoSansCJK-Regular.ttc',
        '/System/Library/Fonts/STHeiti Light.ttc',
    ].find((path): path is string => Boolean(path) && existsSync(path!));
    if (!fontPath) throw new Error('Chinese font unavailable');
    await initWasm(readFileSync(new URL('./renderer.wasm', import.meta.url)));
    const font = readFileSync(fontPath);
    for (const [index, svg] of (workerData.svgs as string[]).entries()) {
        const renderer = new Resvg(svg, { fitTo: { mode: 'zoom', value: 2 },
            font: { fontBuffers: [font], defaultFontFamily: 'WenQuanYi Zen Hei' } });
        try {
            const image = renderer.render();
            try { parentPort!.postMessage({ index, png: Buffer.from(image.asPng()).toString('base64') }); }
            finally { image.free(); }
        } finally { renderer.free(); }
    }
    parentPort!.postMessage({ done: true });
} catch { parentPort!.postMessage({ failed: true }); }

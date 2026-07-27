'use strict';

const { parentPort, workerData } = require('worker_threads');
const { createPluginModelStore } = require('./pluginModelStore.cjs');
const { createPluginModelInference } = require('./pluginModelInference.cjs');

let core;
const active = new Map();

function safe(error) {
    const message = error && error.message;
    if (message === 'PixAI inference aborted') return { code: 'ABORTED', message: 'Inference aborted' };
    if (message === 'PixAI inference unavailable') return { code: 'NOT_FOUND', message: 'Model is not ready' };
    if (message === 'PixAI inference failed') return { code: 'DECODE_FAILED', message: 'Image inference failed' };
    return { code: 'PROVIDER_ERROR', message: 'Inference provider failed' };
}

function reply(requestId, ok, value) {
    if (typeof requestId !== 'string' || requestId.length > 128) return;
    parentPort.postMessage(ok ? { requestId, ok: true, value } : { requestId, ok: false, error: value });
}

async function initialize() {
    if (!core) {
        const store = createPluginModelStore({ root: workerData.root });
        core = createPluginModelInference({ store });
    }
    await core.initialize();
}

parentPort.on('message', async (message) => {
    if (!message || typeof message !== 'object' || typeof message.type !== 'string') return;
    const { type, requestId } = message;
    try {
        if (type === 'probe') {
            const ort = require('onnxruntime-node');
            const sharp = require('sharp');
            if (!ort?.InferenceSession || typeof ort.InferenceSession.create !== 'function' || typeof sharp !== 'function') throw new Error();
            reply(requestId, true, { backendAvailable: true });
        } else if (type === 'initialize') {
            await initialize(); reply(requestId, true, { initialized: true });
        } else if (type === 'run') {
            if (!(message.image instanceof ArrayBuffer)) throw new Error();
            await initialize();
            const controller = new AbortController(); active.set(requestId, controller);
            try { reply(requestId, true, await core.run(Buffer.from(message.image), { ...(message.options ?? {}), signal: controller.signal })); }
            finally { active.delete(requestId); }
        } else if (type === 'abort') {
            active.get(requestId)?.abort();
        } else if (type === 'dispose') {
            for (const controller of active.values()) controller.abort();
            await core?.dispose(); core = undefined; reply(requestId, true, { disposed: true });
        }
    } catch (error) { reply(requestId, false, safe(error)); }
});

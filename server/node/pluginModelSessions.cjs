'use strict';

const path = require('path');
const crypto = require('crypto');
const { Worker: NativeWorker } = require('worker_threads');
const { PIXAI_PROFILE_ID, getPixaiProfile } = require('./pluginModelRegistry.cjs');

const IDLE_MS = 60_000;
const WATCHDOG_MS = 300_000;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
class SessionError extends Error { constructor(code, message, retryable = false) { super(message); this.code = code; this.retryable = retryable; } }
const error = (code, message, retryable) => new SessionError(code, message, retryable);

function owner(input) {
    if (!input || !UUID.test(input.principalId) || !UUID.test(input.instanceId)) throw error('NOT_FOUND', 'Session not found');
    return `${input.principalId}:${input.instanceId}:${PIXAI_PROFILE_ID}:node`;
}

function createPluginModelSessionBroker(options) {
    if (!options?.store || typeof options.root !== 'string') throw error('PROVIDER_ERROR', 'Inference provider unavailable');
    const store = options.store, Worker = options.Worker ?? NativeWorker;
    const workerScript = options.workerScript ?? path.join(__dirname, 'pluginModelInferenceWorker.cjs');
    const timer = options.setTimeout ?? setTimeout, clear = options.clearTimeout ?? clearTimeout;
    let worker, workerGeneration = 0, sequence = 0, disposed = false, active, idleTimer;
    const pending = new Map(), leases = new Map(), owners = new Map(), acquiring = new Map(), queue = [], waiting = new Map(), requests = new Map();

    const profile = () => getPixaiProfile(PIXAI_PROFILE_ID);
    async function ready() { for (const artifact of profile().artifacts) if ((await store.stat(artifact.name)).state !== 'verified') return false; return true; }
    function cleanupWorker() { if (idleTimer) { clear(idleTimer); idleTimer = undefined; } }
    function rpc(type, payload = {}, transfer = []) {
        if (disposed) return Promise.reject(error('ABORTED', 'Inference aborted'));
        cleanupWorker();
        if (!worker) {
            try {
                const current = new Worker(workerScript, { workerData: { root: options.root } });
                const generation = ++workerGeneration; worker = current;
                current.on('message', onMessage);
                current.on('error', () => { if (worker === current && workerGeneration === generation) failAll(error('PROVIDER_ERROR', 'Inference provider failed', true)); });
                current.on('exit', (code) => { if (code !== 0 && !disposed && worker === current && workerGeneration === generation) failAll(error('PROVIDER_ERROR', 'Inference provider failed', true)); });
            } catch { return Promise.reject(error('PROVIDER_ERROR', 'Inference provider unavailable', true)); }
        }
        const requestId = `${++sequence}-${crypto.randomUUID()}`;
        const promise = new Promise((resolve, reject) => { requests.set(requestId, { resolve, reject }); try { worker.postMessage({ type, requestId, ...payload }, transfer); } catch { requests.delete(requestId); reject(error('PROVIDER_ERROR', 'Inference provider failed', true)); } });
        promise.requestId = requestId;
        return promise;
    }
    function onMessage(message) { const entry = requests.get(message?.requestId); if (!entry) return; requests.delete(message.requestId); if (message.ok) entry.resolve(message.value); else entry.reject(error(message?.error?.code ?? 'PROVIDER_ERROR', message?.error?.message ?? 'Inference provider failed', message?.error?.code === 'PROVIDER_ERROR')); }
    async function stopWorker() { const current = worker; worker = undefined; workerGeneration += 1; if (!current) return; try { await current.terminate(); } catch {} }
    function failAll(reason) {
        for (const entry of requests.values()) entry.reject(reason); requests.clear();
        if (active && !active.settled) { active.settled = true; active.reject(reason); active = undefined; }
        while (queue.length) { const item = queue.shift(); if (!item.settled) { item.settled = true; item.reject(reason); } }
        waiting.clear(); leases.clear(); owners.clear(); acquiring.clear(); stopWorker();
    }
    function canPurge() { return !leases.size && !acquiring.size && !active && !queue.length; }
    async function maybePurge() { if (!canPurge()) return; for (const [id, entry] of pending) { if (entry.running) continue; entry.running = true; try { entry.resolve(await entry.purge()); } catch (cause) { entry.reject(cause); } finally { pending.delete(id); } } }
    function scheduleIdle() { if (leases.size || acquiring.size || active || queue.length || !worker || idleTimer) return; idleTimer = timer(async () => { idleTimer = undefined; if (!leases.size && !acquiring.size && !active && !queue.length) { try { await rpc('dispose'); } catch {} await stopWorker(); } }, IDLE_MS); }
    function settleQueue() { if (active || !queue.length) return; const item = queue.shift(); const count = waiting.get(item.principalId) ?? 0; if (count <= 1) waiting.delete(item.principalId); else waiting.set(item.principalId, count - 1); active = item; const watchdog = timer(() => { failAll(error('PROVIDER_ERROR', 'Inference provider failed', true)); }, WATCHDOG_MS); item.watchdog = watchdog;
        const image = item.image.buffer.slice(item.image.byteOffset, item.image.byteOffset + item.image.byteLength);
        const execution = rpc('run', { image, options: item.options }, [image]); item.requestId = execution.requestId;
        execution.then((value) => { if (!item.settled) { item.settled = true; item.resolve(value); } }, (reason) => { if (!item.settled) { item.settled = true; item.reject(reason); } }).finally(() => { clear(watchdog); if (active === item) active = undefined; settleQueue(); void maybePurge(); scheduleIdle(); }); }
    function removeQueued(predicate, reason) { for (let index = queue.length - 1; index >= 0; index -= 1) { const item = queue[index]; if (predicate(item)) { queue.splice(index, 1); const count = waiting.get(item.principalId) ?? 0; if (count <= 1) waiting.delete(item.principalId); else waiting.set(item.principalId, count - 1); if (!item.settled) { item.settled = true; item.reject(reason); } } } }
    function live(entry) { return [...entry.clients].some((client) => !client.aborted); }
    function joinAcquire(entry, signal) {
        if (signal?.aborted) return Promise.reject(error('ABORTED', 'Inference aborted'));
        return new Promise((resolve, reject) => {
            const client = { aborted: false, settled: false };
            entry.clients.add(client);
            const abort = () => { if (!client.settled) { client.aborted = true; client.settled = true; reject(error('ABORTED', 'Inference aborted')); } };
            signal?.addEventListener?.('abort', abort, { once: true });
            entry.promise.then((value) => { if (!client.settled) { client.settled = true; resolve(value); } }, (reason) => { if (!client.settled) { client.settled = true; reject(reason); } });
        });
    }
    return Object.freeze({
        async probe(profileId) { if (profileId !== PIXAI_PROFILE_ID) throw error('NOT_FOUND', 'Model profile not found'); let backend = false; try { backend = Boolean((await rpc('probe')).backendAvailable); } catch {} const modelReady = backend && await ready(); scheduleIdle(); return Object.freeze({ backendAvailable: backend, modelReady, reason: backend ? (modelReady ? undefined : 'model-not-ready') : 'runtime-unavailable', providers: Object.freeze({ node: Object.freeze({ available: modelReady }), webgpu: Object.freeze({ available: false }), wasm: Object.freeze({ available: false }) }) }); },
        acquire(input) { if (input?.profileId !== PIXAI_PROFILE_ID || !['auto', 'node', undefined].includes(input.provider)) return Promise.reject(error(input?.provider === 'webgpu' || input?.provider === 'wasm' ? 'UNSUPPORTED' : 'NOT_FOUND', 'Inference provider unavailable')); const key = owner(input); if (input.signal?.aborted) return Promise.reject(error('ABORTED', 'Inference aborted')); if (pending.has(PIXAI_PROFILE_ID)) return Promise.reject(error('CONFLICT', 'Model removal is pending', true)); const old = owners.get(key); if (old) return Promise.resolve({ sessionId: old, provider: 'node' }); let entry = acquiring.get(key); if (!entry) { entry = { clients: new Set(), promise: undefined }; entry.promise = (async () => { if (!await ready()) throw error('NOT_FOUND', 'Model is not ready'); if (!live(entry)) throw error('ABORTED', 'Inference aborted'); await rpc('initialize'); if (!live(entry)) throw error('ABORTED', 'Inference aborted'); const sessionId = crypto.randomUUID(); leases.set(sessionId, { key, principalId: input.principalId, instanceId: input.instanceId }); owners.set(key, sessionId); return Object.freeze({ sessionId, provider: 'node' }); })().finally(() => { acquiring.delete(key); void maybePurge(); scheduleIdle(); }); acquiring.set(key, entry); } return joinAcquire(entry, input.signal); },
        run(input) { let lease; try { lease = leases.get(input?.sessionId); if (!lease || lease.key !== owner(input) || input.profileId !== PIXAI_PROFILE_ID || !Buffer.isBuffer(input.image)) throw error('NOT_FOUND', 'Session not found'); } catch (e) { return Promise.reject(e instanceof SessionError ? e : error('NOT_FOUND', 'Session not found')); } if (input.signal?.aborted) return Promise.reject(error('ABORTED', 'Inference aborted')); return new Promise((resolve, reject) => { const item = { ...input, options: input.options ?? {}, resolve, reject, settled: false }; const abort = () => { if (item.settled) return; if (active === item) { item.settled = true; item.reject(error('ABORTED', 'Inference aborted')); worker?.postMessage({ type: 'abort', requestId: item.requestId }); } else removeQueued((entry) => entry === item, error('ABORTED', 'Inference aborted')); }; input.signal?.addEventListener?.('abort', abort, { once: true }); if (active) { const count = waiting.get(input.principalId) ?? 0; if (count >= 4) { reject(error('RESOURCE_LIMIT', 'Inference queue is full', true)); return; } waiting.set(input.principalId, count + 1); queue.push(item); } else { queue.push(item); settleQueue(); } }); },
        async release(input) { let lease; try { lease = leases.get(input?.sessionId); if (!lease || lease.key !== owner(input) || input.profileId !== PIXAI_PROFILE_ID) throw error('NOT_FOUND', 'Session not found'); } catch (e) { throw e instanceof SessionError ? e : error('NOT_FOUND', 'Session not found'); } leases.delete(input.sessionId); owners.delete(lease.key); removeQueued((item) => item.sessionId === input.sessionId, error('ABORTED', 'Inference aborted')); if (active?.sessionId === input.sessionId) { active.settled = true; active.reject(error('ABORTED', 'Inference aborted')); worker?.postMessage({ type: 'abort', requestId: active.requestId }); } void maybePurge(); scheduleIdle(); },
        async removeWithBarrier(profileId, purge) { if (profileId !== PIXAI_PROFILE_ID) throw error('NOT_FOUND', 'Model profile not found'); let entry = pending.get(profileId); if (!entry) { let resolve, reject; const promise = new Promise((accept, decline) => { resolve = accept; reject = decline; }); entry = { purge, resolve, reject, promise, running: false }; pending.set(profileId, entry); } if (!canPurge()) return Object.freeze({ purgedBytes: 0, pending: true }); void maybePurge(); return entry.promise; },
        isRemovalPending(profileId) { return profileId === PIXAI_PROFILE_ID && pending.has(profileId); },
        async dispose() { if (disposed) return; disposed = true; cleanupWorker(); failAll(error('ABORTED', 'Inference aborted')); await stopWorker(); },
    });
}
module.exports = { createPluginModelSessionBroker, SessionError };

import { createRequire } from 'node:module'
import { EventEmitter } from 'node:events'
import { describe, expect, it, vi } from 'vitest'

const require = createRequire(import.meta.url)
const PROFILE = 'pixai-tagger-v0.9-onnx'
const PRINCIPAL_A = '11111111-1111-4111-8111-111111111111'
const PRINCIPAL_B = '22222222-2222-4222-8222-222222222222'
const INSTANCE_A = '33333333-3333-4333-8333-333333333333'
const INSTANCE_B = '44444444-4444-4444-8444-444444444444'

class FakeWorker extends EventEmitter {
    static created = 0
    terminated = 0
    constructor() { super(); FakeWorker.created += 1 }
    postMessage(message: any) {
        queueMicrotask(() => {
            if (message.type === 'probe') this.emit('message', { requestId: message.requestId, ok: true, value: { backendAvailable: true } })
            if (message.type === 'initialize') this.emit('message', { requestId: message.requestId, ok: true, value: { initialized: true } })
            if (message.type === 'run') this.emit('message', { requestId: message.requestId, ok: true, value: { provider: 'node', tags: [], warnings: [] } })
        })
    }
    async terminate() { this.terminated += 1; return 0 }
}

function store(state = 'verified') {
    return { stat: vi.fn(async () => ({ state, bytes: state === 'verified' ? 1 : 0 })) }
}

function broker(options: Record<string, unknown> = {}) {
    FakeWorker.created = 0
    const { createPluginModelSessionBroker } = require('./pluginModelSessions.cjs')
    return createPluginModelSessionBroker({ store: store(), root: 'C:\\cache', Worker: FakeWorker, ...options })
}

describe('Pocket PixAI session broker', () => {
    it('probes runtime without initializing a model and reports unavailable artifacts separately', async () => {
        const absent = broker({ store: store('absent') })
        await expect(absent.probe(PROFILE)).resolves.toMatchObject({
            backendAvailable: true, modelReady: false, reason: 'model-not-ready',
            providers: { node: { available: false } },
        })
        expect(FakeWorker.created).toBe(1)
        await absent.dispose()
    })

    it('coalesces same-owner acquisition and makes IDs owner-private across release/reacquire', async () => {
        const sessions = broker()
        const owner = { principalId: PRINCIPAL_A, instanceId: INSTANCE_A, profileId: PROFILE, provider: 'auto' }
        const [first, second] = await Promise.all([sessions.acquire(owner), sessions.acquire(owner)])
        expect(first.sessionId).toBe(second.sessionId)
        await expect(sessions.run({ ...owner, provider: 'node', sessionId: first.sessionId, image: Buffer.of(1) })).resolves.toMatchObject({ provider: 'node' })
        await expect(sessions.release({ principalId: PRINCIPAL_B, instanceId: INSTANCE_A, profileId: PROFILE, sessionId: first.sessionId }))
            .rejects.toMatchObject({ code: 'NOT_FOUND' })
        await sessions.release({ principalId: PRINCIPAL_A, instanceId: INSTANCE_A, profileId: PROFILE, sessionId: first.sessionId })
        const later = await sessions.acquire(owner)
        expect(later.sessionId).not.toBe(first.sessionId)
        await sessions.dispose()
    })

    it('defers a removal while leased and executes exactly one purge after the final release', async () => {
        const sessions = broker()
        const owner = { principalId: PRINCIPAL_A, instanceId: INSTANCE_A, profileId: PROFILE, provider: 'node' }
        const lease = await sessions.acquire(owner)
        const purge = vi.fn(async () => ({ purgedBytes: 9 }))
        await expect(sessions.removeWithBarrier(PROFILE, purge)).resolves.toEqual({ purgedBytes: 0, pending: true })
        await expect(sessions.acquire(owner)).rejects.toMatchObject({ code: 'CONFLICT' })
        await sessions.release({ ...owner, sessionId: lease.sessionId })
        await new Promise<void>((resolve) => setImmediate(resolve))
        expect(purge).toHaveBeenCalledTimes(1)
        await sessions.dispose()
    })
})

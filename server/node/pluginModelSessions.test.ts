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

class ManualWorker extends EventEmitter {
    static instances: ManualWorker[] = []
    messages: any[] = []
    replied = new Set<string>()
    constructor() { super(); ManualWorker.instances.push(this) }
    postMessage(message: any) {
        this.messages.push(message)
        if (message.type === 'probe') queueMicrotask(() => this.emit('message', { requestId: message.requestId, ok: true, value: { backendAvailable: true } }))
        if (message.type === 'initialize') queueMicrotask(() => this.emit('message', { requestId: message.requestId, ok: true, value: { initialized: true } }))
    }
    respondRun() { const run = this.messages.find((message) => message.type === 'run' && !this.replied.has(message.requestId)); this.replied.add(run.requestId); this.emit('message', { requestId: run.requestId, ok: true, value: { provider: 'node', tags: [], warnings: [] } }) }
    async terminate() { return 0 }
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

    it('aborts an active caller immediately but holds the physical slot until its Worker reply', async () => {
        ManualWorker.instances = []
        const sessions = broker({ Worker: ManualWorker })
        const owner = { principalId: PRINCIPAL_A, instanceId: INSTANCE_A, profileId: PROFILE, provider: 'node' }
        const lease = await sessions.acquire(owner)
        const controller = new AbortController()
        const first = sessions.run({ ...owner, sessionId: lease.sessionId, image: Buffer.of(1), signal: controller.signal })
        await new Promise<void>((resolve) => setImmediate(resolve))
        controller.abort()
        await expect(first).rejects.toMatchObject({ code: 'ABORTED' })
        const worker = ManualWorker.instances[0]
        expect(worker.messages.some((message) => message.type === 'abort')).toBe(true)
        const second = sessions.run({ ...owner, sessionId: lease.sessionId, image: Buffer.of(2) })
        expect(worker.messages.filter((message) => message.type === 'run')).toHaveLength(1)
        worker.respondRun()
        await new Promise<void>((resolve) => setImmediate(resolve))
        worker.respondRun()
        await expect(second).resolves.toMatchObject({ provider: 'node' })
        await sessions.dispose()
    })

    it('holds a pending removal barrier through an active physical run and its awaited purge', async () => {
        ManualWorker.instances = []
        const sessions = broker({ Worker: ManualWorker })
        const owner = { principalId: PRINCIPAL_A, instanceId: INSTANCE_A, profileId: PROFILE, provider: 'node' }
        const lease = await sessions.acquire(owner)
        const running = sessions.run({ ...owner, sessionId: lease.sessionId, image: Buffer.of(1) })
        await new Promise<void>((resolve) => setImmediate(resolve))
        let finishPurge!: () => void
        const purge = vi.fn(() => new Promise((resolve) => { finishPurge = () => resolve({ purgedBytes: 1 }) }))
        await sessions.removeWithBarrier(PROFILE, purge)
        await sessions.release({ ...owner, sessionId: lease.sessionId })
        expect(purge).not.toHaveBeenCalled()
        await expect(running).rejects.toMatchObject({ code: 'ABORTED' })
        ManualWorker.instances[0].respondRun()
        await new Promise<void>((resolve) => setImmediate(resolve))
        expect(purge).toHaveBeenCalledTimes(1)
        await expect(sessions.acquire(owner)).rejects.toMatchObject({ code: 'CONFLICT' })
        finishPurge()
        await new Promise<void>((resolve) => setImmediate(resolve))
        await sessions.dispose()
    })

    it('schedules idle disposal after probe or failed acquire and cancels it for a new RPC', async () => {
        const callbacks: Array<() => void> = []
        const cleared = vi.fn()
        const absent = broker({
            store: store('absent'),
            setTimeout: (callback: () => void) => { callbacks.push(callback); return callback },
            clearTimeout: cleared,
        })
        await absent.probe(PROFILE)
        await expect(absent.acquire({ principalId: PRINCIPAL_A, instanceId: INSTANCE_A, profileId: PROFILE, provider: 'node' }))
            .rejects.toMatchObject({ code: 'NOT_FOUND' })
        expect(callbacks).toHaveLength(1)
        await absent.probe(PROFILE)
        expect(cleared).toHaveBeenCalled()
        await absent.dispose()
    })

    it('ignores a terminated Worker generation after a replacement is serving sessions', async () => {
        ManualWorker.instances = []
        const sessions = broker({ Worker: ManualWorker })
        await sessions.probe(PROFILE)
        const first = ManualWorker.instances[0]
        first.emit('error', new Error('old sentinel'))
        const owner = { principalId: PRINCIPAL_A, instanceId: INSTANCE_A, profileId: PROFILE, provider: 'node' }
        await sessions.acquire(owner)
        expect(ManualWorker.instances).toHaveLength(2)
        first.emit('error', new Error('late old sentinel'))
        await sessions.acquire({ ...owner, instanceId: INSTANCE_B })
        expect(ManualWorker.instances).toHaveLength(2)
        await sessions.dispose()
    })
})

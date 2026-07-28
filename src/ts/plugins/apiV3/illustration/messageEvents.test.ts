import { describe, expect, it, vi } from 'vitest'

import { PluginApiError } from './errors'
import type { MessageSnapshot } from './messageQuery'
import {
    CommittedMessageEventService,
    type InternalMessageCommit,
    type MessageCommittedEvent,
} from './messageEvents'
import type { PluginExecutionContext, PluginPermissionId } from './permissions'

const context = (instanceId = 'instance-a', principalId = 'principal-a'): PluginExecutionContext => ({
    instanceId,
    principalId,
    displayName: principalId,
    signal: new AbortController().signal,
})

const ref = (messageId: string, conversationId = 'conversation-a') => ({
    characterId: 'character-a',
    conversationId,
    messageId,
})

const snapshot = (commit: InternalMessageCommit, principalId: string): MessageSnapshot => ({
    ...commit.target,
    role: commit.role,
    content: commit.target.messageId,
    revision: commit.revision,
    updatedAt: 1,
    callerPluginState: { metadata: { mine: principalId === 'principal-a' }, attachments: [] },
})

function harness(options: { timeout?: number; maxQueued?: number; maxSubscriptions?: number } = {}) {
    const permissions: PluginPermissionId[] = []
    let id = 0
    const service = new CommittedMessageEventService({
        current: () => ({ characterId: 'character-a', conversationId: 'conversation-a' }),
        requirePermission: async (_context, permission) => { permissions.push(permission) },
        projectSnapshot: async (pluginContext, commit) => snapshot(commit, pluginContext.principalId),
        createId: () => `id-${++id}`,
        callbackTimeoutMs: options.timeout,
        maxQueuedEventsPerSubscription: options.maxQueued,
        maxSubscriptionsPerInstance: options.maxSubscriptions,
    })
    return { service, permissions }
}

const commit = (
    messageId: string,
    overrides: Partial<InternalMessageCommit> = {},
): InternalMessageCommit => ({
    eventId: `event:${messageId}`,
    target: ref(messageId),
    revision: `revision:${messageId}`,
    role: 'char',
    change: 'created',
    cause: 'model',
    durability: 'persisted',
    snapshotSource: Object.freeze({ messageId }),
    ...overrides,
})

const flush = async () => {
    await Promise.resolve()
    await Promise.resolve()
    await Promise.resolve()
}

describe('CommittedMessageEventService', () => {
    it('pins current scope after chatObserve permission and only dispatches matching persisted char commits', async () => {
        const h = harness()
        const received: MessageCommittedEvent[] = []
        await h.service.onMessageCommitted(context(), (event) => { received.push(event) })

        h.service.publish(commit('state', { durability: 'state' }))
        h.service.publish(commit('user', { role: 'user' }))
        h.service.publish(commit('other', { target: ref('other', 'conversation-b') }))
        h.service.publish(commit('match'))
        await flush()

        expect(h.permissions).toEqual(['chatObserve'])
        expect(received).toHaveLength(1)
        expect(received[0]).toMatchObject({ eventId: 'event:match', message: { messageId: 'match' } })
    })

    it('uses chatObserveAll for all scope, filters options, and projects caller-private state at delivery', async () => {
        const h = harness()
        const first: MessageCommittedEvent[] = []
        const second: MessageCommittedEvent[] = []
        await h.service.onMessageCommitted(context('instance-a', 'principal-a'), (event) => { first.push(event) }, {
            scope: 'all', roles: ['char'], causes: ['reroll'], durability: 'state',
        })
        await h.service.onMessageCommitted(context('instance-b', 'principal-b'), (event) => { second.push(event) }, {
            scope: 'all', roles: ['char'], causes: ['reroll'], durability: 'state',
        })
        const source = Object.freeze({ raw: 'one immutable host source' })
        h.service.publish(commit('private', {
            durability: 'state', cause: 'reroll', snapshotSource: source,
            originPlugin: { principalId: 'principal-a', displayName: 'Illustrator' },
        }))
        await flush()

        expect(h.permissions).toEqual(['chatObserveAll', 'chatObserveAll'])
        expect(first[0]).toMatchObject({
            eventId: 'event:private',
            originPlugin: { displayName: 'Illustrator', isCaller: true },
            message: { content: 'private', callerPluginState: { metadata: { mine: true } } },
        })
        expect(second[0]).toMatchObject({
            eventId: 'event:private',
            originPlugin: { displayName: 'Illustrator', isCaller: false },
            message: { content: 'private', callerPluginState: { metadata: { mine: false } } },
        })
        expect(JSON.stringify(first[0])).not.toContain('principal-a')
        expect(JSON.stringify(second[0])).not.toContain('principal-a')
    })

    it('keeps one callback active, drops only the oldest pending item at queue 32, and preserves order', async () => {
        const h = harness({ maxQueued: 32 })
        const seen: string[] = []
        let release!: () => void
        const first = new Promise<void>((resolve) => { release = resolve })
        await h.service.onMessageCommitted(context(), async (event) => {
            seen.push(event.message!.messageId)
            if (event.message!.messageId === 'm1') await first
        })

        for (let index = 1; index <= 35; index++) h.service.publish(commit(`m${index}`))
        await flush()
        expect(seen).toEqual(['m1'])
        release()
        await vi.waitFor(() => expect(seen).toHaveLength(33))
        expect(seen).toEqual(['m1', ...Array.from({ length: 32 }, (_, index) => `m${index + 4}`)])
    })

    it('does not retry a rejected callback and continues sequentially with the next event', async () => {
        const h = harness()
        const seen: string[] = []
        await h.service.onMessageCommitted(context(), async (event) => {
            seen.push(event.message!.messageId)
            if (event.message!.messageId === 'reject') throw new Error('listener failed')
        })
        h.service.publish(commit('reject'))
        h.service.publish(commit('next'))
        await vi.waitFor(() => expect(seen).toEqual(['reject', 'next']))
    })

    it('retires and cancels a timed-out callback so a second callback cannot overlap', async () => {
        vi.useFakeTimers()
        try {
            const h = harness({ timeout: 20 })
            const never = new Promise<void>(() => undefined)
            const listener = Object.assign(vi.fn(() => never), {
                cancelPending: vi.fn(),
                release: vi.fn(),
            })
            const registered = await h.service.onMessageCommitted(context(), listener)
            h.service.publish(commit('active'))
            h.service.publish(commit('queued'))
            await flush()
            await vi.advanceTimersByTimeAsync(20)

            expect(listener).toHaveBeenCalledOnce()
            expect(listener.cancelPending).toHaveBeenCalledOnce()
            expect(listener.release).toHaveBeenCalledOnce()
            expect(h.service.hasSubscription(registered.subscriptionId)).toBe(false)
        } finally {
            vi.useRealTimers()
        }
    })

    it('off and unload drop queued work, release callbacks, and registration is bounded and abort-aware', async () => {
        const h = harness({ maxSubscriptions: 1, timeout: 5 })
        const listener = Object.assign(vi.fn(async () => undefined), {
            cancelPending: vi.fn(), release: vi.fn(),
        })
        const registered = await h.service.onMessageCommitted(context(), listener)
        await expect(h.service.onMessageCommitted(context(), () => undefined)).rejects.toMatchObject({
            code: 'RESOURCE_LIMIT',
        })
        await h.service.offMessageCommitted(context(), registered.subscriptionId)
        h.service.publish(commit('late'))
        await flush()
        expect(listener).not.toHaveBeenCalled()
        expect(listener.release).toHaveBeenCalledOnce()

        const controller = new AbortController()
        controller.abort()
        await expect(h.service.onMessageCommitted({ ...context(), signal: controller.signal }, () => undefined))
            .rejects.toMatchObject({ code: 'ABORTED' })

        const next = Object.assign(vi.fn(async () => undefined), { cancelPending: vi.fn(), release: vi.fn() })
        await h.service.onMessageCommitted(context('instance-b'), next)
        h.service.cleanupInstance('instance-b')
        expect(next.cancelPending).toHaveBeenCalledOnce()
        expect(next.release).toHaveBeenCalledOnce()
    })

    it('off absorbs an active callback rejection and still releases the callback', async () => {
        const h = harness({ timeout: 20 })
        let reject!: (reason: unknown) => void
        const pending = new Promise<void>((_resolve, rejectPromise) => { reject = rejectPromise })
        const listener = Object.assign(vi.fn(() => pending), { cancelPending: vi.fn(), release: vi.fn() })
        const registered = await h.service.onMessageCommitted(context(), listener)
        h.service.publish(commit('active'))
        await flush()

        const off = h.service.offMessageCommitted(context(), registered.subscriptionId)
        reject(new Error('callback failed while off was waiting'))

        await expect(off).resolves.toBeUndefined()
        expect(listener.release).toHaveBeenCalledOnce()
    })

    it('delivers a bounded unavailable sentinel when projection exceeds a snapshot limit', async () => {
        const service = new CommittedMessageEventService({
            current: () => ({ characterId: 'character-a', conversationId: 'conversation-a' }),
            requirePermission: async () => undefined,
            projectSnapshot: async () => {
                throw new PluginApiError('RESOURCE_LIMIT', 'too large', {
                    details: { contentUtf16: 262_145, callerAttachmentCount: 257 },
                })
            },
            createId: () => 'subscription',
        })
        const received: MessageCommittedEvent[] = []
        await service.onMessageCommitted(context(), (event) => { received.push(event) })
        service.publish(commit('huge'))
        await flush()
        expect(received).toEqual([{
            eventId: 'event:huge', change: 'created', cause: 'model', durability: 'persisted',
            unavailable: { ...ref('huge'), reason: 'resource-limit', contentUtf16: 262_145, callerAttachmentCount: 257 },
        }])
    })
})

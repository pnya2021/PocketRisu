import { PluginApiError } from './errors'
import type { MessageRef, MessageSnapshot } from './messageQuery'
import type { PluginExecutionContext, PluginPermissionId } from './permissions'

export const MESSAGE_EVENT_CAPABILITY_IDS = ['chat.message-events.v1'] as const

export type MessageCommitCause = 'user' | 'model' | 'continue' | 'reroll' | 'plugin' | 'trigger' | 'import'
export type MessageCommitDurability = 'state' | 'persisted'

export interface MessageCommittedEventBase {
    eventId: string
    change: 'created' | 'updated'
    cause: MessageCommitCause
    durability: MessageCommitDurability
    originPlugin?: { displayName: string; isCaller: boolean }
}

export type MessageCommittedEvent = MessageCommittedEventBase & (
    | { message: MessageSnapshot; unavailable?: never }
    | {
        message?: never
        unavailable: MessageRef & {
            reason: 'resource-limit'
            contentUtf16: number
            callerAttachmentCount: number
        }
    }
)

export interface InternalMessageCommit {
    eventId: string
    target: MessageRef
    revision: string
    role: 'user' | 'char'
    change: 'created' | 'updated'
    cause: MessageCommitCause
    durability: MessageCommitDurability
    originPlugin?: { principalId: string; displayName: string }
    snapshotSource: unknown
    contentUtf16?: number
    callerAttachmentCount?: number
}

export interface MessageEventOptions {
    scope?: 'current' | 'all'
    roles?: Array<'user' | 'char'>
    causes?: MessageCommitCause[]
    durability?: MessageCommitDurability
}

export type CancellableMessageListener = ((event: MessageCommittedEvent) => void | Promise<void>) & {
    cancelPending?: (reason?: unknown) => void
    release?: () => void
}

type Subscription = {
    id: string
    context: PluginExecutionContext
    listener: CancellableMessageListener
    scope: 'current' | 'all'
    pinned?: { characterId: string; conversationId: string }
    roles: ReadonlySet<'user' | 'char'>
    causes: ReadonlySet<MessageCommitCause>
    durability: MessageCommitDurability
    queue: InternalMessageCommit[]
    draining: boolean
    removed: boolean
    released: boolean
    active?: Promise<void>
}

const ALL_CAUSES: readonly MessageCommitCause[] = [
    'user', 'model', 'continue', 'reroll', 'plugin', 'trigger', 'import',
]
const ALL_ROLES = ['user', 'char'] as const

const enumList = <T extends string>(
    value: unknown,
    fallback: readonly T[],
    allowed: readonly T[],
    label: string,
) => {
    if (value === undefined) return [...fallback]
    if (!Array.isArray(value) || value.length === 0
        || value.some((entry) => typeof entry !== 'string' || !allowed.includes(entry as T))) {
        throw new PluginApiError('INVALID_ARGUMENT', `Invalid ${label}`)
    }
    return [...new Set(value as T[])]
}

const aborted = (): PluginApiError => new PluginApiError('ABORTED', 'Plugin instance is unloaded')

export class CommittedMessageEventService {
    private readonly subscriptions = new Map<string, Subscription>()
    private readonly callbackTimeoutMs: number
    private readonly maxQueued: number
    private readonly maxSubscriptions: number
    private readonly createId: () => string

    constructor(private readonly dependencies: {
        current(): { characterId: string; conversationId: string } | null
        requirePermission(context: PluginExecutionContext, permission: PluginPermissionId): Promise<void>
        projectSnapshot(context: PluginExecutionContext, commit: InternalMessageCommit): Promise<MessageSnapshot>
        createId?: () => string
        callbackTimeoutMs?: number
        maxQueuedEventsPerSubscription?: number
        maxSubscriptionsPerInstance?: number
        diagnostic?: (message: string, details?: Record<string, string | number>) => void
    }) {
        this.callbackTimeoutMs = dependencies.callbackTimeoutMs ?? 30_000
        this.maxQueued = dependencies.maxQueuedEventsPerSubscription ?? 32
        this.maxSubscriptions = dependencies.maxSubscriptionsPerInstance ?? 16
        this.createId = dependencies.createId ?? (() => crypto.randomUUID())
    }

    hasSubscription(subscriptionId: string) {
        return this.subscriptions.has(subscriptionId)
    }

    activeSubscriptionCount(instanceId: string) {
        let count = 0
        for (const subscription of this.subscriptions.values()) {
            if (!subscription.removed && subscription.context.instanceId === instanceId) count++
        }
        return count
    }

    async onMessageCommitted(
        context: PluginExecutionContext,
        listener: CancellableMessageListener,
        options: MessageEventOptions = {},
    ) {
        const releaseOnFailure = () => { try { listener?.release?.() } catch { /* best effort */ } }
        try {
            if (context.signal.aborted) throw aborted()
            if (typeof listener !== 'function') throw new PluginApiError('INVALID_ARGUMENT', 'Listener must be a function')
            const scope = options.scope ?? 'current'
            if (scope !== 'current' && scope !== 'all') {
                throw new PluginApiError('INVALID_ARGUMENT', 'Invalid event scope')
            }
            const durability = options.durability ?? 'persisted'
            if (durability !== 'state' && durability !== 'persisted') {
                throw new PluginApiError('INVALID_ARGUMENT', 'Invalid event durability')
            }
            const roles = new Set<'user' | 'char'>(
                enumList<'user' | 'char'>(options.roles, ['char'], ALL_ROLES, 'roles'),
            )
            const causes = new Set<MessageCommitCause>(
                enumList<MessageCommitCause>(options.causes, ALL_CAUSES, ALL_CAUSES, 'causes'),
            )
            await this.dependencies.requirePermission(context, scope === 'all' ? 'chatObserveAll' : 'chatObserve')
            if (context.signal.aborted) throw aborted()
            const pinned = scope === 'current' ? this.dependencies.current() : null
            if (scope === 'current' && !pinned) {
                throw new PluginApiError('NOT_FOUND', 'No current conversation')
            }
            if (this.activeSubscriptionCount(context.instanceId) >= this.maxSubscriptions) {
                throw new PluginApiError('RESOURCE_LIMIT', 'Event subscription limit exceeded')
            }
            const id = this.createId()
            this.subscriptions.set(id, {
                id,
                context,
                listener,
                scope,
                ...(pinned ? { pinned } : {}),
                roles,
                causes,
                durability,
                queue: [],
                draining: false,
                removed: false,
                released: false,
            })
            return { subscriptionId: id }
        } catch (error) {
            releaseOnFailure()
            throw error
        }
    }

    async offMessageCommitted(context: PluginExecutionContext, subscriptionId: string) {
        if (typeof subscriptionId !== 'string' || subscriptionId.length === 0) {
            throw new PluginApiError('INVALID_ARGUMENT', 'Invalid subscription ID')
        }
        const subscription = this.subscriptions.get(subscriptionId)
        if (!subscription || subscription.context.instanceId !== context.instanceId) return
        subscription.removed = true
        subscription.queue.length = 0
        this.subscriptions.delete(subscriptionId)
        try {
            if (subscription.active && !await this.waitBounded(subscription.active)) {
                this.cancel(subscription)
            }
        } catch {
            // Listener failure is diagnostic-only and cannot prevent resource release.
        } finally {
            this.release(subscription)
        }
    }

    cleanupInstance(instanceId: string) {
        for (const subscription of [...this.subscriptions.values()]) {
            if (subscription.context.instanceId !== instanceId) continue
            subscription.removed = true
            subscription.queue.length = 0
            this.subscriptions.delete(subscription.id)
            this.cancel(subscription)
            this.release(subscription)
        }
    }

    hasMatchingSubscriber(
        commit: Pick<InternalMessageCommit, 'target' | 'role' | 'cause'>,
        durability: MessageCommitDurability,
    ) {
        for (const subscription of this.subscriptions.values()) {
            if (this.matches(subscription, commit, durability)) return true
        }
        return false
    }

    publish(commit: InternalMessageCommit) {
        for (const subscription of this.subscriptions.values()) {
            if (!this.matches(subscription, commit, commit.durability)) continue
            if (subscription.queue.length >= this.maxQueued) {
                subscription.queue.shift()
                this.dependencies.diagnostic?.('Plugin message event queue overflow', {
                    subscriptionId: subscription.id,
                })
            }
            subscription.queue.push(commit)
            void this.drain(subscription)
        }
    }

    private matches(
        subscription: Subscription,
        commit: Pick<InternalMessageCommit, 'target' | 'role' | 'cause'>,
        durability: MessageCommitDurability,
    ) {
        if (subscription.removed || subscription.context.signal.aborted) return false
        if (subscription.durability !== durability
            || !subscription.roles.has(commit.role)
            || !subscription.causes.has(commit.cause)) return false
        return subscription.scope === 'all'
            || (subscription.pinned?.characterId === commit.target.characterId
                && subscription.pinned.conversationId === commit.target.conversationId)
    }

    private async drain(subscription: Subscription) {
        if (subscription.draining || subscription.removed || subscription.active) return
        subscription.draining = true
        try {
            while (!subscription.removed && !subscription.context.signal.aborted && subscription.queue.length > 0) {
                const commit = subscription.queue.shift()!
                const active = this.deliver(subscription, commit)
                subscription.active = active
                let completed = false
                try {
                    completed = await this.waitBounded(active)
                } catch {
                    this.dependencies.diagnostic?.('Plugin message event callback failed', {
                        subscriptionId: subscription.id,
                    })
                    completed = true
                } finally {
                    if (subscription.active === active) subscription.active = undefined
                }
                if (!completed) {
                    subscription.removed = true
                    subscription.queue.length = 0
                    this.subscriptions.delete(subscription.id)
                    this.cancel(subscription)
                    this.release(subscription)
                    this.dependencies.diagnostic?.('Plugin message event delivery timed out', {
                        subscriptionId: subscription.id,
                    })
                    return
                }
            }
        } finally {
            subscription.draining = false
            if (!subscription.removed && !subscription.active && subscription.queue.length > 0) {
                void this.drain(subscription)
            }
        }
    }

    private async deliver(subscription: Subscription, commit: InternalMessageCommit) {
        const base: MessageCommittedEventBase = {
            eventId: commit.eventId,
            change: commit.change,
            cause: commit.cause,
            durability: commit.durability,
        }
        if (commit.originPlugin) {
            base.originPlugin = {
                displayName: commit.originPlugin.displayName,
                isCaller: commit.originPlugin.principalId === subscription.context.principalId,
            }
        }
        let event: MessageCommittedEvent
        try {
            const message = await this.dependencies.projectSnapshot(subscription.context, commit)
            if (message.revision !== commit.revision) return
            event = { ...base, message }
        } catch (error) {
            if (!(error instanceof PluginApiError) || error.code !== 'RESOURCE_LIMIT') return
            event = {
                ...base,
                unavailable: {
                    ...commit.target,
                    reason: 'resource-limit',
                    contentUtf16: typeof error.details?.contentUtf16 === 'number'
                        ? error.details.contentUtf16
                        : commit.contentUtf16 ?? 262_145,
                    callerAttachmentCount: typeof error.details?.callerAttachmentCount === 'number'
                        ? error.details.callerAttachmentCount
                        : commit.callerAttachmentCount ?? 257,
                },
            }
        }
        if (subscription.removed || subscription.context.signal.aborted) return
        await subscription.listener(event)
    }

    private async waitBounded(promise: Promise<unknown>) {
        let timer: ReturnType<typeof setTimeout> | undefined
        try {
            return await Promise.race([
                promise.then(() => true),
                new Promise<false>((resolve) => { timer = setTimeout(() => resolve(false), this.callbackTimeoutMs) }),
            ])
        } finally {
            if (timer !== undefined) clearTimeout(timer)
        }
    }

    private cancel(subscription: Subscription) {
        try { subscription.listener.cancelPending?.(aborted()) } catch { /* best effort */ }
    }

    private release(subscription: Subscription) {
        if (subscription.released) return
        subscription.released = true
        try { subscription.listener.release?.() } catch { /* best effort */ }
    }
}

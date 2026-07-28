import { describe, expect, it, vi } from 'vitest'
import { PluginApiError } from './errors'
import type { PluginExecutionContext, PluginPermissionId } from './permissions'
import {
    MESSAGE_QUERY_CAPABILITY_IDS,
    MessageQueryService,
    type MessageQueryConversation,
    type MessageQueryHostAdapter,
    type MessageQuerySourceMessage,
} from './messageQuery'

const context = () => ({
    principalId: '11111111-1111-4111-8111-111111111111',
    instanceId: 'instance-1',
    displayName: 'Planner',
    signal: new AbortController().signal,
})

const baseMessages = (): MessageQuerySourceMessage[] => [
    { role: 'user', data: 'old user', messageId: 'message-1', createdAt: 10 },
    { role: 'char', data: 'old char', messageId: 'message-2', speakerSourceId: 'member-a', generationId: 'generation-2', createdAt: 20 },
    { role: 'user', data: 'near user', messageId: 'message-3', createdAt: 30 },
    {
        role: 'char',
        data: 'final {{inlay::known}} text {{inlayed::missing}}',
        messageId: 'message-4',
        speakerSourceId: 'member-b',
        generationId: 'generation-4',
        createdAt: 40,
    },
]

function harness(options: {
    messages?: MessageQuerySourceMessage[]
    current?: { characterId: string; conversationId: string } | null
    conversation?: Partial<MessageQueryConversation>
    recognizedInlayIds?: () => Promise<ReadonlySet<string>>
    createRevision?: (value: unknown) => Promise<string>
    signal?: AbortSignal
} = {}) {
    let valid = true
    let current = options.current === undefined
        ? { characterId: 'group-1', conversationId: 'conversation-1' }
        : options.current
    const conversation: MessageQueryConversation = {
        characterId: 'group-1',
        conversationId: 'conversation-1',
        currentCharacterId: 'group-1',
        memberCharacterIds: ['member-a', 'member-b'],
        isStreaming: false,
        messages: options.messages ?? baseMessages(),
        validationToken: {},
        ...options.conversation,
    }
    const requirePermission = vi.fn(async (
        _context: PluginExecutionContext,
        _permission: PluginPermissionId,
    ) => undefined)
    const prepareConversation = vi.fn(async () => undefined)
    const adapter: MessageQueryHostAdapter = {
        current: () => current,
        prepareConversation,
        resolveConversation: (target) => target.characterId === conversation.characterId
            && target.conversationId === conversation.conversationId ? conversation : null,
        isConversationCurrent: (candidate) => valid && candidate === conversation,
        recognizedInlayIds: options.recognizedInlayIds ?? (async () => new Set(['known'])),
    }
    const service = new MessageQueryService(
        { ...context(), ...(options.signal ? { signal: options.signal } : {}) },
        adapter,
        { requirePermission, ...(options.createRevision ? { createRevision: options.createRevision } : {}) },
    )
    return {
        adapter,
        conversation,
        prepareConversation,
        requirePermission,
        service,
        invalidate: () => { valid = false },
        setCurrent: (value: typeof current) => { current = value },
    }
}

const target = (messageId = 'message-4') => ({
    characterId: 'group-1', conversationId: 'conversation-1', messageId,
})

describe('message query core', () => {
    it('owns only the query capability', () => {
        expect(MESSAGE_QUERY_CAPABILITY_IDS).toEqual(['chat.message-query.v1'])
    })

    it('returns one exact marker-free snapshot with stable group attribution and empty caller state', async () => {
        let revisionInput: unknown
        const { service } = harness({
            createRevision: async (value) => {
                revisionInput = value
                return `sha256:${'a'.repeat(64)}`
            },
        })

        await expect(service.getMessageSnapshot(target())).resolves.toEqual({
            characterId: 'group-1',
            conversationId: 'conversation-1',
            messageId: 'message-4',
            role: 'char',
            speakerCharacterId: 'member-b',
            content: 'final  text {{inlayed::missing}}',
            revision: `sha256:${'a'.repeat(64)}`,
            generationId: 'generation-4',
            createdAt: 40,
            updatedAt: 40,
            callerPluginState: { metadata: {}, attachments: [] },
        })
        expect(revisionInput).toEqual({
            role: 'char',
            data: 'final {{inlay::known}} text {{inlayed::missing}}',
            saying: 'member-b',
            generationId: 'generation-4',
        })
    })

    it('hashes persisted empty saying and generation IDs without normalizing revision inputs', async () => {
        let revisionInput: unknown
        const { service } = harness({
            messages: [{
                role: 'char', data: 'empty fields', messageId: 'message-4',
                speakerSourceId: '', generationId: '',
            }],
            createRevision: async (value) => {
                revisionInput = value
                return `sha256:${'c'.repeat(64)}`
            },
        })

        const snapshot = await service.getMessageSnapshot(target())
        expect(revisionInput).toEqual({
            role: 'char', data: 'empty fields', saying: '', generationId: '',
        })
        expect(snapshot).not.toHaveProperty('speakerCharacterId')
        expect(snapshot).not.toHaveProperty('generationId')
    })

    it('exposes a single-character char speaker but never invents a group or user speaker', async () => {
        const single = harness({
            messages: [{ role: 'char', data: 'single', messageId: 'message-4' }],
            conversation: { currentCharacterId: 'character-1', characterId: 'character-1', memberCharacterIds: undefined },
            current: { characterId: 'character-1', conversationId: 'conversation-1' },
        })
        await expect(single.service.getMessageSnapshot({
            characterId: 'character-1', conversationId: 'conversation-1', messageId: 'message-4',
        })).resolves.toMatchObject({ speakerCharacterId: 'character-1' })

        for (const message of [
            { role: 'char', data: 'narrator', messageId: 'message-4' },
            { role: 'char', data: 'legacy', messageId: 'message-4', speakerSourceId: 'removed-member' },
            { role: 'char', data: 'nested', messageId: 'message-4', speakerSourceId: 'nested-group' },
            { role: 'char', data: 'ambiguous', messageId: 'message-4', speakerSourceId: 'duplicate-card' },
            { role: 'user', data: 'user', messageId: 'message-4', speakerSourceId: 'member-a' },
        ] satisfies MessageQuerySourceMessage[]) {
            const snapshot = await harness({ messages: [message] }).service.getMessageSnapshot(target())
            expect(snapshot).not.toHaveProperty('speakerCharacterId')
        }
    })

    it.each([
        ['missing ID', [{ role: 'char', data: 'legacy' }]],
        ['duplicate ID', [
            { role: 'char', data: 'one', messageId: 'message-4' },
            { role: 'char', data: 'two', messageId: 'message-4' },
        ]],
    ])('fails closed for a %s instead of manufacturing an index identity', async (_label, messages) => {
        const { service } = harness({ messages: messages as MessageQuerySourceMessage[] })
        await expect(service.getLatestCommittedMessage()).rejects.toMatchObject({
            name: 'PluginApiError', code: 'CONFLICT', retryable: true,
        })
    })

    it('rejects legacy-index message IDs in exact, latest, and recent queries', async () => {
        const exact = harness({
            messages: [{ role: 'char', data: 'legacy', messageId: 'legacy-message:0' }],
        })
        await expect(exact.service.getMessageSnapshot({
            characterId: 'group-1', conversationId: 'conversation-1', messageId: 'legacy-message:0',
        })).rejects.toMatchObject({ code: 'CONFLICT', retryable: true })
        await expect(exact.service.getLatestCommittedMessage())
            .rejects.toMatchObject({ code: 'CONFLICT', retryable: true })

        const recent = harness({ messages: [
            { role: 'user', data: 'legacy', messageId: 'legacy-message:0' },
            { role: 'char', data: 'before', messageId: 'message-4' },
        ] })
        await expect(recent.service.getRecentCommittedMessages({ before: target() }))
            .rejects.toMatchObject({ code: 'CONFLICT', retryable: true })
    })

    it('defaults latest to the current committed char and skips the streaming final char', async () => {
        const { service } = harness({ conversation: { isStreaming: true } })
        await expect(service.getLatestCommittedMessage()).resolves.toMatchObject({
            messageId: 'message-2', content: 'old char',
        })
    })

    it('supports an explicit role and returns null when no committed match exists', async () => {
        const recognizedInlayIds = vi.fn(async () => new Set<string>())
        const { service } = harness({
            messages: [{ role: 'user', data: 'only', messageId: 'message-1' }],
            recognizedInlayIds,
        })
        await expect(service.getLatestCommittedMessage({ role: 'user' })).resolves.toMatchObject({ messageId: 'message-1' })
        recognizedInlayIds.mockClear()
        await expect(service.getLatestCommittedMessage()).resolves.toBeNull()
        expect(recognizedInlayIds).not.toHaveBeenCalled()
    })

    it('returns exclusive-before nearest messages in chronological order', async () => {
        const { service } = harness()
        await expect(service.getRecentCommittedMessages({ before: target(), limit: 2 })).resolves.toMatchObject({
            items: [
                { messageId: 'message-2', content: 'old char' },
                { messageId: 'message-3', content: 'near user' },
            ],
            truncatedBefore: true,
        })
    })

    it('never truncates a recent message when the nearest one exceeds the remaining UTF-16 budget', async () => {
        const { service } = harness()
        await expect(service.getRecentCommittedMessages({ before: target(), maxTotalUtf16: 4 })).resolves.toEqual({
            items: [], truncatedBefore: true,
        })
    })

    it.each([
        [{ before: target(), limit: 0 }, 'INVALID_ARGUMENT'],
        [{ before: target(), limit: 33 }, 'RESOURCE_LIMIT'],
        [{ before: target(), maxTotalUtf16: 0 }, 'INVALID_ARGUMENT'],
        [{ before: target(), maxTotalUtf16: 65_537 }, 'RESOURCE_LIMIT'],
        [{ before: target(), roles: [] }, 'INVALID_ARGUMENT'],
        [{ before: target(), roles: ['system'] }, 'INVALID_ARGUMENT'],
    ])('validates bounded recent options %#', async (input, code) => {
        await expect(harness().service.getRecentCommittedMessages(input as never))
            .rejects.toMatchObject({ name: 'PluginApiError', code })
    })

    it('rejects complete snapshots over the logical UTF-16 limit instead of truncating', async () => {
        const { service } = harness({
            messages: [{ role: 'char', data: 'x'.repeat(262_145), messageId: 'message-4' }],
        })
        await expect(service.getMessageSnapshot(target())).rejects.toMatchObject({
            name: 'PluginApiError', code: 'RESOURCE_LIMIT',
        })
    })

    it('requires current observation for current queries and all-conversation observation for explicit non-current queries', async () => {
        const currentQuery = harness()
        await currentQuery.service.getMessageSnapshot(target())
        expect(currentQuery.requirePermission).toHaveBeenCalledWith(expect.anything(), 'chatObserve')

        const otherQuery = harness({ current: { characterId: 'other', conversationId: 'elsewhere' } })
        await otherQuery.service.getMessageSnapshot(target())
        expect(otherQuery.requirePermission).toHaveBeenCalledWith(expect.anything(), 'chatObserveAll')
    })

    it('upgrades to all-conversation permission when current scope changes during permission await', async () => {
        let release!: () => void
        const gate = new Promise<void>((resolve) => { release = resolve })
        const state = harness()
        state.requirePermission.mockImplementationOnce(async () => gate)

        const pending = state.service.getMessageSnapshot(target())
        await vi.waitFor(() => expect(state.requirePermission).toHaveBeenCalledTimes(1))
        state.setCurrent({ characterId: 'other', conversationId: 'elsewhere' })
        release()

        await expect(pending).resolves.toMatchObject({ messageId: 'message-4' })
        expect(state.requirePermission.mock.calls.map((call) => call[1])).toEqual(['chatObserve', 'chatObserveAll'])
    })

    it('revalidates the captured conversation when a scope-upgrade permission await rejects', async () => {
        let state!: ReturnType<typeof harness>
        state = harness({ recognizedInlayIds: async () => {
            state.setCurrent({ characterId: 'other', conversationId: 'elsewhere' })
            return new Set()
        } })
        state.requirePermission.mockImplementation(async (_context, permission) => {
            if (permission === 'chatObserveAll') {
                state.invalidate()
                throw new PluginApiError('PERMISSION_DENIED', 'denied')
            }
        })

        await expect(state.service.getMessageSnapshot(target())).rejects.toMatchObject({
            code: 'CONFLICT', retryable: true,
        })
    })

    it('rejects aborts before and after async Host boundaries', async () => {
        const before = new AbortController()
        before.abort()
        await expect(harness({ signal: before.signal }).service.getMessageSnapshot(target()))
            .rejects.toMatchObject({ name: 'PluginApiError', code: 'ABORTED' })

        const after = new AbortController()
        const state = harness({
            signal: after.signal,
            recognizedInlayIds: async () => {
                after.abort()
                return new Set()
            },
        })
        await expect(state.service.getMessageSnapshot(target()))
            .rejects.toMatchObject({ name: 'PluginApiError', code: 'ABORTED' })

        const hydrationAbort = new AbortController()
        const hydration = harness({ signal: hydrationAbort.signal })
        hydration.prepareConversation.mockImplementation(async () => {
            hydrationAbort.abort()
            throw new PluginApiError('CONFLICT', 'hydration failed', { retryable: true })
        })
        await expect(hydration.service.getMessageSnapshot(target()))
            .rejects.toMatchObject({ name: 'PluginApiError', code: 'ABORTED' })

        const permissionAbort = new AbortController()
        const permission = harness({ signal: permissionAbort.signal })
        permission.requirePermission.mockImplementation(async () => {
            permissionAbort.abort()
            throw new PluginApiError('PERMISSION_DENIED', 'denied')
        })
        await expect(permission.service.getMessageSnapshot(target()))
            .rejects.toMatchObject({ name: 'PluginApiError', code: 'ABORTED' })
    })

    it('rejects a changed root/source after Inlay enumeration or revision hashing', async () => {
        let first!: ReturnType<typeof harness>
        first = harness({ recognizedInlayIds: async () => {
            first.invalidate()
            return new Set()
        } })
        await expect(first.service.getMessageSnapshot(target())).rejects.toMatchObject({
            name: 'PluginApiError', code: 'CONFLICT', retryable: true,
        })

        let second!: ReturnType<typeof harness>
        second = harness({ createRevision: async () => {
            second.invalidate()
            return `sha256:${'b'.repeat(64)}`
        } })
        await expect(second.service.getMessageSnapshot(target())).rejects.toMatchObject({
            name: 'PluginApiError', code: 'CONFLICT', retryable: true,
        })
    })

    it('revalidates abort and source epochs when async dependencies reject', async () => {
        let recognizedChanged!: ReturnType<typeof harness>
        recognizedChanged = harness({ recognizedInlayIds: async () => {
            recognizedChanged.invalidate()
            throw new PluginApiError('INTERNAL', 'redacted storage failure', { retryable: true })
        } })
        await expect(recognizedChanged.service.getMessageSnapshot(target())).rejects.toMatchObject({
            code: 'CONFLICT', retryable: true,
        })

        const aborted = new AbortController()
        const recognizedAborted = harness({ signal: aborted.signal, recognizedInlayIds: async () => {
            aborted.abort()
            throw new PluginApiError('INTERNAL', 'redacted storage failure', { retryable: true })
        } })
        await expect(recognizedAborted.service.getMessageSnapshot(target())).rejects.toMatchObject({ code: 'ABORTED' })

        let revisionChanged!: ReturnType<typeof harness>
        revisionChanged = harness({ createRevision: async () => {
            revisionChanged.invalidate()
            throw new PluginApiError('INTERNAL', 'redacted revision failure', { retryable: true })
        } })
        await expect(revisionChanged.service.getMessageSnapshot(target())).rejects.toMatchObject({
            code: 'CONFLICT', retryable: true,
        })

        const stable = harness({ recognizedInlayIds: async () => {
            throw new PluginApiError('INTERNAL', 'redacted storage failure', { retryable: true })
        } })
        await expect(stable.service.getMessageSnapshot(target())).rejects.toMatchObject({
            code: 'INTERNAL', message: 'redacted storage failure', retryable: true,
        })
    })

    it('rejects exact access to an in-progress final char entry', async () => {
        const { service } = harness({ conversation: { isStreaming: true } })
        await expect(service.getMessageSnapshot(target())).rejects.toMatchObject({
            name: 'PluginApiError', code: 'CONFLICT', retryable: true,
        })
        await expect(service.getRecentCommittedMessages({ before: target() })).rejects.toMatchObject({
            name: 'PluginApiError', code: 'CONFLICT', retryable: true,
        })
    })

    it('uses the platform hydration boundary before resolving a conversation', async () => {
        const { service, prepareConversation } = harness()
        await service.getMessageSnapshot(target())
        expect(prepareConversation).toHaveBeenCalledWith({
            characterId: 'group-1', conversationId: 'conversation-1',
        })
    })

    it('preserves typed Plugin API errors from permission checks', async () => {
        const state = harness()
        state.requirePermission.mockRejectedValue(new PluginApiError('PERMISSION_DENIED', 'denied'))
        await expect(state.service.getMessageSnapshot(target())).rejects.toMatchObject({ code: 'PERMISSION_DENIED' })
    })
})

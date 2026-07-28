import { describe, expect, it, vi } from 'vitest'
import { createPocketMessagePatchAdapter } from './messagePatch.pocket'
import { PluginApiError } from './errors'

const request = {
    principalId: 'plugin-a',
    argumentDigest: 'a'.repeat(64),
    signal: new AbortController().signal,
    input: {
        target: { characterId: 'character-1', conversationId: 'conversation-1', messageId: 'message-1' },
        expectedRevision: 'sha256:before',
        patch: { op: 'setPluginMetadata' as const, key: 'ledger', value: { prefix: 1 } },
        idempotencyKey: 'ledger-1',
        persist: 'immediate' as const,
    },
}

const harness = (options: {
    chat?: any
    currentCharacter?: any
} = {}) => {
    const chat: any = options.chat ?? {
        id: 'conversation-1', name: 'Chat', note: '', localLore: [],
        message: [{ role: 'char', data: 'hello', saying: undefined, chatId: 'message-1', time: 1 }],
    }
    const character: any = options.currentCharacter ?? {
        chaId: 'character-1', type: 'character', chatPage: 0, chats: [chat],
    }
    const database: any = { characters: [character] }
    const liveSlotsObservedAtSave: any[] = []
    const saveChatToServer = vi.fn(async (_characterId: string, _index: number, _chatId: string, staged: any) => {
        liveSlotsObservedAtSave.push(character.chats[0])
        expect(staged).not.toBe(character.chats[0])
    })
    const dependencies = {
        getDatabase: vi.fn(() => database),
        getCurrentCharacter: vi.fn(() => character),
        ensureChatHydrated: vi.fn(async () => character.chats[0]),
        saveChatToServer,
        runExclusiveMutation: <T>(operation: () => T | Promise<T>) => Promise.resolve().then(operation),
        listInlayKeys: vi.fn(async () => [] as string[]),
        createRevision: vi.fn(async (value: any) => Object.keys(value.pluginMessageState ?? {}).length === 0
            ? 'sha256:before'
            : 'sha256:after'),
        createId: vi.fn(() => 'commit-1'),
        now: vi.fn(() => 2),
    }
    return {
        adapter: createPocketMessagePatchAdapter(dependencies), chat, character, dependencies,
        liveSlotsObservedAtSave,
    }
}

describe('Pocket current-message metadata persistence', () => {
    it('stages metadata and its receipt in one Chat save before swapping the live slot', async () => {
        const { adapter, chat, character, dependencies, liveSlotsObservedAtSave } = harness()

        await expect(adapter.patchCurrentMessage(request)).resolves.toMatchObject({
            changed: true,
            commitId: 'commit-1',
            message: {
                revision: 'sha256:after',
                callerPluginState: { metadata: { ledger: { prefix: 1 } }, attachments: [] },
            },
        })
        expect(dependencies.saveChatToServer).toHaveBeenCalledTimes(1)
        expect(liveSlotsObservedAtSave).toEqual([chat])
        expect(chat.message[0].pluginMessageState).toBeUndefined()
        expect(character.chats[0]).not.toBe(chat)
        expect(character.chats[0].message[0].pluginMessageState['plugin-a'].metadata)
            .toEqual({ ledger: { prefix: 1 } })
        expect(character.chats[0].pluginMessagePatchReceipts).toHaveLength(1)
    })

    it.each([
        ['message deletion', (chat: any) => { chat.message = [] }],
        ['streaming transition', (chat: any) => { chat.isStreaming = true }],
    ])('replays a persisted receipt before live validation after %s', async (_label, mutate) => {
        const { adapter, character, dependencies } = harness()
        const first = await adapter.patchCurrentMessage(request)
        mutate(character.chats[0])
        const restarted = createPocketMessagePatchAdapter(dependencies)

        await expect(restarted.patchCurrentMessage(request)).resolves.toEqual(first)
        await expect(restarted.patchCurrentMessage({
            ...request,
            argumentDigest: 'f'.repeat(64),
        })).rejects.toMatchObject({ code: 'CONFLICT', message: 'Idempotency key arguments conflict' })
        expect(dependencies.saveChatToServer).toHaveBeenCalledTimes(1)
        expect(character.chats[0].pluginMessagePatchReceipts).toHaveLength(1)
    })

    it('does not expose staged metadata when the acknowledged save rejects', async () => {
        const { adapter, chat, character, dependencies } = harness()
        dependencies.saveChatToServer.mockRejectedValueOnce(new Error('offline'))

        await expect(adapter.patchCurrentMessage(request)).rejects.toMatchObject({
            code: 'INTERNAL', message: 'Message persistence dependency failed', retryable: true,
        })
        expect(character.chats[0]).toBe(chat)
        expect(chat.message[0].pluginMessageState).toBeUndefined()
        expect(chat.pluginMessagePatchReceipts).toBeUndefined()
    })

    it('persists a no-op receipt without changing the message revision', async () => {
        const { adapter, character, dependencies } = harness()
        await adapter.patchCurrentMessage(request)
        const noOp = {
            ...request,
            argumentDigest: 'b'.repeat(64),
            input: { ...request.input, expectedRevision: 'sha256:after', idempotencyKey: 'ledger-2' },
        }

        await expect(adapter.patchCurrentMessage(noOp)).resolves.toMatchObject({
            changed: false,
            message: { revision: 'sha256:after' },
        })
        expect(dependencies.saveChatToServer).toHaveBeenCalledTimes(2)
        expect(character.chats[0].pluginMessagePatchReceipts).toHaveLength(2)
    })

    it('preserves foreign state and never projects persisted attachments', async () => {
        const state = harness()
        state.chat.message[0].pluginMessageState = {
            'foreign-plugin': { metadata: { private: true }, attachments: [{ inlayId: 'foreign' }] },
            'plugin-a': { metadata: {}, attachments: [{ inlayId: 'future-own', metadata: { hidden: true } }] },
        }

        const result = await state.adapter.patchCurrentMessage({
            ...request,
            input: { ...request.input, expectedRevision: 'sha256:after' },
        })
        expect(result.message.callerPluginState).toEqual({
            metadata: { ledger: { prefix: 1 } }, attachments: [],
        })
        expect(state.character.chats[0].message[0].pluginMessageState['foreign-plugin'])
            .toEqual({ metadata: { private: true }, attachments: [{ inlayId: 'foreign' }] })
    })

    it('uses the shared query projection for known caller attachments', async () => {
        const state = harness()
        state.chat.message[0].data = 'a{{inlay::known}}b'
        state.chat.message[0].pluginMessageState = {
            'plugin-a': {
                metadata: {},
                attachments: [{ inlayId: 'known', presentation: 'inline', metadata: { alt: 'own' } }],
            },
            foreign: {
                metadata: {},
                attachments: [{ inlayId: 'known', presentation: 'inline', metadata: { secret: true } }],
            },
        }
        state.dependencies.listInlayKeys.mockResolvedValue(['known'])

        const result = await state.adapter.patchCurrentMessage({
            ...request,
            input: { ...request.input, expectedRevision: 'sha256:after' },
        })

        expect(result.message.content).toBe('ab')
        expect(result.message.callerPluginState.attachments).toEqual([
            { inlayId: 'known', presentation: 'inline', utf16Offset: 1, metadata: { alt: 'own' } },
        ])
    })

    it('enforces stale, missing, duplicate, and streaming message conflicts', async () => {
        const stale = harness()
        await expect(stale.adapter.patchCurrentMessage({
            ...request, input: { ...request.input, expectedRevision: 'sha256:stale' },
        })).rejects.toMatchObject({ code: 'CONFLICT' })

        for (const chat of [
            { id: 'conversation-1', name: '', note: '', localLore: [], message: [] },
            {
                id: 'conversation-1', name: '', note: '', localLore: [],
                message: [
                    { role: 'char', data: 'a', chatId: 'message-1' },
                    { role: 'char', data: 'b', chatId: 'message-1' },
                ],
            },
            {
                id: 'conversation-1', name: '', note: '', localLore: [], isStreaming: true,
                message: [{ role: 'char', data: 'a', chatId: 'message-1' }],
            },
        ]) {
            await expect(harness({ chat }).adapter.patchCurrentMessage(request))
                .rejects.toMatchObject({ code: chat.message.length === 0 ? 'NOT_FOUND' : 'CONFLICT' })
        }
    })

    it('accepts the sixteenth metadata key and rejects the seventeenth', async () => {
        const state = harness()
        state.chat.message[0].pluginMessageState = {
            'plugin-a': {
                metadata: Object.fromEntries(Array.from({ length: 15 }, (_, index) => [`key-${index}`, index])),
                attachments: [],
            },
        }
        const sixteenth = {
            ...request,
            input: {
                ...request.input,
                expectedRevision: 'sha256:after',
                patch: { op: 'setPluginMetadata' as const, key: 'key-15', value: 15 },
            },
        }
        await expect(state.adapter.patchCurrentMessage(sixteenth)).resolves.toMatchObject({ changed: true })
        await expect(state.adapter.patchCurrentMessage({
            ...sixteenth,
            argumentDigest: 'c'.repeat(64),
            input: {
                ...sixteenth.input,
                idempotencyKey: 'key-17',
                patch: { op: 'setPluginMetadata' as const, key: 'key-16', value: 16 },
            },
        })).rejects.toMatchObject({ code: 'RESOURCE_LIMIT' })
    })

    it('accepts 65,536 combined metadata bytes and rejects one byte over', async () => {
        const exact = harness()
        await expect(exact.adapter.patchCurrentMessage({
            ...request,
            input: {
                ...request.input,
                patch: { op: 'setPluginMetadata', key: 'ledger', value: 'x'.repeat(65_493) },
            },
        })).resolves.toMatchObject({ changed: true })

        const over = harness()
        await expect(over.adapter.patchCurrentMessage({
            ...request,
            input: {
                ...request.input,
                patch: { op: 'setPluginMetadata', key: 'ledger', value: 'x'.repeat(65_494) },
            },
        })).rejects.toMatchObject({ code: 'RESOURCE_LIMIT' })
    })

    it.each([
        [256, undefined],
        [257, 'RESOURCE_LIMIT'],
    ])('accepts 256 caller attachments and rejects 257', async (count, expectedCode) => {
        const state = harness()
        state.chat.message[0].pluginMessageState = {
            'plugin-a': {
                metadata: {},
                attachments: Array.from({ length: count }, (_, index) => ({
                    inlayId: `known-${index}`, presentation: 'inline', metadata: {},
                })),
            },
        }
        const pending = state.adapter.patchCurrentMessage({
            ...request,
            input: { ...request.input, expectedRevision: 'sha256:after' },
        })

        if (expectedCode) await expect(pending).rejects.toMatchObject({ code: expectedCode })
        else await expect(pending).resolves.toMatchObject({ changed: true })
    })

    it('conflicts after save acknowledgement when the live source changes and does not swap the slot', async () => {
        const state = harness()
        state.dependencies.saveChatToServer.mockImplementationOnce(async () => {
            state.chat.message[0].time = 99
        })

        await expect(state.adapter.patchCurrentMessage(request)).rejects.toMatchObject({ code: 'CONFLICT' })
        expect(state.character.chats[0]).toBe(state.chat)
        expect(state.chat.message[0].pluginMessageState).toBeUndefined()
    })

    it.each(['revision', 'inlay', 'save'] as const)(
        'prioritizes a changed source over a rejecting %s dependency',
        async (boundary) => {
            const state = harness()
            const rejectAfterMutation = async () => {
                state.chat.message[0].time = 99
                throw new PluginApiError('NETWORK', `private ${boundary} failure`, { retryable: true })
            }
            if (boundary === 'revision') state.dependencies.createRevision.mockImplementationOnce(rejectAfterMutation)
            if (boundary === 'inlay') state.dependencies.listInlayKeys.mockImplementationOnce(rejectAfterMutation as never)
            if (boundary === 'save') state.dependencies.saveChatToServer.mockImplementationOnce(rejectAfterMutation)

            await expect(state.adapter.patchCurrentMessage(request)).rejects.toMatchObject({
                code: 'CONFLICT', retryable: true,
            })
            expect(state.character.chats[0]).toBe(state.chat)
        },
    )

    it.each(['hydration', 'revision', 'inlay', 'save'] as const)(
        'preserves a typed rejection from a stable %s dependency',
        async (boundary) => {
            const state = harness()
            const failure = new PluginApiError('NETWORK', `stable ${boundary} failure`, { retryable: true })
            if (boundary === 'hydration') state.dependencies.ensureChatHydrated.mockRejectedValueOnce(failure)
            if (boundary === 'revision') state.dependencies.createRevision.mockRejectedValueOnce(failure)
            if (boundary === 'inlay') state.dependencies.listInlayKeys.mockRejectedValueOnce(failure)
            if (boundary === 'save') state.dependencies.saveChatToServer.mockRejectedValueOnce(failure)

            await expect(state.adapter.patchCurrentMessage(request)).rejects.toMatchObject({
                code: 'NETWORK', message: `stable ${boundary} failure`, retryable: true,
            })
        },
    )

    it.each(['revision', 'inlay', 'save'] as const)(
        'gives abort priority when a rejecting %s dependency aborts the call',
        async (boundary) => {
            const controller = new AbortController()
            const state = harness()
            const rejectAfterAbort = async () => {
                controller.abort()
                throw new PluginApiError('NETWORK', `private ${boundary} failure`, { retryable: true })
            }
            if (boundary === 'revision') state.dependencies.createRevision.mockImplementationOnce(rejectAfterAbort)
            if (boundary === 'inlay') state.dependencies.listInlayKeys.mockImplementationOnce(rejectAfterAbort as never)
            if (boundary === 'save') state.dependencies.saveChatToServer.mockImplementationOnce(rejectAfterAbort)

            await expect(state.adapter.patchCurrentMessage({
                ...request, signal: controller.signal,
            })).rejects.toMatchObject({ code: 'ABORTED' })
        },
    )
})

import { describe, expect, it, vi } from 'vitest'
import { createPocketMessageQueryAdapter } from './messageQuery.pocket'

const fullChat = (overrides: Record<string, unknown> = {}) => ({
    id: 'conversation-2',
    name: 'Other',
    message: [{
        role: 'char', data: 'hello', saying: 'member-a', chatId: 'message-1', time: 50,
        generationInfo: { generationId: 'generation-1' },
    }],
    ...overrides,
})

function harness(options: { placeholder?: boolean } = { placeholder: true }) {
    const targetSlot = options.placeholder === false
        ? fullChat()
        : { id: 'conversation-2', name: 'Other', message: [], _placeholder: true }
    let database: any = {
        characters: [
            { type: 'character', chaId: 'current-character', chatPage: 0, chats: [{ id: 'conversation-1', message: [] }] },
            { type: 'group', chaId: 'group-1', characters: ['member-a', 'member-b'], chatPage: 0, chats: [targetSlot] },
            { type: 'character', chaId: 'member-a' },
            { type: 'character', chaId: 'member-b' },
        ],
    }
    let currentCharacter = database.characters[0]
    const ensureChatHydrated = vi.fn(async (chats: any[], index: number) => {
        if (chats[index]?._placeholder) chats[index] = fullChat()
        return chats[index]
    })
    const listInlayKeys = vi.fn(async () => ['known', 'second'])
    const dependencies = {
        getDatabase: vi.fn(() => database),
        getCurrentCharacter: vi.fn(() => currentCharacter),
        ensureChatHydrated,
        listInlayKeys,
    }
    return {
        adapter: createPocketMessageQueryAdapter(dependencies),
        dependencies,
        get database() { return database },
        replaceDatabase: (value: any) => { database = value },
        setCurrentCharacter: (value: any) => { currentCharacter = value },
    }
}

describe('Pocket message-query adapter', () => {
    it('hydrates an explicit non-current slot and projects stable IDs without using legacy indices', async () => {
        const state = harness()
        await state.adapter.prepareConversation({ characterId: 'group-1', conversationId: 'conversation-2' })

        expect(state.dependencies.ensureChatHydrated).toHaveBeenCalledWith(
            state.database.characters[1].chats,
            0,
            'group-1',
        )
        expect(state.adapter.current()).toEqual({
            characterId: 'current-character', conversationId: 'conversation-1',
        })
        const captured = state.adapter.resolveConversation({ characterId: 'group-1', conversationId: 'conversation-2' })
        expect(captured).toMatchObject({
            characterId: 'group-1',
            conversationId: 'conversation-2',
            currentCharacterId: 'group-1',
            memberCharacterIds: ['member-a', 'member-b'],
            messages: [{
                role: 'char',
                data: 'hello',
                speakerSourceId: 'member-a',
                messageId: 'message-1',
                generationId: 'generation-1',
                createdAt: 50,
            }],
        })
        expect(captured && state.adapter.isConversationCurrent(captured)).toBe(true)
    })

    it('passes an already hydrated current slot through the same explicit hydration boundary', async () => {
        const state = harness({ placeholder: false })
        state.setCurrentCharacter(state.database.characters[1])

        await state.adapter.prepareConversation({ characterId: 'group-1', conversationId: 'conversation-2' })

        expect(state.dependencies.ensureChatHydrated).toHaveBeenCalledWith(
            state.database.characters[1].chats, 0, 'group-1',
        )
    })

    it('publishes only uniquely resolved ordinary member-card IDs', async () => {
        const state = harness()
        state.database.characters[1].characters = ['member-a', 'missing-card', 'nested-group', 'duplicate-card']
        state.database.characters.push(
            { type: 'group', chaId: 'nested-group', characters: [] },
            { type: 'character', chaId: 'duplicate-card' },
            { type: 'character', chaId: 'duplicate-card' },
        )
        await state.adapter.prepareConversation({ characterId: 'group-1', conversationId: 'conversation-2' })

        const captured = state.adapter.resolveConversation({ characterId: 'group-1', conversationId: 'conversation-2' })
        expect(captured?.memberCharacterIds).toEqual(['member-a'])
    })

    it('enumerates recognized Inlays through the key-only path', async () => {
        const state = harness()
        await expect(state.adapter.recognizedInlayIds()).resolves.toEqual(new Set(['known', 'second']))
        expect(state.dependencies.listInlayKeys).toHaveBeenCalledTimes(1)
    })

    it.each([
        ['null hydration', async () => null],
        ['remaining placeholder', async (chats: any[], index: number) => chats[index]],
        ['wrong returned slot', async () => fullChat({ id: 'replacement' })],
    ])('fails closed on %s', async (_label, hydrate) => {
        const state = harness()
        state.dependencies.ensureChatHydrated.mockImplementation(hydrate as never)
        await expect(state.adapter.prepareConversation({ characterId: 'group-1', conversationId: 'conversation-2' }))
            .rejects.toMatchObject({ name: 'PluginApiError', code: 'CONFLICT', retryable: true })
    })

    it('fails closed when the database root is replaced during hydration', async () => {
        const state = harness()
        state.dependencies.ensureChatHydrated.mockImplementation(async (chats: any[], index: number) => {
            chats[index] = fullChat()
            const hydrated = chats[index]
            state.replaceDatabase(structuredClone(state.database))
            return hydrated
        })

        await expect(state.adapter.prepareConversation({ characterId: 'group-1', conversationId: 'conversation-2' }))
            .rejects.toMatchObject({ name: 'PluginApiError', code: 'CONFLICT', retryable: true })
    })

    it('fails closed when a hydrated slot is replaced after hydration', async () => {
        const state = harness()
        state.dependencies.ensureChatHydrated.mockImplementation(async (chats: any[], index: number) => {
            chats[index] = fullChat()
            const hydrated = chats[index]
            chats[index] = structuredClone(hydrated)
            return hydrated
        })

        await expect(state.adapter.prepareConversation({ characterId: 'group-1', conversationId: 'conversation-2' }))
            .rejects.toMatchObject({ name: 'PluginApiError', code: 'CONFLICT', retryable: true })
    })

    it('reports a retryable conflict when the target slot disappears during hydration', async () => {
        const state = harness()
        state.dependencies.ensureChatHydrated.mockImplementation(async (chats: any[], index: number) => {
            const hydrated = fullChat()
            chats.splice(index, 1)
            return hydrated
        })

        await expect(state.adapter.prepareConversation({ characterId: 'group-1', conversationId: 'conversation-2' }))
            .rejects.toMatchObject({ name: 'PluginApiError', code: 'CONFLICT', retryable: true })
    })

    it('invalidates a capture after root, chat, message array, index, or canonical message changes', async () => {
        for (const mutate of [
            (state: ReturnType<typeof harness>) => state.replaceDatabase(structuredClone(state.database)),
            (state: ReturnType<typeof harness>) => {
                state.database.characters[1].chats[0] = structuredClone(state.database.characters[1].chats[0])
            },
            (state: ReturnType<typeof harness>) => {
                state.database.characters[1].chats[0].message = [...state.database.characters[1].chats[0].message]
            },
            (state: ReturnType<typeof harness>) => {
                state.database.characters[1].chats.unshift({ id: 'conversation-new', message: [] })
            },
            (state: ReturnType<typeof harness>) => {
                state.database.characters[1].chats[0].message[0].data = 'changed'
            },
            (state: ReturnType<typeof harness>) => {
                state.database.characters[1].characters.reverse()
            },
            (state: ReturnType<typeof harness>) => {
                state.database.characters[1].chaId = 'changed-character'
            },
        ]) {
            const state = harness()
            await state.adapter.prepareConversation({ characterId: 'group-1', conversationId: 'conversation-2' })
            const captured = state.adapter.resolveConversation({ characterId: 'group-1', conversationId: 'conversation-2' })!
            mutate(state)
            expect(state.adapter.isConversationCurrent(captured)).toBe(false)
        }
    })

    it('invalidates resolved membership when a member card is deleted, replaced, or made ambiguous', async () => {
        for (const mutate of [
            (state: ReturnType<typeof harness>, index: number) => state.database.characters.splice(index, 1),
            (state: ReturnType<typeof harness>, index: number) => {
                state.database.characters[index] = structuredClone(state.database.characters[index])
            },
            (state: ReturnType<typeof harness>, index: number) => {
                state.database.characters.push(structuredClone(state.database.characters[index]))
            },
        ]) {
            const state = harness()
            await state.adapter.prepareConversation({ characterId: 'group-1', conversationId: 'conversation-2' })
            const captured = state.adapter.resolveConversation({ characterId: 'group-1', conversationId: 'conversation-2' })!
            const memberIndex = state.database.characters.findIndex((candidate: any) => candidate.chaId === 'member-a')
            mutate(state, memberIndex)
            expect(state.adapter.isConversationCurrent(captured)).toBe(false)
        }
    })

    it('rejects missing and duplicate stable character or conversation IDs', async () => {
        const missing = harness()
        await expect(missing.adapter.prepareConversation({ characterId: 'missing', conversationId: 'conversation-2' }))
            .rejects.toMatchObject({ code: 'NOT_FOUND' })

        const duplicate = harness()
        duplicate.database.characters.push(duplicate.database.characters[1])
        await expect(duplicate.adapter.prepareConversation({ characterId: 'group-1', conversationId: 'conversation-2' }))
            .rejects.toMatchObject({ code: 'CONFLICT', retryable: true })
    })
})

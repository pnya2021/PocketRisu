import { describe, expect, it, vi } from 'vitest'
import { PluginApiError } from './errors'
import { deterministicAtomicInlayId } from './inlayLifecycle'
import type { InlayAtomicAttachInput, PreparedInlayAtomicAttach } from './inlayAtomicAttach'
import {
    createPocketInlayAtomicAttachAdapter,
    type PocketInlayAtomicAttachDependencies,
} from './inlayAtomicAttach.pocket'

const target = {
    characterId: 'character-1', conversationId: 'conversation-1', messageId: 'message-1',
}

const input = (overrides: Partial<InlayAtomicAttachInput> = {}): InlayAtomicAttachInput => ({
    target,
    expectedMessageRevision: 'sha256:before',
    data: Uint8Array.of(1, 2, 3),
    inlay: { name: 'slot.png' },
    presentation: 'inline',
    placement: { kind: 'end' },
    attachmentMetadata: { slotId: 'slot-1' },
    messageMetadata: [{ key: 'ledger', value: { status: 'running' } }],
    idempotencyKey: 'attach-1',
    persist: 'immediate',
    ...overrides,
})

const prepared = (overrides: Partial<InlayAtomicAttachInput> = {}, digest = 'a'.repeat(64)):
PreparedInlayAtomicAttach => ({
    principalId: 'plugin-a', input: input(overrides), argumentDigest: digest,
    signal: new AbortController().signal,
})

const chat = (data = 'hello') => ({
    id: target.conversationId,
    name: '', note: '', localLore: [], isStreaming: false,
    message: [{ role: 'char', data, chatId: target.messageId, time: 1 }],
})

const harness = (options: {
    sourceChat?: any
    assets?: Map<string, { digest: string; descriptor: { id: string; revision: string; name: string } }>
} = {}) => {
    const sourceChat = options.sourceChat ?? chat()
    const character = {
        chaId: target.characterId, chatPage: 0, type: 'character', chats: [sourceChat],
    }
    const root = { characters: [character] }
    const assets = options.assets ?? new Map()
    let persisted: any
    let fenced = false
    let imageWrites = 0
    const saveChatToServer = vi.fn(async (_characterId: string, _index: number, _chatId: string, staged: any) => {
        expect(character.chats[0]).toBe(sourceChat)
        persisted = structuredClone(staged)
    })
    const stageAtomicInlay = vi.fn(async (_data: Uint8Array, request: any) => {
        await request.beforeMutation()
        const id = await deterministicAtomicInlayId('plugin-a', request.idempotencyKey)
        const existing = assets.get(id)
        if (existing) {
            if (existing.digest !== request.argumentDigest) {
                throw new PluginApiError('CONFLICT', 'Stored Inlay conflicts with the atomic attach request')
            }
            return existing.descriptor
        }
        imageWrites++
        const descriptor = { id, revision: 'sha256:image', name: request.name }
        assets.set(id, { digest: request.argumentDigest, descriptor })
        return descriptor
    })
    const deleteInlay = vi.fn(async (id: string) => {
        assets.delete(id)
        return { deleted: true as const }
    })
    const runFailClosedExclusiveMutation: PocketInlayAtomicAttachDependencies['runFailClosedExclusiveMutation'] =
        async <T>(operation: () => T | Promise<T>): Promise<T> => {
            if (fenced) throw new Error('Database persistence coordinator is fail-closed')
            try { return await operation() } catch (error) {
                fenced = true
                throw error
            }
        }
    const dependencies = {
        getDatabase: vi.fn(() => root),
        getCurrentCharacter: vi.fn(() => character),
        ensureChatHydrated: vi.fn(async (chats: any[], index: number) => chats[index]),
        saveChatToServer,
        runFailClosedExclusiveMutation,
        listInlayKeys: vi.fn(async () => [...assets.keys(), 'known']),
        stageAtomicInlay,
        deleteInlay,
        createRevision: vi.fn(async (value: any) =>
            Object.keys(value.pluginMessageState ?? {}).length > 0 ? 'sha256:after' : 'sha256:before'),
        createId: vi.fn(() => 'commit-1'),
        now: vi.fn(() => 100),
    }
    return {
        adapter: createPocketInlayAtomicAttachAdapter(dependencies),
        assets,
        character,
        dependencies,
        get fenced() { return fenced },
        get imageWrites() { return imageWrites },
        get persisted() { return persisted },
        sourceChat,
    }
}

describe('Pocket current-message atomic generated Inlay attachment', () => {
    it('persists marker, attachment, ledger and receipt once before swapping the live Chat', async () => {
        const state = harness()
        const result = await state.adapter.attachCurrentMessage(prepared())
        const id = await deterministicAtomicInlayId('plugin-a', 'attach-1')

        expect(state.dependencies.saveChatToServer).toHaveBeenCalledOnce()
        expect(state.persisted.message[0].data).toBe(`hello{{inlay::${id}}}`)
        expect(state.persisted.message[0].pluginMessageState['plugin-a']).toMatchObject({
            metadata: { ledger: { status: 'running' } },
            attachments: [{ inlayId: id, presentation: 'inline', metadata: { slotId: 'slot-1' } }],
        })
        expect(state.persisted.pluginAtomicAttachReceipts).toHaveLength(1)
        expect(state.character.chats[0]).not.toBe(state.sourceChat)
        expect(result).toMatchObject({
            inlay: { id, revision: 'sha256:image', name: 'slot.png' },
            message: {
                content: 'hello', revision: 'sha256:after',
                callerPluginState: {
                    metadata: { ledger: { status: 'running' } },
                    attachments: [{ inlayId: id, presentation: 'inline', utf16Offset: 5 }],
                },
            },
            commitId: 'commit-1',
        })
    })

    it('places after the recognized marker cluster at one logical UTF-16 offset', async () => {
        const state = harness({ sourceChat: chat('A{{inlay::known}}B') })
        const result = await state.adapter.attachCurrentMessage(prepared({
            placement: { kind: 'utf16-offset', offset: 1 },
        }))
        const id = result.inlay.id

        expect(state.persisted.message[0].data).toBe(`A{{inlay::known}}{{inlay::${id}}}B`)
        expect(result.message.content).toBe('AB')
        expect(result.message.callerPluginState.attachments[0].utf16Offset).toBe(1)
    })

    it('rejects stale revisions, surrogate splits and duplicate caller Inlays before staging', async () => {
        const stale = harness()
        await expect(stale.adapter.attachCurrentMessage(prepared({
            expectedMessageRevision: 'sha256:stale',
        }))).rejects.toMatchObject({ code: 'CONFLICT' })
        expect(stale.dependencies.stageAtomicInlay).not.toHaveBeenCalled()

        const surrogate = harness({ sourceChat: chat('A😀B') })
        await expect(surrogate.adapter.attachCurrentMessage(prepared({
            placement: { kind: 'utf16-offset', offset: 2 },
        }))).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' })
        expect(surrogate.dependencies.stageAtomicInlay).not.toHaveBeenCalled()

        const duplicate = harness()
        const id = await deterministicAtomicInlayId('plugin-a', 'attach-1')
        duplicate.sourceChat.message[0].data = `hello{{inlay::${id}}}`
        duplicate.sourceChat.message[0].pluginMessageState = {
            'plugin-a': { metadata: {}, attachments: [{ inlayId: id, presentation: 'inline' }] },
        }
        duplicate.dependencies.listInlayKeys.mockResolvedValue([id])
        duplicate.dependencies.createRevision.mockResolvedValue('sha256:before')
        await expect(duplicate.adapter.attachCurrentMessage(prepared()))
            .rejects.toMatchObject({ code: 'CONFLICT' })
        expect(duplicate.dependencies.stageAtomicInlay).not.toHaveBeenCalled()
    })

    it('deletes a staged Inlay on a known pre-save conflict without fencing', async () => {
        const state = harness()
        state.dependencies.stageAtomicInlay.mockImplementationOnce(async (_data: Uint8Array, request: any) => {
            await request.beforeMutation()
            const id = await deterministicAtomicInlayId('plugin-a', request.idempotencyKey)
            state.assets.set(id, {
                digest: request.argumentDigest,
                descriptor: { id, revision: 'sha256:image', name: request.name },
            })
            state.sourceChat.message[0].time = 99
            return state.assets.get(id)!.descriptor
        })

        await expect(state.adapter.attachCurrentMessage(prepared()))
            .rejects.toMatchObject({ code: 'CONFLICT', retryable: true })
        expect(state.dependencies.deleteInlay).toHaveBeenCalledOnce()
        expect(state.dependencies.saveChatToServer).not.toHaveBeenCalled()
        expect(state.fenced).toBe(false)
        expect(state.character.chats[0]).toBe(state.sourceChat)
    })

    it('does not let cleanup failure hide the primary pre-save error', async () => {
        const state = harness()
        state.dependencies.stageAtomicInlay.mockImplementationOnce(async (_data: Uint8Array, request: any) => {
            await request.beforeMutation()
            const id = await deterministicAtomicInlayId('plugin-a', request.idempotencyKey)
            state.sourceChat.message[0].time = 99
            return { id, revision: 'sha256:image', name: request.name }
        })
        state.dependencies.deleteInlay.mockRejectedValueOnce(new PluginApiError('INTERNAL', 'cleanup failed'))

        await expect(state.adapter.attachCurrentMessage(prepared()))
            .rejects.toMatchObject({ code: 'CONFLICT' })
        expect(state.fenced).toBe(false)
    })

    it('retains the staged Inlay and leaves live state untouched when save outcome is unknown', async () => {
        const state = harness()
        state.dependencies.saveChatToServer.mockRejectedValueOnce(new PluginApiError(
            'NETWORK', 'save acknowledgement lost', { retryable: true },
        ))

        await expect(state.adapter.attachCurrentMessage(prepared()))
            .rejects.toMatchObject({ code: 'NETWORK', retryable: true })
        expect(state.dependencies.deleteInlay).not.toHaveBeenCalled()
        expect(state.assets.size).toBe(1)
        expect(state.character.chats[0]).toBe(state.sourceChat)
        expect(state.fenced).toBe(true)
    })

    it('replays a committed receipt after restart before missing or streaming message validation', async () => {
        const state = harness()
        const first = await state.adapter.attachCurrentMessage(prepared())
        state.character.chats[0].message = []
        state.character.chats[0].isStreaming = true
        const restarted = createPocketInlayAtomicAttachAdapter(state.dependencies)

        await expect(restarted.attachCurrentMessage(prepared())).resolves.toEqual(first)
        await expect(restarted.attachCurrentMessage(prepared({}, 'b'.repeat(64))))
            .rejects.toMatchObject({ code: 'CONFLICT' })
        expect(state.dependencies.stageAtomicInlay).toHaveBeenCalledOnce()
        expect(state.dependencies.saveChatToServer).toHaveBeenCalledOnce()
    })

    it('reuses an uncommitted deterministic stage after restart and performs one new save', async () => {
        const assets = new Map<string, any>()
        const first = harness({ assets })
        first.dependencies.saveChatToServer.mockRejectedValueOnce(new Error('connection lost'))
        await expect(first.adapter.attachCurrentMessage(prepared())).rejects.toMatchObject({ code: 'INTERNAL' })
        expect(first.imageWrites).toBe(1)

        const restarted = harness({ assets })
        await expect(restarted.adapter.attachCurrentMessage(prepared())).resolves.toMatchObject({ commitId: 'commit-1' })
        expect(restarted.imageWrites).toBe(0)
        expect(restarted.dependencies.saveChatToServer).toHaveBeenCalledOnce()
    })

    it('fails closed after an acknowledged save if the captured source changed and never swaps it', async () => {
        const state = harness()
        state.dependencies.saveChatToServer.mockImplementationOnce(async () => {
            state.sourceChat.message[0].time = 99
        })

        await expect(state.adapter.attachCurrentMessage(prepared()))
            .rejects.toMatchObject({ code: 'CONFLICT' })
        expect(state.dependencies.deleteInlay).not.toHaveBeenCalled()
        expect(state.character.chats[0]).toBe(state.sourceChat)
        expect(state.fenced).toBe(true)
    })
})

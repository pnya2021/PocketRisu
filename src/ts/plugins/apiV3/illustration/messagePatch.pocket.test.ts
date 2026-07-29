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

const deferred = <T>() => {
    let resolve!: (value: T | PromiseLike<T>) => void
    const promise = new Promise<T>((settle) => { resolve = settle })
    return { promise, resolve }
}

const hex = (bytes: ArrayBuffer) => [...new Uint8Array(bytes)]
    .map((value) => value.toString(16).padStart(2, '0')).join('')

const ownedAsset = async (
    idempotencyKey: string,
    ownerPrincipalId = 'plugin-a',
    characterId = 'character-1',
) => {
    const encoded = new TextEncoder().encode(JSON.stringify([
        ownerPrincipalId, 'inlay.create.v1', idempotencyKey,
    ]))
    const id = `inlay_${hex(await crypto.subtle.digest('SHA-256', encoded))}`
    return [id, {
        name: `${id}.png`,
        type: 'image',
        data: new Blob([Uint8Array.of(1)], { type: 'image/png' }),
        ext: 'png',
        lifecycle: {
            version: 1,
            ownerPrincipalId,
            operation: 'inlay.create.v1',
            idempotencyKey,
            argumentDigest: 'a'.repeat(64),
            revision: `sha256:${'b'.repeat(64)}`,
            context: { kind: 'character', characterId },
        },
    }] as const
}

const ownedAtomicAsset = async (idempotencyKey: string) => {
    const encoded = new TextEncoder().encode(JSON.stringify([
        'plugin-a', 'inlay.atomic-attach.v1', idempotencyKey,
    ]))
    const id = `inlay_${hex(await crypto.subtle.digest('SHA-256', encoded))}`
    return [id, {
        name: `${id}.png`,
        type: 'image',
        data: new Blob([Uint8Array.of(1)], { type: 'image/png' }),
        ext: 'png',
        lifecycle: {
            version: 1,
            ownerPrincipalId: 'plugin-a',
            operation: 'inlay.atomic-attach.v1',
            idempotencyKey,
            argumentDigest: 'a'.repeat(64),
            revision: `sha256:${'b'.repeat(64)}`,
            context: {
                kind: 'message',
                characterId: 'character-1',
                conversationId: 'conversation-1',
                messageId: 'message-1',
            },
            inputRevision: 'sha256:before',
        },
    }] as const
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
    const inlayAssets = new Map<string, any>()
    const liveSlotsObservedAtSave: any[] = []
    let mutationTail = Promise.resolve()
    const saveChatToServer = vi.fn(async (_characterId: string, _index: number, _chatId: string, staged: any) => {
        liveSlotsObservedAtSave.push(character.chats[0])
        expect(staged).not.toBe(character.chats[0])
    })
    const dependencies = {
        getDatabase: vi.fn(() => database),
        getCurrentCharacter: vi.fn(() => character),
        ensureChatHydrated: vi.fn(async () => character.chats[0]),
        saveChatToServer,
        runExclusiveMutation: <T>(operation: () => T | Promise<T>) => {
            const result = mutationTail.then(operation, operation)
            mutationTail = result.then(() => undefined, () => undefined)
            return result
        },
        listInlayKeys: vi.fn(async () => [...inlayAssets.keys()]),
        getInlayAssetRecord: vi.fn(async (id: string) => inlayAssets.get(id) ?? null),
        createRevision: vi.fn(async (value: any): Promise<string> => Object.keys(value.pluginMessageState ?? {}).length === 0
            ? 'sha256:before'
            : 'sha256:after'),
        createId: vi.fn(() => 'commit-1'),
        now: vi.fn(() => 2),
    }
    return {
        adapter: createPocketMessagePatchAdapter(dependencies), chat, character, dependencies,
        inlayAssets, liveSlotsObservedAtSave,
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

    it('attaches an existing owned Inlay at a logical UTF-16 offset', async () => {
        const state = harness({ chat: {
            id: 'conversation-1', message: [{
                role: 'char', data: 'A😀B', chatId: 'message-1', time: 1,
            }],
        } })
        const [inlayId, record] = await ownedAsset('staged-attach')
        state.inlayAssets.set(inlayId, record)
        state.dependencies.createRevision.mockImplementation(async (value: any) =>
            value.data.includes(inlayId) ? 'sha256:attached' : 'sha256:before')

        const result = await state.adapter.patchCurrentMessage({
            ...request,
            input: {
                ...request.input,
                patch: {
                    op: 'attachInlay', inlayId, presentation: 'inline',
                    placement: { kind: 'utf16-offset', offset: 3 },
                    metadata: { slot: 2 },
                },
                idempotencyKey: 'attach-existing-1',
            },
        } as never)

        expect(result).toMatchObject({
            changed: true,
            message: {
                content: 'A😀B',
                revision: 'sha256:attached',
                callerPluginState: { attachments: [{
                    inlayId, presentation: 'inline', utf16Offset: 3, metadata: { slot: 2 },
                }] },
            },
        })
        expect(state.character.chats[0].message[0].data).toBe(`A😀{{inlay::${inlayId}}}B`)
    })

    it('atomically replaces one managed own marker without copying old metadata', async () => {
        const [oldId, oldRecord] = await ownedAsset('old-slot')
        const [newId, newRecord] = await ownedAsset('new-slot')
        const state = harness({ chat: {
            id: 'conversation-1', message: [{
                role: 'char', data: `A{{inlay::${oldId}}}B`, chatId: 'message-1', time: 1,
                pluginMessageState: { 'plugin-a': {
                    metadata: { ledger: 1 },
                    attachments: [{ inlayId: oldId, presentation: 'inline', metadata: { old: true } }],
                } },
            }],
        } })
        state.inlayAssets.set(oldId, oldRecord)
        state.inlayAssets.set(newId, newRecord)
        state.dependencies.createRevision.mockImplementation(async (value: any) =>
            value.data.includes(newId) ? 'sha256:new' : 'sha256:old')

        const result = await state.adapter.patchCurrentMessage({
            ...request,
            input: {
                ...request.input,
                expectedRevision: 'sha256:old',
                patch: {
                    op: 'attachInlay', inlayId: newId, presentation: 'inline',
                    placement: { kind: 'replace-own-inlay', inlayId: oldId },
                },
                idempotencyKey: 'replace-existing-1',
            },
        } as never)

        expect(state.character.chats[0].message[0].data).toBe(`A{{inlay::${newId}}}B`)
        expect(state.character.chats[0].message[0].pluginMessageState['plugin-a'].attachments)
            .toEqual([{ inlayId: newId, presentation: 'inline' }])
        expect(result.message.callerPluginState.attachments).toEqual([{
            inlayId: newId, presentation: 'inline', utf16Offset: 1,
        }])
        expect(state.inlayAssets.has(oldId)).toBe(true)
    })

    it('detaches exactly one managed owned marker and keeps the asset', async () => {
        const [oldId, oldRecord] = await ownedAsset('detach-slot')
        const state = harness({ chat: {
            id: 'conversation-1', message: [{
                role: 'char', data: `A{{inlay::${oldId}}}B`, chatId: 'message-1', time: 1,
                pluginMessageState: { 'plugin-a': {
                    metadata: {},
                    attachments: [{ inlayId: oldId, presentation: 'inline', metadata: { keep: false } }],
                } },
            }],
        } })
        state.inlayAssets.set(oldId, oldRecord)
        state.dependencies.createRevision.mockImplementation(async (value: any) =>
            value.data.includes(oldId) ? 'sha256:old' : 'sha256:detached')

        const result = await state.adapter.patchCurrentMessage({
            ...request,
            input: {
                ...request.input,
                expectedRevision: 'sha256:old',
                patch: { op: 'detachOwnInlay', inlayId: oldId },
                idempotencyKey: 'detach-existing-1',
            },
        } as never)

        expect(state.character.chats[0].message[0].data).toBe('AB')
        expect(result.message.callerPluginState.attachments).toEqual([])
        expect(state.inlayAssets.has(oldId)).toBe(true)
    })

    it('detaches an owned Inlay originally created by atomic attach', async () => {
        const [oldId, oldRecord] = await ownedAtomicAsset('atomic-slot')
        const state = harness({ chat: {
            id: 'conversation-1', message: [{
                role: 'char', data: `A{{inlay::${oldId}}}B`, chatId: 'message-1', time: 1,
                pluginMessageState: { 'plugin-a': {
                    metadata: {},
                    attachments: [{ inlayId: oldId, presentation: 'inline' }],
                } },
            }],
        } })
        state.inlayAssets.set(oldId, oldRecord)
        state.dependencies.createRevision.mockImplementation(async (value: any) =>
            value.data.includes(oldId) ? 'sha256:old' : 'sha256:detached')

        await expect(state.adapter.patchCurrentMessage({
            ...request,
            input: {
                ...request.input,
                expectedRevision: 'sha256:old',
                patch: { op: 'detachOwnInlay', inlayId: oldId },
                idempotencyKey: 'detach-atomic-1',
            },
        } as never)).resolves.toMatchObject({ changed: true })
        expect(state.character.chats[0].message[0].data).toBe('AB')
    })

    it('replaces full metadata on one atomic-owned attachment without moving or rewriting it', async () => {
        const [inlayId, record] = await ownedAtomicAsset('metadata-atomic-slot')
        const state = harness({ chat: {
            id: 'conversation-1', message: [{
                role: 'char', data: `A{{inlay::${inlayId}}}B{{inlay::other}}C`,
                chatId: 'message-1', time: 1,
                pluginMessageState: {
                    'plugin-a': {
                        metadata: { ledger: 1 },
                        attachments: [
                            { inlayId, presentation: 'inline', metadata: { locked: false, old: true } },
                            { inlayId: 'other', presentation: 'inline', metadata: { keep: true } },
                        ],
                    },
                    foreign: { metadata: { secret: true }, attachments: [] },
                },
            }],
        } })
        state.inlayAssets.set(inlayId, record)
        state.inlayAssets.set('other', { legacy: true })
        state.dependencies.createRevision.mockImplementation(async (value: any) =>
            value.pluginMessageState?.['plugin-a']?.attachments?.[0]?.metadata?.locked === true
                ? 'sha256:locked'
                : 'sha256:old')
        const patch = {
            ...request,
            input: {
                ...request.input,
                expectedRevision: 'sha256:old',
                patch: {
                    op: 'setOwnInlayMetadata' as const,
                    inlayId,
                    value: { locked: true, old: false },
                },
                idempotencyKey: 'metadata-atomic-1',
            },
        }

        const changed = await state.adapter.patchCurrentMessage(patch as never)

        expect(changed).toMatchObject({ changed: true, message: { revision: 'sha256:locked' } })
        expect(state.character.chats[0].message[0].data)
            .toBe(`A{{inlay::${inlayId}}}B{{inlay::other}}C`)
        expect(state.character.chats[0].message[0].pluginMessageState['plugin-a'].attachments).toEqual([
            { inlayId, presentation: 'inline', metadata: { locked: true, old: false } },
            { inlayId: 'other', presentation: 'inline', metadata: { keep: true } },
        ])
        expect(state.character.chats[0].message[0].pluginMessageState.foreign)
            .toEqual({ metadata: { secret: true }, attachments: [] })

        await expect(state.adapter.patchCurrentMessage({
            ...patch,
            argumentDigest: 'b'.repeat(64),
            input: {
                ...patch.input,
                expectedRevision: 'sha256:locked',
                idempotencyKey: 'metadata-atomic-2',
            },
        } as never)).resolves.toMatchObject({ changed: false, message: { revision: 'sha256:locked' } })
    })

    it.each([
        ['missing attachment', [{ inlayId: 'other', presentation: 'inline' }], 'NOT_FOUND'],
        ['duplicate attachment', [
            { inlayId: 'target', presentation: 'inline' },
            { inlayId: 'target', presentation: 'inline' },
        ], 'CONFLICT'],
        ['non-inline attachment', [{ inlayId: 'target', presentation: 'styled' }], 'CONFLICT'],
    ])('rejects a %s metadata target without saving', async (_label, attachments, code) => {
        const [inlayId, record] = await ownedAsset('metadata-target')
        const normalized = attachments.map((attachment) => ({
            ...attachment,
            inlayId: attachment.inlayId === 'target' ? inlayId : attachment.inlayId,
        }))
        const state = harness({ chat: {
            id: 'conversation-1', message: [{
                role: 'char',
                data: `A{{inlay::${inlayId}}}B`,
                chatId: 'message-1', time: 1,
                pluginMessageState: { 'plugin-a': { metadata: {}, attachments: normalized } },
            }],
        } })
        state.inlayAssets.set(inlayId, record)
        state.dependencies.createRevision.mockResolvedValue('sha256:after')

        await expect(state.adapter.patchCurrentMessage({
            ...request,
            input: {
                ...request.input,
                expectedRevision: 'sha256:after',
                patch: { op: 'setOwnInlayMetadata', inlayId, value: { locked: true } },
                idempotencyKey: `metadata-${_label}`,
            },
        } as never)).rejects.toMatchObject({ code })
        expect(state.dependencies.saveChatToServer).not.toHaveBeenCalled()
    })

    it('rejects duplicate raw markers for one metadata attachment', async () => {
        const [inlayId, record] = await ownedAsset('metadata-duplicate-marker')
        const state = harness({ chat: {
            id: 'conversation-1', message: [{
                role: 'char',
                data: `A{{inlay::${inlayId}}}B{{inlay::${inlayId}}}C`,
                chatId: 'message-1', time: 1,
                pluginMessageState: { 'plugin-a': {
                    metadata: {},
                    attachments: [{
                        inlayId,
                        presentation: 'inline',
                        metadata: { locked: false },
                    }],
                } },
            }],
        } })
        state.inlayAssets.set(inlayId, record)
        state.dependencies.createRevision.mockResolvedValue('sha256:duplicate-marker')

        await expect(state.adapter.patchCurrentMessage({
            ...request,
            input: {
                ...request.input,
                expectedRevision: 'sha256:duplicate-marker',
                patch: { op: 'setOwnInlayMetadata', inlayId, value: { locked: true } },
                idempotencyKey: 'metadata-duplicate-marker-1',
            },
        } as never)).rejects.toMatchObject({ code: 'CONFLICT' })
        expect(state.chat.message[0].pluginMessageState['plugin-a'].attachments[0].metadata)
            .toEqual({ locked: false })
        expect(state.dependencies.saveChatToServer).not.toHaveBeenCalled()
    })

    it('rejects foreign ownership for metadata replacement without changing the live message', async () => {
        const [inlayId, record] = await ownedAsset('metadata-foreign', 'foreign-plugin')
        const state = harness({ chat: {
            id: 'conversation-1', message: [{
                role: 'char', data: `A{{inlay::${inlayId}}}B`, chatId: 'message-1', time: 1,
                pluginMessageState: { 'plugin-a': {
                    metadata: {},
                    attachments: [{ inlayId, presentation: 'inline', metadata: { locked: false } }],
                } },
            }],
        } })
        state.inlayAssets.set(inlayId, record)
        state.dependencies.createRevision.mockResolvedValue('sha256:after')

        await expect(state.adapter.patchCurrentMessage({
            ...request,
            input: {
                ...request.input,
                expectedRevision: 'sha256:after',
                patch: { op: 'setOwnInlayMetadata', inlayId, value: { locked: true } },
                idempotencyKey: 'metadata-foreign-1',
            },
        } as never)).rejects.toMatchObject({ code: 'PERMISSION_DENIED' })
        expect(state.character.chats[0]).toBe(state.chat)
        expect(state.chat.message[0].pluginMessageState['plugin-a'].attachments[0].metadata)
            .toEqual({ locked: false })
        expect(state.dependencies.saveChatToServer).not.toHaveBeenCalled()
    })

    it('does not expose a replacement marker when the acknowledged save rejects', async () => {
        const [oldId, oldRecord] = await ownedAsset('rollback-old')
        const [newId, newRecord] = await ownedAsset('rollback-new')
        const state = harness({ chat: {
            id: 'conversation-1', message: [{
                role: 'char', data: `A{{inlay::${oldId}}}B`, chatId: 'message-1', time: 1,
                pluginMessageState: { 'plugin-a': {
                    metadata: {},
                    attachments: [{ inlayId: oldId, presentation: 'inline', metadata: { old: true } }],
                } },
            }],
        } })
        state.inlayAssets.set(oldId, oldRecord)
        state.inlayAssets.set(newId, newRecord)
        state.dependencies.createRevision.mockImplementation(async (value: any) =>
            value.data.includes(newId) ? 'sha256:new' : 'sha256:old')
        state.dependencies.saveChatToServer.mockRejectedValueOnce(new Error('offline'))

        await expect(state.adapter.patchCurrentMessage({
            ...request,
            input: {
                ...request.input,
                expectedRevision: 'sha256:old',
                patch: {
                    op: 'attachInlay', inlayId: newId, presentation: 'inline',
                    placement: { kind: 'replace-own-inlay', inlayId: oldId },
                },
                idempotencyKey: 'replace-rollback-1',
            },
        } as never)).rejects.toMatchObject({ code: 'INTERNAL' })

        expect(state.character.chats[0]).toBe(state.chat)
        expect(state.chat.message[0].data).toBe(`A{{inlay::${oldId}}}B`)
        expect(state.chat.message[0].pluginMessageState['plugin-a'].attachments)
            .toEqual([{ inlayId: oldId, presentation: 'inline', metadata: { old: true } }])
    })

    it('rejects a foreign staged Inlay before changing the live message', async () => {
        const state = harness()
        const [foreignId, record] = await ownedAsset('foreign-slot', 'foreign-plugin')
        state.inlayAssets.set(foreignId, record)

        await expect(state.adapter.patchCurrentMessage({
            ...request,
            input: {
                ...request.input,
                patch: {
                    op: 'attachInlay', inlayId: foreignId, presentation: 'inline',
                    placement: { kind: 'end' },
                },
                idempotencyKey: 'foreign-attach-1',
            },
        } as never)).rejects.toMatchObject({ code: 'PERMISSION_DENIED' })

        expect(state.character.chats[0]).toBe(state.chat)
        expect(state.chat.message[0].data).toBe('hello')
        expect(state.dependencies.saveChatToServer).not.toHaveBeenCalled()
    })

    it('holds the shared mutation lease from final ownership validation through persistence', async () => {
        const state = harness()
        const [inlayId, record] = await ownedAsset('locked-staged-attach')
        state.inlayAssets.set(inlayId, record)
        state.dependencies.createRevision.mockImplementation(async (value: any) =>
            value.data.includes(inlayId) ? 'sha256:attached' : 'sha256:before')
        const saveStarted = deferred<void>()
        const releaseSave = deferred<void>()
        state.dependencies.saveChatToServer.mockImplementationOnce(async () => {
            saveStarted.resolve()
            await releaseSave.promise
        })

        const attaching = state.adapter.patchCurrentMessage({
            ...request,
            input: {
                ...request.input,
                patch: {
                    op: 'attachInlay', inlayId, presentation: 'inline', placement: { kind: 'end' },
                },
                idempotencyKey: 'locked-attach-1',
            },
        } as never)
        await saveStarted.promise
        let deletionSettled = false
        const deleting = state.dependencies.runExclusiveMutation(async () => {
            const referenced = state.character.chats[0].message[0].data.includes(inlayId)
            if (!referenced) state.inlayAssets.delete(inlayId)
        }).finally(() => { deletionSettled = true })
        await Promise.resolve()
        expect(deletionSettled).toBe(false)

        releaseSave.resolve()
        await expect(attaching).resolves.toMatchObject({ changed: true })
        await deleting
        expect(state.inlayAssets.has(inlayId)).toBe(true)
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

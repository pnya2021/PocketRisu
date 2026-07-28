import { describe, expect, it, vi } from 'vitest'

import type { MessageCommittedEvent } from './messageEvents'
import { CommittedMessageEventService } from './messageEvents'
import {
    PocketMessageEventRuntime,
    capturePocketMessageBaseline,
    correctContinueMessageIdentity,
    correctRerollMessageIdentity,
} from './messageEvents.pocket'
import { projectCapturedMessageSnapshot } from './messageQuery'
import type { PluginExecutionContext } from './permissions'

const pluginContext = (): PluginExecutionContext => ({
    principalId: 'plugin-a', instanceId: 'instance-a', displayName: 'Plugin A', signal: new AbortController().signal,
})

const attachmentToken = '{{inlay::owned-image}}'
const original = () => ({
    role: 'char' as const,
    data: `old${attachmentToken}`,
    saying: 'member-old',
    chatId: 'message-stable',
    time: 100,
    generationInfo: { generationId: 'generation-old', model: 'old-model' },
    pluginMessageState: {
        'plugin-a': {
            metadata: { ledger: 1 },
            attachments: [{ inlayId: 'owned-image', presentation: 'inline' as const, metadata: { slot: 0 } }],
        },
        'plugin-b': { metadata: { private: true }, attachments: [] },
    },
})

describe('Pocket message identity correction', () => {
    it('captures a Svelte-style proxy baseline when native structuredClone rejects it', () => {
        const proxied = new Proxy(original(), {})

        const baseline = capturePocketMessageBaseline([proxied as any])
        const captured = baseline.get('message-stable')!.message
        proxied.data = 'changed after capture'

        expect(captured).not.toBe(proxied)
        expect(captured.data).toBe(`old${attachmentToken}`)
    })

    it('continues under the stable message, generation, creation, speaker, and caller state identities', () => {
        const before = original()
        const corrected = correctContinueMessageIdentity(before, {
            role: 'char', data: 'old plus new', saying: 'member-new', chatId: 'replacement', time: 200,
            generationInfo: { generationId: 'generation-new', model: 'new-model' },
        }, 300)

        expect(corrected).toMatchObject({
            data: `old plus new${attachmentToken}`,
            saying: 'member-old', chatId: 'message-stable', time: 100,
            generationInfo: { generationId: 'generation-old', model: 'new-model' },
            pluginMessageUpdatedAt: 300,
            pluginMessageState: before.pluginMessageState,
        })
        expect(corrected.pluginMessageState).not.toBe(before.pluginMessageState)
    })

    it('rerolls under the stable message and creation identities with a new generation and speaker, clamping markers to end', () => {
        const before = original()
        const corrected = correctRerollMessageIdentity(before, {
            role: 'char', data: 'new', saying: 'member-new', chatId: 'replacement', time: 200,
            generationInfo: { generationId: 'generation-new', model: 'new-model' },
        }, 400)

        expect(corrected).toMatchObject({
            data: `new${attachmentToken}`,
            saying: 'member-new', chatId: 'message-stable', time: 100,
            generationInfo: { generationId: 'generation-new', model: 'new-model' },
            pluginMessageUpdatedAt: 400,
        })
        expect(corrected.pluginMessageState).toEqual(before.pluginMessageState)
    })
})

function runtimeHarness() {
    const chat = { id: 'conversation-a', message: [original()], note: '', name: '', localLore: [] }
    const character = { chaId: 'character-a', type: 'character', chatPage: 0, chats: [chat] }
    const database = { characters: [character] }
    const saves: unknown[] = []
    const service = new CommittedMessageEventService({
        current: () => ({ characterId: 'character-a', conversationId: 'conversation-a' }),
        requirePermission: async () => undefined,
        projectSnapshot: (context, commit) => projectCapturedMessageSnapshot(commit.snapshotSource, context.principalId),
        createId: (() => { let id = 0; return () => `subscription-${++id}` })(),
    })
    const dependencies = {
        getDatabase: () => database,
        listInlayKeys: vi.fn(async () => ['owned-image']),
        runExclusiveMutation: vi.fn(async (operation: () => Promise<any>) => operation()),
        saveChatToServer: vi.fn(async (_characterId: string, _index: number, _conversationId: string, staged: unknown) => {
            saves.push(structuredClone(staged))
        }),
        createId: (() => { let id = 0; return () => `event-${++id}` })(),
        now: () => 500,
    }
    const runtime = new PocketMessageEventRuntime(service, dependencies)
    return { runtime, service, dependencies, database, character, chat, saves }
}

describe('PocketMessageEventRuntime', () => {
    it('does not enumerate topology or save when no subscriber matches', async () => {
        const h = runtimeHarness()
        await h.runtime.commitBatch({
            characterId: 'character-a', conversationId: 'conversation-a',
            commits: [{ message: h.chat.message[0], change: 'updated', cause: 'continue' }],
        })
        expect(h.dependencies.listInlayKeys).not.toHaveBeenCalled()
        expect(h.dependencies.runExclusiveMutation).not.toHaveBeenCalled()
        expect(h.dependencies.saveChatToServer).not.toHaveBeenCalled()
    })

    it('uses one immutable capture, one event ID, and awaited exclusive persistence for state and persisted delivery', async () => {
        const h = runtimeHarness()
        const state: MessageCommittedEvent[] = []
        const persisted: MessageCommittedEvent[] = []
        await h.service.onMessageCommitted(pluginContext(), (event) => { state.push(event) }, { durability: 'state' })
        await h.service.onMessageCommitted({ ...pluginContext(), instanceId: 'instance-b' }, (event) => { persisted.push(event) })

        let finishSave!: () => void
        h.dependencies.saveChatToServer.mockImplementationOnce(async () => new Promise<void>((resolve) => { finishSave = resolve }))
        const operation = h.runtime.commitBatch({
            characterId: 'character-a', conversationId: 'conversation-a',
            commits: [{ message: h.chat.message[0], change: 'updated', cause: 'continue' }],
        })
        await vi.waitFor(() => expect(state).toHaveLength(1))
        expect(persisted).toHaveLength(0)
        expect(h.dependencies.runExclusiveMutation).toHaveBeenCalledOnce()
        finishSave()
        await operation
        await vi.waitFor(() => expect(persisted).toHaveLength(1))

        expect(state[0].eventId).toBe(persisted[0].eventId)
        expect(state[0].message).toEqual(persisted[0].message)
        expect(h.dependencies.listInlayKeys).toHaveBeenCalledOnce()
        expect(h.dependencies.saveChatToServer).toHaveBeenCalledWith('character-a', 0, 'conversation-a', h.chat)
    })

    it('captures candidates before delayed topology enumeration can observe a cached reroll mutation', async () => {
        const h = runtimeHarness()
        const state: MessageCommittedEvent[] = []
        await h.service.onMessageCommitted(pluginContext(), (event) => { state.push(event) }, { durability: 'state' })
        let releaseList!: () => void
        h.dependencies.listInlayKeys.mockImplementationOnce(() => new Promise<string[]>((resolve) => {
            releaseList = () => { resolve(['owned-image']) }
        }))
        const submitted = h.chat.message[0]

        const operation = h.runtime.commitBatch({
            characterId: 'character-a', conversationId: 'conversation-a',
            commits: [{ message: submitted, change: 'updated', cause: 'continue' }],
        })
        expect(h.dependencies.listInlayKeys).toHaveBeenCalledOnce()
        submitted.data = 'newer cached reroll'
        submitted.generationInfo = { generationId: 'generation-reroll', model: 'new-model' }
        releaseList()
        await operation
        await vi.waitFor(() => expect(state).toHaveLength(1))

        expect(state[0]).toMatchObject({
            cause: 'continue',
            message: { content: 'old', generationId: 'generation-old' },
        })
    })

    it('rechecks the live revision inside the exclusive lease and never saves a superseded capture', async () => {
        const h = runtimeHarness()
        await h.service.onMessageCommitted(pluginContext(), () => undefined)
        h.dependencies.runExclusiveMutation.mockImplementationOnce(async (operation: () => Promise<any>) => {
            h.chat.message[0].data = 'newer live content'
            return operation()
        })
        await h.runtime.commitBatch({
            characterId: 'character-a', conversationId: 'conversation-a',
            commits: [{ message: original(), change: 'updated', cause: 'continue' }],
        })
        expect(h.dependencies.saveChatToServer).not.toHaveBeenCalled()
    })

    it('does not publish persisted durability after a failed save or a mutation during the awaited save', async () => {
        const failed = runtimeHarness()
        const failedEvents: MessageCommittedEvent[] = []
        await failed.service.onMessageCommitted(pluginContext(), (event) => { failedEvents.push(event) })
        failed.dependencies.saveChatToServer.mockRejectedValueOnce(new Error('offline'))
        await expect(failed.runtime.commitBatch({
            characterId: 'character-a', conversationId: 'conversation-a',
            commits: [{ message: failed.chat.message[0], change: 'updated', cause: 'continue' }],
        })).resolves.toBeUndefined()
        expect(failedEvents).toHaveLength(0)

        const raced = runtimeHarness()
        const racedEvents: MessageCommittedEvent[] = []
        await raced.service.onMessageCommitted(pluginContext(), (event) => { racedEvents.push(event) })
        raced.dependencies.saveChatToServer.mockImplementationOnce(async () => {
            raced.chat.message[0].data = 'changed while saving'
        })
        await raced.runtime.commitBatch({
            characterId: 'character-a', conversationId: 'conversation-a',
            commits: [{ message: raced.chat.message[0], change: 'updated', cause: 'continue' }],
        })
        expect(racedEvents).toHaveLength(0)
    })
})

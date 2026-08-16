import { afterEach, describe, expect, it, vi } from 'vitest'
import { SvelteMap } from 'svelte/reactivity'
import { ContextAssetAuthorityRegistry } from './contextAssetAuthorityRegistry'
import { ContextAssetReadCoordinator } from './contextAssetReadCoordinator'
import { ContextResourceService } from './contextResources'
import { createStudioCardResourceService, type StudioCardResourceService } from './studioCardResources'
import { createStudioCardCatalogueIndex } from './studioCardCatalogueIndex.svelte'

type RawCard = Record<string, any>

const noChatSeams = () => ({
    hydrateCurrentChat: vi.fn(() => { throw new Error('chat hydration touched') }),
    loadLazyChat: vi.fn(() => { throw new Error('lazy chat touched') }),
    hydrateChatDraft: vi.fn(() => { throw new Error('chat draft touched') }),
    normalizeChat: vi.fn(() => { throw new Error('normalizeChat touched') }),
})

const assertNoChatSeams = (seams: ReturnType<typeof noChatSeams>) => {
    for (const seam of Object.values(seams)) expect(seam).not.toHaveBeenCalled()
}

const guardChatData = (card: RawCard, touched: () => never) => {
    for (const key of ['chats', 'chatPage', 'message', 'messages', 'chatDraft', 'draft', 'normalizeChat']) {
        Object.defineProperty(card, key, { enumerable: true, configurable: true, get: touched })
    }
}

const character = (id: string, name = id): RawCard => ({
    chaId: id,
    type: 'character',
    name,
    desc: `${name} description`,
    personality: `${name} personality`,
    scenario: `${name} scenario`,
    firstMessage: `${name} first message`,
    exampleMessage: `${name} example message`,
    creatorNotes: `${name} creator notes`,
    systemPrompt: `${name} system prompt`,
    postHistoryInstructions: `${name} post-history instructions`,
    notes: `${name} notes`,
    additionalText: `${name} additional text`,
    globalLore: [{ id: `${id}-lore`, comment: 'Lore', content: `${name} lore`, mode: 'normal' }],
    image: `assets/${id}.png`,
    emotionImages: [],
    additionalAssets: [],
    ccAssets: [],
})

const group = (id: string, members: string[], name = id): RawCard => ({
    ...character(id, name),
    type: 'group',
    characters: members,
})

const live: Array<{ studio: StudioCardResourceService; reader: ContextResourceService }> = []
afterEach(() => {
    for (const item of live.splice(0)) {
        item.studio.dispose()
        item.reader.dispose()
    }
    vi.restoreAllMocks()
})

async function harness(options: {
    characters: unknown[]
    selected?: number
    onStorageRevision?: (storageKey: string) => void
}) {
    const native = await import('./studioCardResources.pocket')
    const seams = noChatSeams()
    let selected = options.selected ?? -1
    const readImage = vi.fn(async (_storageKey: string) => new Uint8Array([1, 2, 3]))
    const getAssetStorageRevision = vi.fn((storageKey: string) => {
        options.onStorageRevision?.(storageKey)
        return `storage:${storageKey}`
    })
    const adapter = native.createPocketStudioCardResourceAdapter({
        getDatabase: () => ({ characters: options.characters }),
        getSelectedCharacterIndex: () => selected,
        readImage,
        getAssetStorageRevision,
    })
    const abortController = new AbortController()
    const context = {
        principalId: '11111111-1111-4111-8111-111111111111',
        instanceId: crypto.randomUUID(),
        displayName: 'Studio',
        signal: abortController.signal,
    }
    const registry = new ContextAssetAuthorityRegistry()
    const coordinator = new ContextAssetReadCoordinator()
    const studio = createStudioCardResourceService({
        context,
        adapter,
        assetAuthorityRegistry: registry,
        readCoordinator: coordinator,
        permissionGeneration: () => 'permission-1',
        requirePermission: async () => undefined,
    })
    const reader = new ContextResourceService(context, {
        getState: async () => ({ characters: [], activeModules: [], installedModules: [] }),
        readAsset: async () => null,
        createThumbnail: async (_source, data) => ({
            data, mediaType: 'image/png', width: 1, height: 1, decodedPixels: 1,
        }),
    }, {
        assetAuthorityRegistry: registry,
        readCoordinator: coordinator,
        getPermissionGeneration: () => 'permission-1',
        requirePermission: async () => undefined,
    })
    live.push({ studio, reader })
    return {
        studio, reader, adapter, registry, coordinator, seams, readImage, getAssetStorageRevision,
        setSelected(value: number) { selected = value },
        getSelected() { return selected },
    }
}

async function select(
    h: Awaited<ReturnType<typeof harness>>,
    cardId: string,
    suppliedPage?: Awaited<ReturnType<StudioCardResourceService['listStudioCards']>>,
) {
    const page = suppliedPage ?? await h.studio.listStudioCards({ limit: 24 })
    const summary = page.items.find((item) => item.cardId === cardId) ?? page.hostActiveCard
    expect(summary?.cardId).toBe(cardId)
    return h.studio.captureStudioCardSource({
        cardId,
        expectedCatalogueItemRevision: summary!.catalogueItemRevision,
        catalogueRevision: page.catalogueRevision,
    })
}

describe('Pocket Studio card native projection', () => {
    it('reuses the reactive scalar index without reprojecting unchanged cards', () => {
        const raw = character('alice', 'Alice')
        const scalarState = new SvelteMap<PropertyKey, unknown>([['name', 'Alice']])
        let scalarReads = 0
        const tracked = new Proxy(raw, {
            getOwnPropertyDescriptor(target, property) {
                if (['chaId', 'type', 'name', 'image', 'characters', 'trashTime'].includes(String(property))) {
                    scalarReads += 1
                }
                return Reflect.getOwnPropertyDescriptor(target, property)
            },
            get(target, property, receiver) {
                return scalarState.has(property) ? scalarState.get(property) : Reflect.get(target, property, receiver)
            },
        })
        const cards = new SvelteMap<number, RawCard>([[0, tracked]])
        const dependencies = {
            getCharacters: () => [...cards.values()],
            getSelectedCharacterIndex: () => 0,
            getAssetStorageRevision: (storageKey: string) => `storage:${storageKey}:1`,
            reactive: true,
        }
        const index = createStudioCardCatalogueIndex(dependencies)

        expect(index.current().records.map(({ native }) => native.cardId)).toEqual(['alice'])
        const readsAfterColdBuild = scalarReads
        expect(index.current().records.map(({ native }) => native.cardId)).toEqual(['alice'])
        expect(scalarReads).toBe(readsAfterColdBuild)

        scalarState.set('name', 'Renamed')
        expect(index.current().records[0].native.name).toBe('Renamed')

        cards.set(1, character('bob', 'Bob'))
        expect(index.current().records.map(({ native }) => native.cardId)).toEqual(['alice', 'bob'])
    })

    it('indexes scalar card fields only, filters unsafe records, and emits an off-page Host active card', async () => {
        const cards = Array.from({ length: 26 }, (_, index) => character(
            `card-${index.toString().padStart(2, '0')}`,
            index === 25 ? 'zz Host current' : `Card ${index.toString().padStart(2, '0')}`,
        ))
        const forbidden = vi.fn(() => { throw new Error('forbidden field touched') })
        for (const card of cards) {
            Object.defineProperties(card, {
                chats: { enumerable: true, get: forbidden },
                chatPage: { enumerable: true, get: forbidden },
                customscript: { enumerable: true, get: forbidden },
                secrets: { enumerable: true, get: forbidden },
            })
        }
        const duplicateA = character('duplicate', 'Duplicate A')
        const duplicateB = character('duplicate', 'Duplicate B')
        const accessorName = character('accessor-name')
        Object.defineProperty(accessorName, 'name', { enumerable: true, get: forbidden })
        const malformedGroup = group('nested', ['child'])
        const nestedMember = group('child', [], 'Nested child')
        const trashed = Object.assign(character('trashed'), { trashTime: 1 })
        const h = await harness({
            characters: [
                ...cards,
                duplicateA,
                duplicateB,
                accessorName,
                malformedGroup,
                nestedMember,
                trashed,
                character('§temp'),
                character('§playground'),
                null,
                7,
            ],
            selected: 25,
        })

        const page = await h.studio.listStudioCards({ limit: 24 })
        expect(page.total).toBe(28)
        expect(page.items).toHaveLength(24)
        expect(page.items.every((item) => !item.portrait?.revision.includes('assets/'))).toBe(true)
        expect(page.items.map((item) => item.cardId)).not.toContain('card-25')
        expect(page.hostActiveCard).toMatchObject({ cardId: 'card-25', name: 'zz Host current' })
        expect(page.items.map((item) => item.cardId)).not.toEqual(expect.arrayContaining([
            'duplicate', 'accessor-name', 'trashed', '§temp', '§playground',
        ]))
        expect(forbidden).not.toHaveBeenCalled()
        assertNoChatSeams(h.seams)
    })

    it('captures the coherent latest normal/group source with separate revisions and no Host navigation', async () => {
        const alice = character('alice', 'Alice')
        const bob = character('bob', 'Bob')
        const party = group('party', ['bob', 'alice', 'alice'], 'Party')
        const cards = [alice, bob, party]
        const chatTouched = vi.fn(() => { throw new Error('chat data touched') })
        cards.forEach((card) => guardChatData(card, chatTouched))
        const h = await harness({ characters: cards, selected: 0 })
        const page = await h.studio.listStudioCards({ limit: 24 })
        const partySummary = page.items.find((item) => item.cardId === 'party')!

        party.desc = 'latest hidden description'
        party.globalLore[0].content = 'latest lore'
        const capture = await select(h, 'party', page)

        expect(capture.card).toMatchObject({
            id: 'party',
            type: 'group',
            groupMemberIds: ['alice', 'bob'],
            textSections: expect.arrayContaining([
                { key: 'description', label: 'Description', content: 'latest hidden description' },
            ]),
            lorebook: [{ id: 'party-lore', name: 'Lore', content: 'latest lore', enabled: true }],
        })
        expect(capture.groupMembers.map((member) => member.id)).toEqual(['alice', 'bob'])
        expect(capture.sourceRevision).not.toBe(partySummary.catalogueItemRevision)
        expect(capture.card.revision).not.toBe(partySummary.catalogueItemRevision)
        expect(h.readImage).not.toHaveBeenCalled()
        expect(h.adapter.revalidateSource).toBeTypeOf('function')
        expect(h.getSelected()).toBe(0)
        expect(cards).toHaveLength(3)
        expect(chatTouched).not.toHaveBeenCalled()
        assertNoChatSeams(h.seams)
    })

    it('enumerates 4,902 logical assets without authority and reads only an exact resolved batch', async () => {
        const source = character('asset-heavy', 'Asset Heavy')
        source.image = ''
        source.additionalAssets = Array.from({ length: 4_902 }, (_, index) => [
            `asset-${index}`, `assets/asset-${index}.png`, 'png',
        ])
        const chatTouched = vi.fn(() => { throw new Error('chat data touched') })
        guardChatData(source, chatTouched)
        const h = await harness({ characters: [source], selected: 0 })
        const capture = await select(h, 'asset-heavy')

        const descriptors: Array<{ logicalAssetId: string }> = []
        let cursor: string | undefined
        do {
            const page = await h.studio.listStudioCardAssets({
                captureRevision: capture.captureRevision,
                ...(cursor ? { cursor } : {}),
                limit: 100,
            })
            descriptors.push(...page.assets)
            cursor = page.nextCursor
        } while (cursor)

        expect(descriptors).toHaveLength(4_902)
        expect(descriptors.every((asset: any) => !asset.assetRevision.includes('assets/'))).toBe(true)
        expect(h.registry.size(contextPrincipal(h))).toBe(0)
        expect(h.readImage).not.toHaveBeenCalled()

        const requested = descriptors.slice(2_111, 2_135).map((asset) => asset.logicalAssetId)
        const access = await h.studio.resolveStudioCardAssetHandles({
            captureRevision: capture.captureRevision,
            logicalAssetIds: requested,
            purpose: 'candidate-page',
        })
        expect(access.assets.map((asset) => asset.logicalAssetId)).toEqual(requested)
        expect(h.registry.size(contextPrincipal(h))).toBe(24)
        expect(h.readImage).not.toHaveBeenCalled()

        await expect(h.reader.readContextAsset(access.assets[7].asset.assetId)).resolves.toMatchObject({
            data: new Uint8Array([1, 2, 3]),
        })
        expect(h.readImage).toHaveBeenCalledTimes(1)
        await h.studio.releaseStudioCardAssetAccess(access.accessRevision)
        await expect(h.reader.readContextAsset(access.assets[7].asset.assetId)).rejects.toMatchObject({ code: 'NOT_FOUND' })
        await h.studio.releaseStudioCardSource(capture.captureRevision)
        await h.studio.releaseStudioCardTarget(capture.targetRevision)
        expect(chatTouched).not.toHaveBeenCalled()
        assertNoChatSeams(h.seams)
    }, 60_000)

    it('fails atomically when text, lore, membership, asset metadata, deletion, or trash overlaps capture', async () => {
        for (const mutation of [
            (root: RawCard) => { root.desc = 'changed during capture' },
            (root: RawCard) => { root.globalLore[0].content = 'changed during capture' },
            (root: RawCard) => { root.characters.push('member-c') },
            (root: RawCard) => { root.additionalAssets[0][0] = 'renamed during capture' },
        ]) {
            const memberA = character('member-a')
            const memberB = character('member-b')
            const memberC = character('member-c')
            const root = group('party', ['member-a', 'member-b'])
            root.image = ''
            root.additionalAssets = [['before', 'assets/before.png', 'png']]
            let revisionCalls = 0
            const h = await harness({
                characters: [root, memberA, memberB, memberC],
                selected: 0,
                onStorageRevision: () => {
                    revisionCalls += 1
                    if (revisionCalls === 4) mutation(root)
                },
            })
            await expect(h.adapter.captureSource('party')).rejects.toMatchObject({ code: 'CONFLICT' })
            expect(h.registry.size(contextPrincipal(h))).toBe(0)
            expect(h.readImage).not.toHaveBeenCalled()
            assertNoChatSeams(h.seams)
        }

        for (const disappear of ['delete', 'trash'] as const) {
            const root = character(`gone-${disappear}`)
            const cards: unknown[] = [root]
            const h = await harness({ characters: cards, selected: 0 })
            const page = await h.studio.listStudioCards({ limit: 24 })
            const retainedBeforeCapture = h.registry.size(contextPrincipal(h))
            if (disappear === 'delete') cards.splice(0, 1)
            else root.trashTime = 1
            await expect(select(h, root.chaId, page)).rejects.toMatchObject({ code: 'CONFLICT' })
            expect(h.registry.size(contextPrincipal(h))).toBe(retainedBeforeCapture)
            expect(h.readImage).not.toHaveBeenCalled()
            assertNoChatSeams(h.seams)
        }
    })
})

function contextPrincipal(h: Awaited<ReturnType<typeof harness>>) {
    return (h.studio as any).input.context.principalId as string
}

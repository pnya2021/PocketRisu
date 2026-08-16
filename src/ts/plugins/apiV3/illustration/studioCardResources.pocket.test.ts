import { afterEach, describe, expect, it, vi } from 'vitest'
import { SvelteMap } from 'svelte/reactivity'
import { proxy as deepState } from 'svelte/internal/client'
import { get as getStoreValue } from 'svelte/store'
import { ContextAssetAuthorityRegistry } from './contextAssetAuthorityRegistry'
import { ContextAssetReadCoordinator } from './contextAssetReadCoordinator'
import { ContextResourceService } from './contextResources'
import { createStudioCardResourceService, type StudioCardResourceService } from './studioCardResources'
import { createStudioCardCatalogueIndex } from './studioCardCatalogueIndex.svelte'

type RawCard = Record<string, any>

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
    storageRevisions?: Map<string, string>
    reactive?: boolean
    getAssetStorageMutationGeneration?: () => string | number
}) {
    const native = await import('./studioCardResources.pocket')
    let selected = options.selected ?? -1
    const readImage = vi.fn(async (_storageKey: string) => new Uint8Array([1, 2, 3]))
    const getAssetStorageRevision = vi.fn((storageKey: string) => {
        options.onStorageRevision?.(storageKey)
        return options.storageRevisions?.get(storageKey) ?? `storage:${storageKey}`
    })
    const adapter = native.createPocketStudioCardResourceAdapter({
        getDatabase: () => ({ characters: options.characters }),
        getSelectedCharacterIndex: () => selected,
        readImage,
        getAssetStorageRevision,
        getAssetStorageMutationGeneration: options.getAssetStorageMutationGeneration,
        reactiveCatalogueIndex: options.reactive,
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
        studio, reader, adapter, registry, coordinator, readImage, getAssetStorageRevision,
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

    it.each([
        {
            change: 'card id',
            mutate: (cards: RawCard[]) => { cards[0].chaId = 'renamed' },
            assertSnapshot: (snapshot: ReturnType<ReturnType<typeof createStudioCardCatalogueIndex>['current']>) => {
                expect(snapshot.byId.has('party')).toBe(false)
                expect(snapshot.byId.has('renamed')).toBe(true)
            },
        },
        {
            change: 'card type',
            mutate: (cards: RawCard[]) => { cards[0].type = 'character' },
            assertSnapshot: (snapshot: ReturnType<ReturnType<typeof createStudioCardCatalogueIndex>['current']>) => {
                expect(snapshot.records[0].native).toMatchObject({ kind: 'character', groupMemberIds: [] })
            },
        },
        {
            change: 'card name',
            mutate: (cards: RawCard[]) => { cards[0].name = 'Renamed party' },
            assertSnapshot: (snapshot: ReturnType<ReturnType<typeof createStudioCardCatalogueIndex>['current']>) => {
                expect(snapshot.records[0].native.name).toBe('Renamed party')
            },
        },
        {
            change: 'portrait key',
            mutate: (cards: RawCard[]) => { cards[0].image = 'assets/replacement.png' },
            assertSnapshot: (snapshot: ReturnType<ReturnType<typeof createStudioCardCatalogueIndex>['current']>) => {
                expect(snapshot.records[0].native.portrait?.locator.storageRevision)
                    .toBe('storage:assets/replacement.png')
            },
        },
        {
            change: 'direct member element',
            mutate: (cards: RawCard[]) => { cards[0].characters[0] = 'member-b' },
            assertSnapshot: (snapshot: ReturnType<ReturnType<typeof createStudioCardCatalogueIndex>['current']>) => {
                expect(snapshot.records[0].native.groupMemberIds).toEqual(['member-b'])
            },
        },
        {
            change: 'direct member array',
            mutate: (cards: RawCard[]) => { cards[0].characters = ['member-b'] },
            assertSnapshot: (snapshot: ReturnType<ReturnType<typeof createStudioCardCatalogueIndex>['current']>) => {
                expect(snapshot.records[0].native.groupMemberIds).toEqual(['member-b'])
            },
        },
        {
            change: 'trash state',
            mutate: (cards: RawCard[]) => { cards[0].trashTime = 1 },
            assertSnapshot: (snapshot: ReturnType<ReturnType<typeof createStudioCardCatalogueIndex>['current']>) => {
                expect(snapshot.byId.has('party')).toBe(false)
            },
        },
        {
            change: 'array slot identity',
            mutate: (cards: RawCard[]) => {
                cards[0] = character('replacement', 'Replacement')
            },
            assertSnapshot: (snapshot: ReturnType<ReturnType<typeof createStudioCardCatalogueIndex>['current']>) => {
                expect(snapshot.byId.has('party')).toBe(false)
                expect(snapshot.byId.has('replacement')).toBe(true)
            },
        },
    ])('invalidates the actual deep rune scalar index after an in-place $change mutation', ({ mutate, assertSnapshot }) => {
        const state = deepState({
            characters: [
                { chaId: 'party', type: 'group', name: 'Party', image: 'assets/party.png', characters: ['member-a'] },
                { chaId: 'member-a', type: 'character', name: 'Member A', image: 'assets/member-a.png' },
                { chaId: 'member-b', type: 'character', name: 'Member B', image: 'assets/member-b.png' },
            ] as RawCard[],
        })
        const index = createStudioCardCatalogueIndex({
            getCharacters: () => state.characters,
            getSelectedCharacterIndex: () => 0,
            getAssetStorageRevision: (storageKey) => `storage:${storageKey}`,
            reactive: true,
        })
        const initial = index.current()

        mutate(state.characters)

        const changed = index.current()
        expect(changed).not.toBe(initial)
        expect(index.isCurrent(initial)).toBe(false)
        assertSnapshot(changed)
    })

    it('invalidates a warm portrait catalogue after an authoritative same-key storage replacement', async () => {
        const state = deepState({
            characters: [character('alice', 'Alice')],
            storageGeneration: 0,
        })
        const revisions = new Map([['assets/alice.png', 'storage:alice:1']])
        const h = await harness({
            characters: state.characters,
            selected: 0,
            storageRevisions: revisions,
            reactive: true,
            getAssetStorageMutationGeneration: () => state.storageGeneration,
        })
        const first = await h.studio.listStudioCards({ limit: 24 })
        const firstSummary = first.items[0]

        revisions.set('assets/alice.png', 'storage:alice:2')
        state.storageGeneration += 1

        const replacement = await h.studio.listStudioCards({ limit: 24 })
        const replacementSummary = replacement.items[0]
        expect(replacement.catalogueRevision).not.toBe(first.catalogueRevision)
        expect(replacementSummary.catalogueItemRevision).not.toBe(firstSummary.catalogueItemRevision)
        expect(replacementSummary.portrait?.revision).not.toBe(firstSummary.portrait?.revision)
        await expect(h.reader.readContextAsset(firstSummary.portrait!.assetId, { variant: 'original' }))
            .rejects.toMatchObject({ code: 'CONFLICT' })
        await expect(h.reader.readContextAsset(replacementSummary.portrait!.assetId, { variant: 'original' }))
            .resolves.toMatchObject({ data: new Uint8Array([1, 2, 3]) })
        expect(h.readImage).toHaveBeenCalledTimes(1)
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
            let memberARevisionCalls = 0
            const h = await harness({
                characters: [root, memberA, memberB, memberC],
                selected: 0,
                onStorageRevision: (storageKey) => {
                    if (storageKey !== 'assets/member-a.png') return
                    memberARevisionCalls += 1
                    if (memberARevisionCalls === 3) mutation(root)
                },
            })
            await expect(h.adapter.captureSource('party')).rejects.toMatchObject({ code: 'CONFLICT' })
            expect(h.registry.size(contextPrincipal(h))).toBe(0)
            expect(h.readImage).not.toHaveBeenCalled()
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
        }
    })

    it('rejects an over-limit raw asset collection before enumerating any asset entry', async () => {
        const source = character('oversized', 'Oversized')
        let projectedEntries = 0
        source.additionalAssets = new Proxy(
            Array.from({ length: 20_000 }, (_, index) => [
                `asset-${index}.png`, `assets/asset-${index}.png`, 'png',
            ]),
            {
                getOwnPropertyDescriptor(target, property) {
                    if (/^\d+$/u.test(String(property))) projectedEntries += 1
                    return Reflect.getOwnPropertyDescriptor(target, property)
                },
            },
        )
        const h = await harness({ characters: [source], selected: 0 })

        await expect(select(h, 'oversized')).rejects.toMatchObject({ code: 'RESOURCE_LIMIT' })
        expect(projectedEntries).toBe(0)
        expect(h.readImage).not.toHaveBeenCalled()
    })

    it('rejects oversized lore metadata before copying later lore entries', async () => {
        const source = character('oversized-lore', 'Oversized Lore')
        let laterLoreReads = 0
        source.globalLore = new Proxy([
            { id: 'oversized', comment: 'Oversized', content: 'x'.repeat(524_289), mode: 'normal' },
            { id: 'later', comment: 'Later', content: 'must not be projected', mode: 'normal' },
        ], {
            getOwnPropertyDescriptor(target, property) {
                if (property === '1') laterLoreReads += 1
                return Reflect.getOwnPropertyDescriptor(target, property)
            },
        })
        const h = await harness({ characters: [source], selected: 0 })

        await expect(select(h, 'oversized-lore')).rejects.toMatchObject({ code: 'RESOURCE_LIMIT' })
        expect(laterLoreReads).toBe(0)
        expect(h.readImage).not.toHaveBeenCalled()
    })

    it('uses the production V3 Studio adapter wiring without touching chat hydration and tracks Host selection', async () => {
        const stores = await import('../../../stores.svelte')
        const chatStorage = await import('../../../storage/chatStorage')
        const database = await import('../../../storage/database.svelte')
        const globalApi = await import('../../../globalApi.svelte')
        const v3 = await import('../v3.svelte')
        const ensureCurrent = vi.spyOn(chatStorage, 'ensureCurrentChatReady')
        const ensureHydrated = vi.spyOn(chatStorage, 'ensureChatHydrated')
        const fetchLazy = vi.spyOn(chatStorage, 'fetchChatFromServer')
        const normalize = vi.spyOn(database, 'normalizeChat')
        const imageRead = vi.spyOn(globalApi, 'readImage').mockResolvedValue(new Uint8Array([4, 5, 6]))
        const previousCharacters = stores.DBState.db.characters
        const previousSelected = stores.selIdState.selId
        const previousSelectedStore = getStoreValue(stores.selectedCharID)
        const sourceA = character('v3-a', 'V3 A')
        const sourceB = character('v3-b', 'V3 B')
        sourceA.chats = []
        sourceA.chatPage = 0
        sourceB.chats = []
        sourceB.chatPage = 0
        let studio: StudioCardResourceService | undefined
        let reader: ContextResourceService | undefined
        try {
            stores.DBState.db.characters = [sourceA, sourceB] as any
            stores.selectedCharID.set(0)
            stores.selIdState.selId = 0
            const adapter = (v3 as any).createPocketStudioCardResourceAdapterForV3()
            expect(adapter).toBeDefined()
            const context = {
                principalId: '22222222-2222-4222-8222-222222222222',
                instanceId: crypto.randomUUID(),
                displayName: 'Studio V3',
                signal: new AbortController().signal,
            }
            const registry = new ContextAssetAuthorityRegistry()
            const coordinator = new ContextAssetReadCoordinator()
            studio = createStudioCardResourceService({
                context,
                adapter,
                assetAuthorityRegistry: registry,
                readCoordinator: coordinator,
                permissionGeneration: () => 'permission-v3',
                requirePermission: async () => undefined,
            })
            reader = new ContextResourceService(context, {
                getState: async () => ({ characters: [], activeModules: [], installedModules: [] }),
                readAsset: async () => null,
                createThumbnail: async (_source, data) => ({
                    data, mediaType: 'image/png', width: 1, height: 1, decodedPixels: 1,
                }),
            }, {
                assetAuthorityRegistry: registry,
                readCoordinator: coordinator,
                getPermissionGeneration: () => 'permission-v3',
                requirePermission: async () => undefined,
            })

            const first = await studio.listStudioCards({ limit: 24 })
            expect(first.hostActiveCard?.cardId).toBe('v3-a')
            const capture = await studio.captureStudioCardSource({
                cardId: 'v3-a',
                expectedCatalogueItemRevision: first.items[0].catalogueItemRevision,
                catalogueRevision: first.catalogueRevision,
            })
            const assets = await studio.listStudioCardAssets({ captureRevision: capture.captureRevision })
            const access = await studio.resolveStudioCardAssetHandles({
                captureRevision: capture.captureRevision,
                logicalAssetIds: [assets.assets[0].logicalAssetId],
                purpose: 'selected',
            })
            await expect(reader.readContextAsset(access.assets[0].asset.assetId)).resolves.toMatchObject({
                data: new Uint8Array([4, 5, 6]),
            })
            await studio.releaseStudioCardAssetAccess(access.accessRevision)
            await studio.releaseStudioCardSource(capture.captureRevision)
            await studio.releaseStudioCardTarget(capture.targetRevision)
            await studio.releaseStudioCardCatalogue(first.catalogueRevision)

            stores.selIdState.selId = 1
            const second = await studio.listStudioCards({ limit: 24 })
            expect(second.hostActiveCard?.cardId).toBe('v3-b')
            expect(ensureCurrent).not.toHaveBeenCalled()
            expect(ensureHydrated).not.toHaveBeenCalled()
            expect(fetchLazy).not.toHaveBeenCalled()
            expect(normalize).not.toHaveBeenCalled()
            expect(imageRead).toHaveBeenCalledTimes(1)
        } finally {
            studio?.dispose()
            reader?.dispose()
            stores.DBState.db.characters = previousCharacters
            stores.selectedCharID.set(previousSelectedStore)
            stores.selIdState.selId = previousSelected
        }
    }, 30_000)
})

function contextPrincipal(h: Awaited<ReturnType<typeof harness>>) {
    return (h.studio as any).input.context.principalId as string
}

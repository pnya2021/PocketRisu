import { PluginApiError } from './errors'
import { sniffContextAssetMediaType } from './contextResources'
import type {
    BoundedThumbnailResult,
    CharacterTextSection,
    ContextAssetSource,
    ContextAssetCollectionInput,
    ContextAssetCollectionProbe,
    ContextAssetPageProbe,
    ContextAssetStateScope,
    ContextAssetSourceProbe,
    ContextCharacterSource,
    ContextHostState,
    ContextLoreSnapshot,
    ContextModuleCollection,
    ContextModuleSource,
    ContextModuleCollectionInput,
    ContextModuleCollectionProbe,
    ContextModulePageProbe,
    ContextModuleSourceProbe,
    ContextResourceAdapter,
} from './contextResources'
import type { ModuleActivationReason } from './moduleActivation'
import type { AssetManifestDescriptor, AssetManifestTuple } from '../../../storage/nodeStorage'

type UnknownRecord = Record<string, any>

interface ModuleSourceLocator {
    scope: 'active' | 'installed'
    ownerId: string
    rawSlotIndex: number
    lorebookFingerprint?: string
}

interface AssetSourceLocator {
    ownerKind: 'character' | 'module'
    ownerId: string
    ownerRawSlotIndex: number
    rawCollection: 'image' | 'emotionImages' | 'additionalAssets' | 'ccAssets' | 'assets'
    rawSlotIndex: number
    storageKey: string
    storageRevision: string
}

interface ProjectionContext {
    getStorageRevision(storageKey: string): string
    attachAsset(source: ContextAssetSource, locator: Omit<AssetSourceLocator, 'storageKey' | 'storageRevision'>): void
}

export interface PocketContextAdapterDependencies {
    getDatabase(): { characters?: UnknownRecord[]; modules?: UnknownRecord[] }
    getCurrentCharacter(): UnknownRecord | undefined
    hydrateCurrentChat(character: UnknownRecord): Promise<UnknownRecord | undefined>
    getActiveModulesWithReasons(): Array<{ module: UnknownRecord; activatedBy: ModuleActivationReason[] }>
    readImage(storageKey: string): Promise<Uint8Array | ArrayBuffer | ArrayBufferView | null | undefined>
    getAssetStorageRevision?(storageKey: string): string
    loadAssetManifestItems?(manifest: AssetManifestDescriptor): Promise<AssetManifestTuple[]>
    createThumbnail?: ContextResourceAdapter['createThumbnail']
}

// Keep lazy DB records lazy. Only detached projections receive the tuples;
// synchronous publication fences may use them only for the same descriptor.
export function createPocketAssetManifestProjection(
    load?: PocketContextAdapterDependencies['loadAssetManifestItems'],
) {
    const cache = new WeakMap<object, { revision: string; items: AssetManifestTuple[] }>()
    const changed = () => new PluginApiError('CONFLICT', 'Asset manifest changed or is unavailable', { retryable: true })
    const fields = (kind: 'character' | 'module') => kind === 'character'
        ? ['additionalAssets', 'additionalAssetManifest'] as const
        : ['assets', 'assetManifest'] as const
    const manifestOf = (raw: UnknownRecord, kind: 'character' | 'module') => {
        const [listKey, manifestKey] = fields(kind)
        const list = Object.getOwnPropertyDescriptor(raw, listKey)
        const descriptor = Object.getOwnPropertyDescriptor(raw, manifestKey)
        if (descriptor && !('value' in descriptor)) throw changed()
        if (!descriptor?.value || (list && 'value' in list && Array.isArray(list.value))) return undefined
        if (list && !('value' in list)) throw changed()
        const manifest = descriptor.value as AssetManifestDescriptor
        if (typeof manifest.id !== 'string' || !Number.isSafeInteger(manifest.count) || manifest.count < 0) throw changed()
        return manifest
    }
    const revisionOf = (manifest: AssetManifestDescriptor) => JSON.stringify(manifest)
    return {
        isLazy(raw: UnknownRecord, kind: 'character' | 'module') { return manifestOf(raw, kind) !== undefined },
        async prepare(raw: UnknownRecord, kind: 'character' | 'module') {
            const manifest = manifestOf(raw, kind)
            if (!manifest) return
            const revision = revisionOf(manifest)
            if (cache.get(raw)?.revision === revision) return
            if (!load) throw changed()
            // The official loader may refresh its argument on a superseded
            // manifest. Never let that mutate the live database descriptor.
            const detached = { ...manifest }
            let items: AssetManifestTuple[]
            try { items = await load(detached) } catch { throw changed() }
            const current = manifestOf(raw, kind)
            if (!current || revisionOf(current) !== revision || revisionOf(detached) !== revision
                || !Array.isArray(items) || items.length !== manifest.count
                || items.some((tuple) => !Array.isArray(tuple) || tuple.length < 2 || tuple.length > 3
                    || tuple.some((part) => typeof part !== 'string'))) throw changed()
            cache.set(raw, { revision, items: items.map((tuple) => [...tuple] as AssetManifestTuple) })
        },
        project(raw: UnknownRecord, kind: 'character' | 'module'): UnknownRecord {
            const manifest = manifestOf(raw, kind)
            if (!manifest) return raw
            const retained = cache.get(raw)
            if (!retained || retained.revision !== revisionOf(manifest)) throw changed()
            // Copy property descriptors, not values: Studio cards deliberately
            // must not touch chat getters or other unrelated native fields.
            const descriptors = Object.getOwnPropertyDescriptors(raw)
            descriptors[fields(kind)[0]] = { value: retained.items, writable: false, enumerable: true, configurable: true }
            return Object.create(Object.getPrototypeOf(raw), descriptors)
        },
    }
}

const extensionOf = (pathOrName?: string) => {
    if (!pathOrName) return undefined
    const clean = pathOrName.split(/[?#]/, 1)[0]
    const dot = clean.lastIndexOf('.')
    if (dot < 0 || dot === clean.length - 1) return undefined
    return clean.slice(dot + 1).toLowerCase()
}

const mediaTypeOf = (extension?: string) => {
    switch (extension?.toLowerCase()) {
        case 'png': return 'image/png'
        case 'jpg':
        case 'jpeg': return 'image/jpeg'
        case 'webp': return 'image/webp'
        case 'gif': return 'image/gif'
        case 'avif': return 'image/avif'
        case 'svg': return 'image/svg+xml'
        case 'mp3': return 'audio/mpeg'
        case 'wav': return 'audio/wav'
        case 'ogg': return 'audio/ogg'
        case 'mp4': return 'video/mp4'
        case 'webm': return 'video/webm'
        default: return undefined
    }
}

const nonEmptyString = (value: unknown): value is string => typeof value === 'string' && value.length > 0

const isCanonicalLocalAssetStorageKey = (value: unknown): value is string => {
    if (!nonEmptyString(value) || !value.startsWith('assets/')) return false
    const fileName = value.slice('assets/'.length)
    if (!fileName || fileName === '.' || fileName === '..' || fileName !== fileName.normalize('NFC')) return false
    if (fileName.trim() !== fileName || /[\u0000-\u001f\u007f<>:"/\\|?*]/u.test(fileName)) return false
    return value === `assets/${fileName}`
}

const mapLorebook = (value: unknown): ContextLoreSnapshot[] => {
    if (!Array.isArray(value)) return []
    return value.map((entry: UnknownRecord, index) => {
        const id = nonEmptyString(entry?.id) ? entry.id : `lore:${index}`
        return {
            id,
            name: nonEmptyString(entry?.comment) ? entry.comment
                : nonEmptyString(entry?.key) ? entry.key
                : id,
            content: typeof entry?.content === 'string' ? entry.content : '',
            enabled: entry?.mode !== 'folder',
        }
    })
}

const CHARACTER_TEXT_FIELDS: Array<{ key: string; label: string; source: string }> = [
    { key: 'description', label: 'Description', source: 'desc' },
    { key: 'personality', label: 'Personality', source: 'personality' },
    { key: 'scenario', label: 'Scenario', source: 'scenario' },
    { key: 'firstMessage', label: 'First message', source: 'firstMessage' },
    { key: 'exampleMessage', label: 'Example message', source: 'exampleMessage' },
    { key: 'creatorNotes', label: 'Creator notes', source: 'creatorNotes' },
    { key: 'systemPrompt', label: 'System prompt', source: 'systemPrompt' },
    { key: 'postHistoryInstructions', label: 'Post-history instructions', source: 'postHistoryInstructions' },
    { key: 'notes', label: 'Notes', source: 'notes' },
    { key: 'additionalText', label: 'Additional text', source: 'additionalText' },
]

const mapTextSections = (character: UnknownRecord): CharacterTextSection[] =>
    CHARACTER_TEXT_FIELDS.flatMap(({ key, label, source }) => nonEmptyString(character[source])
        ? [{ key, label, content: character[source] }]
        : [])

const makeAsset = (
    ownerKind: 'character' | 'module',
    ownerId: string,
    role: ContextAssetSource['role'],
    storageKey: string,
    name: string,
    explicitExtension?: string,
    storageRevision = storageKey,
): ContextAssetSource | null => {
    if (!isCanonicalLocalAssetStorageKey(storageKey)) return null
    const declaredExtension = explicitExtension?.replace(/^\./, '').toLowerCase()
    const extension = (extensionOf(declaredExtension) ?? declaredExtension)
        || extensionOf(name) || extensionOf(storageKey)
    return {
        identity: `${ownerKind}:${ownerId}:${storageKey}`,
        storageKey,
        storageRevision,
        name,
        ...(extension ? { extension } : {}),
        ...(mediaTypeOf(extension) ? { mediaType: mediaTypeOf(extension) } : {}),
        role,
    }
}

const mapCharacterAssets = (
    character: UnknownRecord,
    id: string,
    ownerRawSlotIndex = -1,
    context?: ProjectionContext,
): ContextAssetSource[] => {
    const assets: ContextAssetSource[] = []
    const retain = (
        asset: ContextAssetSource | null,
        rawCollection: AssetSourceLocator['rawCollection'],
        rawSlotIndex: number,
    ) => {
        if (!asset) return
        context?.attachAsset(asset, {
            ownerKind: 'character', ownerId: id, ownerRawSlotIndex, rawCollection, rawSlotIndex,
        })
        assets.push(asset)
    }
    if (nonEmptyString(character.image)) {
        retain(makeAsset(
            'character', id, 'portrait', character.image,
            `${character.name || id}.${extensionOf(character.image) || 'png'}`,
            undefined,
            context?.getStorageRevision(character.image),
        ), 'image', 0)
    }
    if (Array.isArray(character.emotionImages)) {
        character.emotionImages.forEach((entry: unknown, index: number) => {
            if (!Array.isArray(entry) || !nonEmptyString(entry[1])) return
            const name = nonEmptyString(entry[0]) ? entry[0] : `emotion-${index}`
            retain(makeAsset(
                'character', id, 'emotion', entry[1], `${name}.${extensionOf(entry[1]) || 'png'}`,
                undefined, context?.getStorageRevision(entry[1]),
            ), 'emotionImages', index)
        })
    }
    if (Array.isArray(character.additionalAssets)) {
        character.additionalAssets.forEach((entry: unknown, index: number) => {
            if (!Array.isArray(entry) || !nonEmptyString(entry[1])) return
            const name = nonEmptyString(entry[0]) ? entry[0] : `additional-${index}`
            const extension = nonEmptyString(entry[2]) ? entry[2] : undefined
            retain(makeAsset(
                'character', id, 'additional', entry[1], name, extension,
                context?.getStorageRevision(entry[1]),
            ), 'additionalAssets', index)
        })
    }
    if (Array.isArray(character.ccAssets)) {
        character.ccAssets.forEach((entry: UnknownRecord, index: number) => {
            if (!nonEmptyString(entry?.uri)) return
            const name = nonEmptyString(entry?.name) ? entry.name : `card-asset-${index}`
            const extension = nonEmptyString(entry?.ext) ? entry.ext : extensionOf(entry.uri)
            retain(makeAsset(
                'character', id, 'additional', entry.uri, name, extension,
                context?.getStorageRevision(entry.uri),
            ), 'ccAssets', index)
        })
    }
    return assets
}

const mapCharacterAssetAt = (
    character: UnknownRecord,
    locator: AssetSourceLocator,
    context?: ProjectionContext,
) => {
    const id = character.chaId
    if (!nonEmptyString(id)) return null
    const attach = (asset: ContextAssetSource | null) => {
        if (asset) context?.attachAsset(asset, {
            ownerKind: locator.ownerKind,
            ownerId: locator.ownerId,
            ownerRawSlotIndex: locator.ownerRawSlotIndex,
            rawCollection: locator.rawCollection,
            rawSlotIndex: locator.rawSlotIndex,
        })
        return asset
    }
    switch (locator.rawCollection) {
        case 'image': {
            if (!nonEmptyString(character.image)) return null
            const asset = makeAsset(
                'character', id, 'portrait', character.image,
                `${character.name || id}.${extensionOf(character.image) || 'png'}`,
                undefined, context?.getStorageRevision(character.image),
            )
            return attach(asset)
        }
        case 'emotionImages': {
            const entry = Array.isArray(character.emotionImages)
                ? character.emotionImages[locator.rawSlotIndex] : undefined
            if (!Array.isArray(entry) || !nonEmptyString(entry[1])) return null
            const name = nonEmptyString(entry[0]) ? entry[0] : `emotion-${locator.rawSlotIndex}`
            const asset = makeAsset(
                'character', id, 'emotion', entry[1], `${name}.${extensionOf(entry[1]) || 'png'}`,
                undefined, context?.getStorageRevision(entry[1]),
            )
            return attach(asset)
        }
        case 'additionalAssets': {
            const entry = Array.isArray(character.additionalAssets)
                ? character.additionalAssets[locator.rawSlotIndex] : undefined
            if (!Array.isArray(entry) || !nonEmptyString(entry[1])) return null
            const name = nonEmptyString(entry[0]) ? entry[0] : `additional-${locator.rawSlotIndex}`
            const extension = nonEmptyString(entry[2]) ? entry[2] : undefined
            const asset = makeAsset(
                'character', id, 'additional', entry[1], name, extension,
                context?.getStorageRevision(entry[1]),
            )
            return attach(asset)
        }
        case 'ccAssets': {
            const entry = Array.isArray(character.ccAssets) ? character.ccAssets[locator.rawSlotIndex] : undefined
            if (!entry || !nonEmptyString(entry.uri)) return null
            const name = nonEmptyString(entry.name) ? entry.name : `card-asset-${locator.rawSlotIndex}`
            const extension = nonEmptyString(entry.ext) ? entry.ext : extensionOf(entry.uri)
            const asset = makeAsset(
                'character', id, 'additional', entry.uri, name, extension,
                context?.getStorageRevision(entry.uri),
            )
            return attach(asset)
        }
        default: return null
    }
}

const mapCharacter = (
    character: UnknownRecord,
    ownerRawSlotIndex = -1,
    context?: ProjectionContext,
): ContextCharacterSource | null => {
    if (!nonEmptyString(character?.chaId) || typeof character?.name !== 'string') return null
    const type = character.type === 'group' ? 'group' : 'character'
    return {
        id: character.chaId,
        type,
        name: character.name,
        textSections: mapTextSections(character),
        lorebook: mapLorebook(character.globalLore),
        ...(type === 'group' && Array.isArray(character.characters)
            ? { groupMemberIds: character.characters.filter(nonEmptyString) }
            : {}),
        assets: mapCharacterAssets(character, character.chaId, ownerRawSlotIndex, context),
    }
}

const mapModuleAssetAt = (
    module: UnknownRecord,
    ownerRawSlotIndex: number,
    rawSlotIndex: number,
    context?: ProjectionContext,
) => {
    const entry = Array.isArray(module.assets) ? module.assets[rawSlotIndex] : undefined
    if (!Array.isArray(entry) || !nonEmptyString(entry[1]) || !nonEmptyString(module.id)) return null
    const name = nonEmptyString(entry[0]) ? entry[0] : `module-asset-${rawSlotIndex}`
    const extension = nonEmptyString(entry[2]) ? entry[2] : undefined
    const asset = makeAsset(
        'module', module.id, 'module', entry[1], name, extension,
        context?.getStorageRevision(entry[1]),
    )
    if (asset) context?.attachAsset(asset, {
        ownerKind: 'module', ownerId: module.id, ownerRawSlotIndex,
        rawCollection: 'assets', rawSlotIndex,
    })
    return asset
}

const mapModule = (
    module: UnknownRecord,
    activatedBy: ModuleActivationReason[],
    ownerRawSlotIndex = -1,
    context?: ProjectionContext,
    includeAssets = true,
): ContextModuleSource | null => {
    if (!nonEmptyString(module?.id) || !nonEmptyString(module?.name)) return null
    const assets = includeAssets && Array.isArray(module.assets)
        ? module.assets.flatMap((_entry: unknown, index: number) => {
            const asset = mapModuleAssetAt(module, ownerRawSlotIndex, index, context)
            return asset ? [asset] : []
        })
        : []
    return {
        id: module.id,
        ...(nonEmptyString(module.namespace) ? { namespace: module.namespace } : {}),
        name: module.name,
        description: typeof module.description === 'string' ? module.description : '',
        lorebook: mapLorebook(module.lorebook),
        assets,
        activatedBy: [...activatedBy],
    }
}

const normalizeBinary = (value: Uint8Array | ArrayBuffer | ArrayBufferView | null | undefined) => {
    if (value instanceof Uint8Array) return value.slice()
    if (value instanceof ArrayBuffer) return new Uint8Array(value.slice(0))
    if (ArrayBuffer.isView(value)) {
        return new Uint8Array(value.buffer.slice(value.byteOffset, value.byteOffset + value.byteLength))
    }
    throw new PluginApiError('NOT_FOUND', 'Asset bytes were not found')
}

const assertNotAborted = (signal?: AbortSignal) => {
    if (signal?.aborted) throw new PluginApiError('ABORTED', 'Context asset operation was cancelled')
}

export function createPocketContextResourceAdapter(
    dependencies: PocketContextAdapterDependencies,
): ContextResourceAdapter {
    const manifests = createPocketAssetManifestProjection(dependencies.loadAssetManifestItems)
    const moduleLocators = new WeakMap<ContextModuleSource, ModuleSourceLocator>()
    const moduleAssetMetadataSources = new WeakSet<ContextModuleSource>()
    const assetLocators = new WeakMap<ContextAssetSource, AssetSourceLocator>()
    const projectionContext: ProjectionContext = {
        getStorageRevision: (storageKey) => dependencies.getAssetStorageRevision?.(storageKey) ?? storageKey,
        attachAsset(source, locator) {
            assetLocators.set(source, {
                ...locator,
                storageKey: source.storageKey,
                storageRevision: source.storageRevision ?? source.storageKey,
            })
        },
    }
    const changed = () => new PluginApiError(
        'CONFLICT', 'Current context changed while the operation was running', { retryable: true },
    )
    const stableHydrations = new WeakMap<UnknownRecord, {
        chatPage: string | number
        chat: UnknownRecord | undefined
        rawChatSlot: unknown
    }>()
    const hydrateStableCurrent = async (signal?: AbortSignal) => {
        for (let attempt = 0; attempt < 4; attempt++) {
            assertNotAborted(signal)
            const currentCharacter = dependencies.getCurrentCharacter()
            if (!currentCharacter) return {
                currentCharacter: undefined,
                currentChat: undefined,
            }
            const chatPage = currentCharacter.chatPage as string | number
            const currentChat = await dependencies.hydrateCurrentChat(currentCharacter)
            assertNotAborted(signal)
            const rawChatSlot = currentCharacter.chats?.[chatPage]
            if (dependencies.getCurrentCharacter() === currentCharacter
                && currentCharacter.chatPage === chatPage
                && (!currentChat || rawChatSlot === currentChat)) {
                stableHydrations.set(currentCharacter, { chatPage, chat: currentChat, rawChatSlot })
                return { currentCharacter, currentChat }
            }
        }
        throw new PluginApiError('CONFLICT', 'Current context changed repeatedly during hydration', {
            retryable: true,
        })
    }
    const stableCurrentSynchronously = () => {
        const currentCharacter = dependencies.getCurrentCharacter()
        if (!currentCharacter) return {
            currentCharacter: undefined,
            currentChat: undefined,
        }
        const stable = stableHydrations.get(currentCharacter)
        if (!stable
            || currentCharacter.chatPage !== stable.chatPage
            || currentCharacter.chats?.[stable.chatPage] !== stable.rawChatSlot) throw changed()
        return { currentCharacter, currentChat: stable.chat }
    }
    const selectorsFrom = (
        currentCharacter: UnknownRecord | undefined,
        currentChat: UnknownRecord | undefined,
        characterId: string | undefined,
        conversationId: string | undefined,
        allowMissing: boolean,
    ) => {
        if (!currentCharacter || !currentChat) {
            if (allowMissing && characterId === undefined && conversationId === undefined) {
                return { characterId: null, conversationId: null }
            }
            throw new PluginApiError('NOT_FOUND', 'No current character or conversation')
        }
        if (!nonEmptyString(currentCharacter.chaId) || !nonEmptyString(currentChat.id)) {
            throw new PluginApiError('INTERNAL', 'Current context IDs were not normalized during database load')
        }
        const authorized = new Set([currentCharacter.chaId])
        if (currentCharacter.type === 'group' && Array.isArray(currentCharacter.characters)) {
            const validCharacterIds = new Set((dependencies.getDatabase().characters ?? []).flatMap((character) =>
                character?.type !== 'group'
                    && nonEmptyString(character?.chaId)
                    && typeof character?.name === 'string'
                    ? [character.chaId] : []))
            for (const memberId of currentCharacter.characters) {
                if (nonEmptyString(memberId) && validCharacterIds.has(memberId)) authorized.add(memberId)
            }
        }
        const selectedCharacterId = characterId ?? currentCharacter.chaId
        const selectedConversationId = conversationId ?? currentChat.id
        if (!authorized.has(selectedCharacterId)) {
            throw new PluginApiError('PERMISSION_DENIED', 'Character is outside the current context')
        }
        if (selectedConversationId !== currentChat.id) {
            throw new PluginApiError('PERMISSION_DENIED', 'Conversation is outside the current context')
        }
        return { characterId: selectedCharacterId, conversationId: selectedConversationId }
    }
    const selectorsFor = async (
        characterId: string | undefined,
        conversationId: string | undefined,
        allowMissing: boolean,
        signal?: AbortSignal,
    ) => {
        const { currentCharacter, currentChat } = await hydrateStableCurrent(signal)
        assertNotAborted(signal)
        return selectorsFrom(currentCharacter, currentChat, characterId, conversationId, allowMissing)
    }
    const selectorsForSynchronously = (
        characterId: string | undefined,
        conversationId: string | undefined,
        allowMissing: boolean,
    ) => {
        const { currentCharacter, currentChat } = stableCurrentSynchronously()
        return selectorsFrom(currentCharacter, currentChat, characterId, conversationId, allowMissing)
    }
    const sameSource = (left: ContextAssetSource, right: ContextAssetSource) =>
        JSON.stringify(left) === JSON.stringify(right)
    const sameSelectors = (
        left: { characterId: string | null; conversationId: string | null },
        right: { characterId: string | null; conversationId: string | null },
    ) => left.characterId === right.characterId && left.conversationId === right.conversationId
    const assetShapeKey = (
        source: ContextAssetSource,
        origin: { kind: 'character'; characterId: string } | { kind: 'module'; moduleId: string },
    ) => JSON.stringify([
        origin.kind,
        origin.kind === 'character' ? origin.characterId : origin.moduleId,
        source.identity,
        source.storageKey,
        source.name,
        source.extension ?? null,
        source.mediaType ?? null,
        source.byteLength ?? null,
        source.role,
    ])
    const rawLorebookFingerprint = (module: UnknownRecord) => {
        const descriptor = Object.getOwnPropertyDescriptor(module, 'lorebook')
        return descriptor && 'value' in descriptor ? JSON.stringify(descriptor.value) : undefined
    }
    const currentModuleRecords = (scope: 'active' | 'installed') => {
        const activeRecords = dependencies.getActiveModulesWithReasons()
        const activeById = new Map(activeRecords.flatMap(({ module, activatedBy }) =>
            nonEmptyString(module?.id) ? [[module.id, activatedBy] as const] : []))
        return scope === 'installed'
            ? (dependencies.getDatabase().modules ?? []).map((module, rawSlotIndex) => ({
                module, activatedBy: activeById.get(module?.id) ?? [], rawSlotIndex,
            }))
            : activeRecords.map(({ module, activatedBy }, rawSlotIndex) => ({
                module, activatedBy, rawSlotIndex,
            }))
    }
    const revalidateModuleRecord = (
        source: ContextModuleSource,
        locator: ModuleSourceLocator,
        raw: UnknownRecord | undefined,
        activatedBy: ModuleActivationReason[],
        includeAssetMetadata: boolean,
        signal?: AbortSignal,
    ) => {
        if (!raw || raw.id !== locator.ownerId) throw changed()
        if (includeAssetMetadata) raw = manifests.project(raw, 'module')
        const namespace = nonEmptyString(raw.namespace) ? raw.namespace : undefined
        const description = typeof raw.description === 'string' ? raw.description : ''
        const currentAssets = includeAssetMetadata && Array.isArray(raw.assets)
            ? raw.assets.flatMap((_entry: unknown, index: number) => {
                assertNotAborted(signal)
                const current = mapModuleAssetAt(raw, locator.rawSlotIndex, index, projectionContext)
                return current ? [current] : []
            })
            : []
        if (raw.name !== source.name
            || namespace !== source.namespace
            || description !== source.description
            || JSON.stringify(activatedBy) !== JSON.stringify(source.activatedBy)
            || (includeAssetMetadata && (currentAssets.length !== source.assets.length
                || currentAssets.some((current, index) => !sameSource(current, source.assets[index]))))
            || (locator.lorebookFingerprint !== undefined
                && rawLorebookFingerprint(raw) !== locator.lorebookFingerprint)) throw changed()
    }
    const currentAssetShape = async (probe: ContextAssetCollectionProbe) => {
        const selectors = await selectorsFor(
            probe.input.characterIds[0], probe.input.conversationId || undefined, false, probe.input.signal,
        ) as { characterId: string; conversationId: string }
        if (!sameSelectors(selectors, probe.selectors)) throw changed()
        const { currentCharacter } = stableCurrentSynchronously()
        const database = dependencies.getDatabase()
        const entries: string[] = []
        if (probe.input.include.some((role) => role !== 'module')) {
            for (const characterId of probe.input.characterIds) {
                const rawSlotIndex = (database.characters ?? [])
                    .findIndex((character) => character?.chaId === characterId)
                const raw = rawSlotIndex >= 0
                    ? database.characters![rawSlotIndex]
                    : currentCharacter?.chaId === characterId ? currentCharacter : undefined
                if (!raw) throw changed()
                const projected = probe.input.include.includes('additional') ? manifests.project(raw, 'character') : raw
                for (const source of mapCharacterAssets(projected, characterId, rawSlotIndex)) {
                    if (probe.input.include.includes(source.role)) {
                        entries.push(assetShapeKey(source, { kind: 'character', characterId }))
                    }
                }
            }
        }
        if (probe.input.include.includes('module') && probe.input.moduleScope !== 'none') {
            const records = currentModuleRecords(probe.input.moduleScope)
                .filter(({ module }) => !probe.input.moduleIdsSpecified
                    || probe.input.moduleIds.includes(module?.id))
            for (const record of records) {
                const { rawSlotIndex } = record
                const module = manifests.project(record.module, 'module')
                if (!nonEmptyString(module?.id) || !Array.isArray(module.assets)) continue
                for (let index = 0; index < module.assets.length; index++) {
                    const source = mapModuleAssetAt(module, rawSlotIndex, index)
                    if (source) entries.push(assetShapeKey(source, { kind: 'module', moduleId: module.id }))
                }
            }
        }
        return entries
    }

    const captureModuleSourcesFrom = (
        input: ContextModuleCollectionInput,
        includeAssetMetadata: boolean,
        selectors: ContextModuleCollection['selectors'],
    ): ContextModuleCollection => {
        assertNotAborted(input.signal)
        if (input.scope !== 'active' && input.scope !== 'installed') {
            throw new PluginApiError('INVALID_ARGUMENT', 'Invalid module scope')
        }
        const activeRecords = dependencies.getActiveModulesWithReasons()
        const activeById = new Map(activeRecords.flatMap(({ module, activatedBy }) =>
            nonEmptyString(module?.id) ? [[module.id, activatedBy] as const] : []))
        const records = input.scope === 'installed'
            ? (dependencies.getDatabase().modules ?? []).map((module, rawSlotIndex) => ({
                module, activatedBy: activeById.get(module?.id) ?? [], rawSlotIndex,
            }))
            : activeRecords.map(({ module, activatedBy }, rawSlotIndex) => ({
                module, activatedBy, rawSlotIndex,
            }))
        const modules = records.flatMap(({ module, activatedBy, rawSlotIndex }) => {
            assertNotAborted(input.signal)
            const source = mapModule(
                includeAssetMetadata ? manifests.project(module, 'module') : module,
                activatedBy,
                rawSlotIndex,
                projectionContext,
                includeAssetMetadata,
            )
            if (!source) return []
            moduleLocators.set(source, {
                scope: input.scope,
                ownerId: source.id,
                rawSlotIndex,
                lorebookFingerprint: rawLorebookFingerprint(module),
            })
            if (includeAssetMetadata) moduleAssetMetadataSources.add(source)
            return [source]
        })
        assertNotAborted(input.signal)
        return { selectors, modules }
    }

    const revalidateModuleMembership = (probe: ContextModuleCollectionProbe) => {
        assertNotAborted(probe.input.signal)
        const selectors = selectorsForSynchronously(
            probe.input.characterId,
            probe.input.conversationId,
            probe.input.scope === 'installed',
        )
        if (!sameSelectors(selectors, probe.selectors)) throw changed()
        const records = currentModuleRecords(probe.input.scope).filter(({ module }) =>
            nonEmptyString(module?.id) && nonEmptyString(module?.name))
        if (records.length !== probe.sources.length) throw changed()
        for (let index = 0; index < records.length; index++) {
            assertNotAborted(probe.input.signal)
            const source = probe.sources[index]
            const record = records[index]
            const locator = moduleLocators.get(source)
            if (!locator
                || locator.scope !== probe.input.scope
                || locator.ownerId !== source.id
                || locator.ownerId !== record.module.id
                || locator.rawSlotIndex !== record.rawSlotIndex) throw changed()
        }
        assertNotAborted(probe.input.signal)
        return records
    }

    const revalidateModulePage = (probe: ContextModulePageProbe) => {
        const records = revalidateModuleMembership(probe)
        const capturedSources = new Set(probe.sources)
        const recordsByRawSlot = new Map(records.map((record) => [record.rawSlotIndex, record]))
        for (const source of probe.pageSources) {
            assertNotAborted(probe.input.signal)
            const locator = moduleLocators.get(source)
            const record = locator ? recordsByRawSlot.get(locator.rawSlotIndex) : undefined
            if (!locator
                || !capturedSources.has(source)
                || locator.scope !== probe.input.scope
                || locator.ownerId !== source.id
                || record?.module.id !== source.id) throw changed()
            revalidateModuleRecord(
                source,
                locator,
                record.module,
                record.activatedBy,
                moduleAssetMetadataSources.has(source),
                probe.input.signal,
            )
        }
        assertNotAborted(probe.input.signal)
    }

    const assetRevalidationState = (
        input: ContextAssetCollectionInput,
        pageSources: readonly ContextAssetSourceProbe['located'][],
    ) => ({
        database: dependencies.getDatabase(),
        currentCharacter: stableCurrentSynchronously().currentCharacter,
        activeModuleRecords: input.moduleScope === 'active'
            && pageSources.some(({ origin }) => origin.kind === 'module')
            ? dependencies.getActiveModulesWithReasons()
            : undefined,
    })

    const revalidateAssetRecord = (
        probe: ContextAssetSourceProbe,
        state: ReturnType<typeof assetRevalidationState>,
    ) => {
        const locator = assetLocators.get(probe.located.source)
        if (!locator
            || locator.ownerKind !== probe.located.origin.kind
            || locator.ownerId !== (probe.located.origin.kind === 'character'
                ? probe.located.origin.characterId : probe.located.origin.moduleId)
            || locator.storageKey !== probe.located.source.storageKey
            || locator.storageRevision !== (probe.located.source.storageRevision ?? probe.located.source.storageKey)) {
            throw changed()
        }
        let current: ContextAssetSource | null = null
        if (locator.ownerKind === 'module') {
            if (probe.input.moduleScope === 'none'
                || (probe.input.moduleIdsSpecified && !probe.input.moduleIds.includes(locator.ownerId))) {
                throw changed()
            }
            const raw = probe.input.moduleScope === 'installed'
                ? state.database.modules?.[locator.ownerRawSlotIndex]
                : state.activeModuleRecords?.[locator.ownerRawSlotIndex]?.module
            if (!raw || raw.id !== locator.ownerId) throw changed()
            current = mapModuleAssetAt(manifests.project(raw, 'module'), locator.ownerRawSlotIndex, locator.rawSlotIndex, projectionContext)
        } else {
            if (probe.input.characterIds.length > 0
                && !probe.input.characterIds.includes(locator.ownerId)) throw changed()
            const raw = locator.ownerRawSlotIndex >= 0
                ? state.database.characters?.[locator.ownerRawSlotIndex]
                : state.currentCharacter
            if (!raw || raw.chaId !== locator.ownerId) throw changed()
            current = mapCharacterAssetAt(locator.rawCollection === 'additionalAssets'
                ? manifests.project(raw, 'character') : raw, locator, projectionContext)
        }
        if (!current || !sameSource(current, probe.located.source)) throw changed()
        return current
    }

    const revalidateAssetPage = (probe: ContextAssetPageProbe) => {
        assertNotAborted(probe.input.signal)
        const selectors = selectorsForSynchronously(
            probe.input.characterIds[0],
            probe.input.conversationId || undefined,
            false,
        ) as { characterId: string; conversationId: string }
        if (!sameSelectors(selectors, probe.selectors)) throw changed()
        const state = assetRevalidationState(probe.input, probe.pageSources)
        for (const located of probe.pageSources) {
            assertNotAborted(probe.input.signal)
            revalidateAssetRecord({ located, input: probe.input }, state)
        }
        assertNotAborted(probe.input.signal)
    }

    return {
        async resolveCollectionSelectors(input) {
            assertNotAborted(input.signal)
            const selectors = await selectorsFor(
                input.characterId,
                input.conversationId,
                input.allowMissingCurrent,
                input.signal,
            )
            assertNotAborted(input.signal)
            return selectors
        },
        async getState(assetScope?: ContextAssetStateScope): Promise<ContextHostState> {
            const { currentCharacter, currentChat } = await hydrateStableCurrent(assetScope?.signal)
            let database = dependencies.getDatabase()
            const prepared = new Set<UnknownRecord>()
            if (assetScope) {
                const selectors = selectorsFrom(currentCharacter, currentChat,
                    assetScope.characterId, assetScope.conversationId, false)
                const prepare = async (raw: UnknownRecord, kind: 'character' | 'module') => {
                    await manifests.prepare(raw, kind)
                    prepared.add(raw)
                }
                if (assetScope.include.includes('additional')) {
                    const raw = database.characters?.find((character) => character?.chaId === selectors.characterId)
                        ?? (currentCharacter?.chaId === selectors.characterId ? currentCharacter : undefined)
                    if (raw) await prepare(raw, 'character')
                }
                if (assetScope.include.includes('module') && assetScope.moduleScope !== 'none') {
                    const records = currentModuleRecords(assetScope.moduleScope)
                        .filter(({ module }) => assetScope.moduleId === undefined || module?.id === assetScope.moduleId)
                    await Promise.all(records.map(({ module }) => prepare(module, 'module')))
                }
                assertNotAborted(assetScope.signal)
                if (!sameSelectors(selectors, selectorsForSynchronously(
                    assetScope.characterId, assetScope.conversationId, false,
                ))) throw changed()
                database = dependencies.getDatabase()
            }
            const project = (raw: UnknownRecord, kind: 'character' | 'module') =>
                prepared.has(raw) ? manifests.project(raw, kind) : raw
            let current: ContextHostState['current']
            if (currentCharacter && currentChat) {
                if (!nonEmptyString(currentCharacter.chaId) || !nonEmptyString(currentChat.id)) {
                    throw new PluginApiError('INTERNAL', 'Current context IDs were not normalized during database load')
                }
                current = {
                    characterId: currentCharacter.chaId,
                    conversation: {
                        id: currentChat.id,
                        localLorebook: mapLorebook(currentChat.localLore),
                        selectedModuleIds: Array.isArray(currentChat.modules)
                            ? currentChat.modules.filter(nonEmptyString)
                            : [],
                        messageMembership: Array.isArray(currentChat.message)
                            ? currentChat.message.map((message: UnknownRecord, index: number) =>
                                nonEmptyString(message?.chatId) ? message.chatId : `legacy-message:${index}`)
                            : [],
                    },
                    ...(nonEmptyString(currentChat.bindedPersona) ? { personaId: currentChat.bindedPersona } : {}),
                }
            }

            const characters = (database.characters ?? [])
                .map((character, index) => mapCharacter(project(character, 'character'), index, projectionContext))
                .filter((value): value is ContextCharacterSource => value !== null)
            if (currentCharacter && current && !characters.some((character) => character.id === current.characterId)) {
                const projected = mapCharacter(project(currentCharacter, 'character'), -1, projectionContext)
                if (projected) characters.unshift(projected)
            }
            const validCharacterIds = new Set(characters
                .filter((character) => character.type === 'character')
                .map((character) => character.id))
            for (const character of characters) {
                if (character.type !== 'group') continue
                const seen = new Set<string>()
                character.groupMemberIds = (character.groupMemberIds ?? []).filter((id) => {
                    if (!validCharacterIds.has(id) || seen.has(id)) return false
                    seen.add(id)
                    return true
                })
            }

            const activeRecords = dependencies.getActiveModulesWithReasons()
            const activeModules = activeRecords
                .map(({ module, activatedBy }, index) => mapModule(project(module, 'module'), activatedBy, index, projectionContext))
                .filter((value): value is ContextModuleSource => value !== null)
            const activeById = new Map(activeModules.map((module) => [module.id, module.activatedBy]))
            const installedModules = (database.modules ?? [])
                .map((module, index) => mapModule(project(module, 'module'), activeById.get(module.id) ?? [], index, projectionContext))
                .filter((value): value is ContextModuleSource => value !== null)
            return {
                ...(current ? { current } : {}),
                characters,
                activeModules,
                installedModules,
            }
        },
        async captureModuleSources(input: ContextModuleCollectionInput) {
            const selectors = await selectorsFor(
                input.characterId, input.conversationId, input.scope === 'installed', input.signal,
            )
            await Promise.all(currentModuleRecords(input.scope).map(({ module }) => manifests.prepare(module, 'module')))
            assertNotAborted(input.signal)
            if (!sameSelectors(selectors, selectorsForSynchronously(
                input.characterId, input.conversationId, input.scope === 'installed',
            ))) throw changed()
            return captureModuleSourcesFrom(input, true, selectors)
        },
        async prepareModuleAssets(input: ContextModuleCollectionInput) {
            await Promise.all(currentModuleRecords(input.scope).map(({ module }) => manifests.prepare(module, 'module')))
            assertNotAborted(input.signal)
        },
        captureModuleSourcesSynchronously(
            input: ContextModuleCollectionInput,
            options: { includeAssetMetadata: boolean },
        ) {
            const selectors = selectorsForSynchronously(
                input.characterId, input.conversationId, input.scope === 'installed',
            )
            return captureModuleSourcesFrom(input, options.includeAssetMetadata, selectors)
        },
        async revalidateModuleSource(probe: ContextModuleSourceProbe) {
            assertNotAborted(probe.input.signal)
            const locator = moduleLocators.get(probe.source)
            if (!locator || locator.scope !== probe.input.scope || locator.ownerId !== probe.source.id) throw changed()
            await selectorsFor(
                probe.input.characterId,
                probe.input.conversationId,
                probe.input.scope === 'installed',
                probe.input.signal,
            )
            const activeRecords = dependencies.getActiveModulesWithReasons()
            let raw: UnknownRecord | undefined
            let activatedBy: ModuleActivationReason[] = []
            if (locator.scope === 'installed') {
                raw = dependencies.getDatabase().modules?.[locator.rawSlotIndex]
                activatedBy = activeRecords.find(({ module }) => module?.id === locator.ownerId)?.activatedBy ?? []
            } else {
                const record = activeRecords[locator.rawSlotIndex]
                raw = record?.module
                activatedBy = record?.activatedBy ?? []
            }
            revalidateModuleRecord(
                probe.source,
                locator,
                raw,
                activatedBy,
                moduleAssetMetadataSources.has(probe.source),
                probe.input.signal,
            )
            assertNotAborted(probe.input.signal)
            return probe.source
        },
        async revalidateModuleCollection(probe: ContextModuleCollectionProbe) {
            await selectorsFor(
                probe.input.characterId,
                probe.input.conversationId,
                probe.input.scope === 'installed',
                probe.input.signal,
            )
            revalidateModuleMembership(probe)
        },
        revalidateModulePageSynchronously(probe: ContextModulePageProbe) {
            revalidateModulePage(probe)
        },
        async captureAssetSources(input: ContextAssetCollectionInput) {
            assertNotAborted(input.signal)
            if (!Array.isArray(input.characterIds)) {
                throw new PluginApiError('INVALID_ARGUMENT', 'Character IDs must be an array')
            }
            const { currentCharacter, currentChat } = await hydrateStableCurrent(input.signal)
            const defaultCharacterId = currentCharacter?.chaId
            const characterIds = input.characterIds.length > 0
                ? [...input.characterIds]
                : nonEmptyString(defaultCharacterId) ? [defaultCharacterId] : []
            for (const characterId of characterIds) {
                selectorsFrom(currentCharacter, currentChat, characterId, input.conversationId || undefined, false)
            }
            const selectors = selectorsFrom(
                currentCharacter, currentChat, characterIds[0], input.conversationId || undefined, false,
            ) as {
                characterId: string
                conversationId: string
            }
            const database = dependencies.getDatabase()
            const includeCharacterAssets = input.include.some((role) => role !== 'module')
            if (input.include.includes('additional')) {
                await Promise.all(characterIds.map(async (characterId) => {
                    const raw = database.characters?.find((character) => character?.chaId === characterId)
                        ?? (currentCharacter?.chaId === characterId ? currentCharacter : undefined)
                    if (raw) await manifests.prepare(raw, 'character')
                }))
                assertNotAborted(input.signal)
            }
            const characters = (includeCharacterAssets ? characterIds : []).flatMap((characterId) => {
                let rawSlotIndex = (database.characters ?? []).findIndex((character) => character?.chaId === characterId)
                const raw = rawSlotIndex >= 0
                    ? database.characters![rawSlotIndex]
                    : currentCharacter?.chaId === characterId ? currentCharacter : undefined
                if (!raw) throw new PluginApiError('NOT_FOUND', 'Character was not found')
                const projected = mapCharacter(input.include.includes('additional')
                    ? manifests.project(raw, 'character') : raw, rawSlotIndex, projectionContext)
                if (!projected) throw new PluginApiError('NOT_FOUND', 'Character was not found')
                return projected.assets.map((source) => ({
                    source,
                    origin: { kind: 'character' as const, characterId },
                }))
            })
            let moduleRecords: Array<{
                module: UnknownRecord
                activatedBy: ModuleActivationReason[]
                rawSlotIndex: number
            }> = []
            if (input.moduleScope === 'installed') {
                const activeById = new Map(dependencies.getActiveModulesWithReasons().flatMap(({ module, activatedBy }) =>
                    nonEmptyString(module?.id) ? [[module.id, activatedBy] as const] : []))
                moduleRecords = (database.modules ?? []).flatMap((module, rawSlotIndex) =>
                    !input.moduleIdsSpecified || input.moduleIds.includes(module?.id)
                        ? [{ module, activatedBy: activeById.get(module?.id) ?? [], rawSlotIndex }]
                        : [])
            } else if (input.moduleScope === 'active') {
                moduleRecords = dependencies.getActiveModulesWithReasons().flatMap(
                    ({ module, activatedBy }, rawSlotIndex) =>
                        !input.moduleIdsSpecified || input.moduleIds.includes(module?.id)
                            ? [{ module, activatedBy, rawSlotIndex }] : [],
                )
            }
            if (input.include.includes('module')) {
                await Promise.all(moduleRecords.map(({ module }) => manifests.prepare(module, 'module')))
                assertNotAborted(input.signal)
            }
            const modules = (input.include.includes('module') ? moduleRecords : []).flatMap(({ module, activatedBy, rawSlotIndex }) => {
                assertNotAborted(input.signal)
                const projected = mapModule(manifests.project(module, 'module'), activatedBy, rawSlotIndex, projectionContext)
                if (!projected) return []
                return projected.assets.map((source) => ({
                    source,
                    origin: { kind: 'module' as const, moduleId: projected.id },
                }))
            })
            const assets = [...characters, ...modules]
                .filter(({ source }) => input.include.includes(source.role))
            assertNotAborted(input.signal)
            if (!sameSelectors(selectors, selectorsForSynchronously(
                characterIds[0], input.conversationId || undefined, false,
            ))) throw changed()
            return { selectors, assets }
        },
        async revalidateAssetSource(probe: ContextAssetSourceProbe) {
            assertNotAborted(probe.input.signal)
            await selectorsFor(
                probe.input.characterIds[0],
                probe.input.conversationId || undefined,
                false,
                probe.input.signal,
            )
            const current = revalidateAssetRecord(
                probe,
                assetRevalidationState(probe.input, [probe.located]),
            )
            assertNotAborted(probe.input.signal)
            return current
        },
        async revalidateAssetCollection(probe: ContextAssetCollectionProbe) {
            assertNotAborted(probe.input.signal)
            const expected = probe.sources.map(({ source, origin }) => assetShapeKey(source, origin))
            const current = await currentAssetShape(probe)
            if (JSON.stringify(current) !== JSON.stringify(expected)) throw changed()
            assertNotAborted(probe.input.signal)
        },
        revalidateAssetPageSynchronously(probe: ContextAssetPageProbe) {
            revalidateAssetPage(probe)
        },
        async readAsset(source, signal) {
            assertNotAborted(signal)
            const storageKey = source.storageKey
            if (!isCanonicalLocalAssetStorageKey(storageKey)) {
                throw new PluginApiError('NOT_FOUND', 'Asset storage key is unavailable')
            }
            const value = await dependencies.readImage(storageKey)
            assertNotAborted(signal)
            return normalizeBinary(value)
        },
        async createThumbnail(source, data, constraints, signal) {
            assertNotAborted(signal)
            if (dependencies.createThumbnail) {
                const result = await dependencies.createThumbnail(source, data, constraints, signal)
                assertNotAborted(signal)
                return result
            }
            const mediaType = sniffContextAssetMediaType(data)
                ?? source.mediaType
                ?? mediaTypeOf(source.extension)
                ?? 'application/octet-stream'
            const result = await createBoundedContextThumbnail(
                data, mediaType, constraints, browserThumbnailEnvironment, signal,
            )
            assertNotAborted(signal)
            return result
        },
    }
}

export function parseImageDimensions(data: Uint8Array, mediaType: string): { width: number; height: number } {
    const invalid = () => { throw new PluginApiError('DECODE_FAILED', 'Unable to read bounded image dimensions') }
    if (mediaType === 'image/png') {
        if (data.byteLength < 24
            || data[0] !== 0x89 || data[1] !== 0x50 || data[2] !== 0x4e || data[3] !== 0x47
            || data[4] !== 0x0d || data[5] !== 0x0a || data[6] !== 0x1a || data[7] !== 0x0a) return invalid()
        const view = new DataView(data.buffer, data.byteOffset, data.byteLength)
        const width = view.getUint32(16)
        const height = view.getUint32(20)
        if (width < 1 || height < 1) return invalid()
        return { width, height }
    }
    if (mediaType === 'image/jpeg') {
        if (data.byteLength < 4 || data[0] !== 0xff || data[1] !== 0xd8) return invalid()
        let offset = 2
        while (offset + 8 < data.byteLength) {
            if (data[offset] !== 0xff) { offset++; continue }
            const marker = data[offset + 1]
            offset += 2
            if (marker === 0xd8 || marker === 0xd9 || marker === 0x01) continue
            if (offset + 2 > data.byteLength) return invalid()
            const length = (data[offset] << 8) | data[offset + 1]
            if (length < 2 || offset + length > data.byteLength) return invalid()
            const isStartOfFrame = (marker >= 0xc0 && marker <= 0xc3)
                || (marker >= 0xc5 && marker <= 0xc7)
                || (marker >= 0xc9 && marker <= 0xcb)
                || (marker >= 0xcd && marker <= 0xcf)
            if (isStartOfFrame) {
                if (length < 7) return invalid()
                const height = (data[offset + 3] << 8) | data[offset + 4]
                const width = (data[offset + 5] << 8) | data[offset + 6]
                if (width < 1 || height < 1) return invalid()
                return { width, height }
            }
            offset += length
        }
        return invalid()
    }
    if (mediaType === 'image/webp') {
        if (data.byteLength < 30
            || String.fromCharCode(...data.subarray(0, 4)) !== 'RIFF'
            || String.fromCharCode(...data.subarray(8, 12)) !== 'WEBP') return invalid()
        const chunk = String.fromCharCode(...data.subarray(12, 16))
        if (chunk === 'VP8X') {
            const width = 1 + data[24] + (data[25] << 8) + (data[26] << 16)
            const height = 1 + data[27] + (data[28] << 8) + (data[29] << 16)
            return { width, height }
        }
        if (chunk === 'VP8L' && data[20] === 0x2f) {
            const bits = data[21] | (data[22] << 8) | (data[23] << 16) | (data[24] << 24)
            return { width: (bits & 0x3fff) + 1, height: ((bits >>> 14) & 0x3fff) + 1 }
        }
        if (chunk === 'VP8 '
            && data[23] === 0x9d && data[24] === 0x01 && data[25] === 0x2a) {
            const width = (data[26] | (data[27] << 8)) & 0x3fff
            const height = (data[28] | (data[29] << 8)) & 0x3fff
            if (width < 1 || height < 1) return invalid()
            return { width, height }
        }
        return invalid()
    }
    return invalid()
}

interface ThumbnailDecodeResult {
    drawable: unknown
    width: number
    height: number
    close?: () => void
}

export interface BoundedThumbnailEnvironment {
    decode(
        data: Uint8Array,
        options: { width: number; height: number; mediaType: string },
    ): Promise<ThumbnailDecodeResult>
    encode(
        drawable: unknown,
        width: number,
        height: number,
        maxOutputBytes: number,
    ): Promise<{ data: Uint8Array; mediaType: string; width: number; height: number }>
}

const targetDimensions = (
    width: number,
    height: number,
    limits: { longEdge: number; maxPixels: number },
) => {
    const edgeScale = Math.min(1, limits.longEdge / Math.max(width, height))
    let targetWidth = Math.max(1, Math.floor(width * edgeScale))
    let targetHeight = Math.max(1, Math.floor(height * edgeScale))
    const pixels = targetWidth * targetHeight
    if (pixels > limits.maxPixels) {
        const pixelScale = Math.sqrt(limits.maxPixels / pixels)
        targetWidth = Math.max(1, Math.floor(targetWidth * pixelScale))
        targetHeight = Math.max(1, Math.floor(targetHeight * pixelScale))
    }
    return { width: targetWidth, height: targetHeight }
}

const canvasBlob = async (canvas: OffscreenCanvas | HTMLCanvasElement, type: string, quality: number) => {
    if ('convertToBlob' in canvas) return canvas.convertToBlob({ type, quality })
    return new Promise<Blob>((resolve, reject) => {
        canvas.toBlob((blob) => blob ? resolve(blob) : reject(new Error('Canvas encoding failed')), type, quality)
    })
}

const browserThumbnailEnvironment: BoundedThumbnailEnvironment = {
    async decode(data, options) {
        if (typeof createImageBitmap !== 'function') {
            throw new PluginApiError('DECODE_FAILED', 'Bounded image decoding is unavailable')
        }
        const bitmap = await createImageBitmap(
            new Blob([data.slice().buffer], { type: options.mediaType }),
            { resizeWidth: options.width, resizeHeight: options.height, resizeQuality: 'high' },
        )
        if (bitmap.width > options.width || bitmap.height > options.height) {
            bitmap.close()
            throw new PluginApiError('DECODE_FAILED', 'Image decoder ignored bounded resize options')
        }
        return { drawable: bitmap, width: bitmap.width, height: bitmap.height, close: () => bitmap.close() }
    },
    async encode(drawable, width, height, maxOutputBytes) {
        const canvas = typeof OffscreenCanvas === 'function'
            ? new OffscreenCanvas(width, height)
            : Object.assign(document.createElement('canvas'), { width, height })
        const context = canvas.getContext('2d')
        if (!context) throw new PluginApiError('DECODE_FAILED', 'Canvas encoder is unavailable')
        ;(context as CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D)
            .drawImage(drawable as CanvasImageSource, 0, 0, width, height)
        for (const quality of [0.92, 0.82, 0.7, 0.55]) {
            const blob = await canvasBlob(canvas, 'image/webp', quality)
            if (blob.size <= maxOutputBytes) {
                return {
                    data: new Uint8Array(await blob.arrayBuffer()),
                    mediaType: blob.type || 'image/webp',
                    width,
                    height,
                }
            }
        }
        throw new PluginApiError('RESOURCE_LIMIT', 'Encoded thumbnail exceeds the output limit')
    },
}

export async function createBoundedContextThumbnail(
    data: Uint8Array,
    mediaType: string,
    limits: { longEdge: number; maxPixels: number; maxOutputBytes: number },
    environment: BoundedThumbnailEnvironment = browserThumbnailEnvironment,
    signal?: AbortSignal,
): Promise<BoundedThumbnailResult> {
    assertNotAborted(signal)
    const source = parseImageDimensions(data, mediaType)
    const target = targetDimensions(source.width, source.height, limits)
    let decoded: ThumbnailDecodeResult | undefined
    try {
        decoded = await environment.decode(data, { ...target, mediaType })
        assertNotAborted(signal)
        if (decoded.width > target.width || decoded.height > target.height) {
            throw new PluginApiError('DECODE_FAILED', 'Image decoder exceeded its bounded target')
        }
        const encoded = await environment.encode(decoded.drawable, decoded.width, decoded.height, limits.maxOutputBytes)
        assertNotAborted(signal)
        const pixels = encoded.width * encoded.height
        if (!(encoded.data instanceof Uint8Array)
            || encoded.data.byteLength > limits.maxOutputBytes
            || Math.max(encoded.width, encoded.height) > limits.longEdge
            || pixels > limits.maxPixels) {
            throw new PluginApiError('RESOURCE_LIMIT', 'Thumbnail encoder exceeded its bounds')
        }
        return { ...encoded, decodedPixels: decoded.width * decoded.height }
    } catch (error) {
        if (error instanceof PluginApiError) throw error
        throw new PluginApiError('DECODE_FAILED', 'Unable to create a bounded thumbnail')
    } finally {
        decoded?.close?.()
    }
}

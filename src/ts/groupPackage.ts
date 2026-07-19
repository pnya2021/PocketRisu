import { isCharacterRecord, isGroupChatRecord } from './storage/groupChatCompatibility'

type PersistedRecord = Record<string, any>

export interface GroupPackageEntry<T extends PersistedRecord = PersistedRecord> {
    originalId: string
    record: T
}

export interface GroupPackageAssetEntry {
    originalUri: string
    file: string
}

export interface GroupPackageV1 {
    type: 'risuGroupPackage'
    version: 1
    createdAt: string
    members: GroupPackageEntry[]
    group: GroupPackageEntry
    assets: GroupPackageAssetEntry[]
}

interface GroupPackageDatabase {
    characters: PersistedRecord[]
    characterOrder?: unknown[]
}

export interface GroupPackageImportOptions {
    createId?: () => string
    assetUriMap?: Record<string, string>
}

export interface GroupPackageImportResult {
    groupId: string
    memberIdMap: Record<string, string>
    insertedIndexes: number[]
}

function clone<T>(value: T): T {
    return structuredClone(value)
}

function defaultIdFactory(): string {
    if (typeof globalThis.crypto?.randomUUID === 'function') return globalThis.crypto.randomUUID()
    return `record-${Date.now()}-${Math.random().toString(36).slice(2)}`
}

function exactRecordById(records: PersistedRecord[], id: string): PersistedRecord {
    const matches = records.filter((record) => record?.chaId === id)
    if (matches.length !== 1) throw new Error(`Expected exactly one record for original ID ${id}`)
    return matches[0]
}

function collectLocalAssetUris(value: unknown, uris: string[], seenUris: Set<string>, seenObjects: WeakSet<object>): void {
    if (typeof value === 'string') {
        if (value.startsWith('assets/') && !seenUris.has(value)) {
            seenUris.add(value)
            uris.push(value)
        }
        return
    }
    if (!value || typeof value !== 'object' || seenObjects.has(value)) return
    seenObjects.add(value)
    if (Array.isArray(value)) {
        for (const entry of value) collectLocalAssetUris(entry, uris, seenUris, seenObjects)
        return
    }
    for (const entry of Object.values(value)) collectLocalAssetUris(entry, uris, seenUris, seenObjects)
}

function packageAssetFile(originalUri: string, index: number): string {
    const clean = originalUri.split(/[?#]/, 1)[0]
    const match = clean.match(/\.([a-zA-Z0-9]{1,10})$/)
    return `assets/${index}.${match?.[1]?.toLowerCase() ?? 'bin'}`
}

function buildAssetEntries(members: GroupPackageEntry[], group: GroupPackageEntry): GroupPackageAssetEntry[] {
    const uris: string[] = []
    const seenUris = new Set<string>()
    for (const entry of [...members, group]) {
        const record = entry.record
        // Put the primary portrait first, then retain stable object traversal for
        // every other built-in or plugin-owned local asset field.
        collectLocalAssetUris(record.image, uris, seenUris, new WeakSet())
        collectLocalAssetUris(record, uris, seenUris, new WeakSet())
    }
    return uris.map((originalUri, index) => ({
        originalUri,
        file: packageAssetFile(originalUri, index),
    }))
}

export function buildGroupPackage(
    database: GroupPackageDatabase,
    groupId: string,
    now: () => string = () => new Date().toISOString(),
): GroupPackageV1 {
    if (!Array.isArray(database?.characters)) throw new Error('Invalid database characters')
    const group = exactRecordById(database.characters, groupId)
    if (!isGroupChatRecord(group) || !Array.isArray(group.characters)) throw new Error('Group not found or malformed')
    const seen = new Set<string>()
    const members = group.characters.map((originalId: unknown) => {
        if (typeof originalId !== 'string' || !originalId || seen.has(originalId)) {
            throw new Error('Group contains an invalid or duplicate member ID')
        }
        seen.add(originalId)
        const record = exactRecordById(database.characters, originalId)
        if (!isCharacterRecord(record)) throw new Error(`Group member ${originalId} is not a character`)
        return { originalId, record: clone(record) }
    })
    const groupEntry = { originalId: groupId, record: clone(group) }
    const packageValue: GroupPackageV1 = {
        type: 'risuGroupPackage',
        version: 1,
        createdAt: now(),
        members,
        group: groupEntry,
        assets: buildAssetEntries(members, groupEntry),
    }
    assertPackage(packageValue)
    return packageValue
}

function assertPortableChats(record: PersistedRecord, label: string): void {
    if (!Array.isArray(record.chats)) throw new Error(`${label} has invalid chats`)
    const seenChatIds = new Set<string>()
    for (const chat of record.chats) {
        if (!chat || typeof chat !== 'object' || Array.isArray(chat)
            || chat._stub === true || chat._placeholder === true || !Array.isArray(chat.message)) {
            throw new Error(`${label} contains a non-portable chat stub or placeholder`)
        }
        if (typeof chat.id !== 'string' || chat.id.length === 0) {
            throw new Error(`${label} contains an invalid full chat ID`)
        }
        if (seenChatIds.has(chat.id)) {
            throw new Error(`${label} contains a duplicate full chat ID`)
        }
        seenChatIds.add(chat.id)
    }
}

function isCanonicalIsoTimestamp(value: unknown): value is string {
    if (typeof value !== 'string'
        || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value)) {
        return false
    }
    try {
        return new Date(value).toISOString() === value
    } catch {
        return false
    }
}

function assertPackage(value: unknown): asserts value is GroupPackageV1 {
    if (!value || typeof value !== 'object') throw new Error('Invalid group package')
    const pkg = value as GroupPackageV1
    if (pkg.type !== 'risuGroupPackage' || pkg.version !== 1) throw new Error('Unsupported group package version')
    if (!isCanonicalIsoTimestamp(pkg.createdAt)) throw new Error('Invalid group package createdAt')
    if (!pkg.group || typeof pkg.group.originalId !== 'string' || !isGroupChatRecord(pkg.group.record)) {
        throw new Error('Invalid group package record')
    }
    if (pkg.group.record.chaId !== pkg.group.originalId) throw new Error('Group original ID mismatch')
    assertPortableChats(pkg.group.record, 'Group')
    if (!Array.isArray(pkg.members) || !Array.isArray(pkg.group.record.characters)) {
        throw new Error('Invalid group package members')
    }
    const seen = new Set<string>()
    for (const member of pkg.members) {
        if (!member || typeof member.originalId !== 'string' || !member.originalId || seen.has(member.originalId)) {
            throw new Error('Duplicate or invalid group member original ID')
        }
        if (!isCharacterRecord(member.record) || member.record.type !== 'character'
            || member.record.chaId !== member.originalId) {
            throw new Error('Member original ID mismatch')
        }
        assertPortableChats(member.record, `Member ${member.originalId}`)
        seen.add(member.originalId)
    }
    if (seen.has(pkg.group.originalId)) {
        throw new Error('Group original ID collides with a member original ID')
    }
    if (pkg.group.record.characters.length !== pkg.members.length
        || pkg.group.record.characters.some((id: unknown, index: number) => id !== pkg.members[index].originalId)) {
        throw new Error('Group membership does not match package members')
    }
    if (!Array.isArray(pkg.assets)) throw new Error('Invalid group package assets')
    const seenAssetUris = new Set<string>()
    const seenAssetFiles = new Set<string>()
    for (const asset of pkg.assets) {
        if (!asset || typeof asset.originalUri !== 'string' || !asset.originalUri.startsWith('assets/')
            || typeof asset.file !== 'string' || !/^assets\/[0-9]+\.[a-zA-Z0-9]{1,10}$/.test(asset.file)
            || seenAssetUris.has(asset.originalUri) || seenAssetFiles.has(asset.file)) {
            throw new Error('Invalid or duplicate group package asset')
        }
        seenAssetUris.add(asset.originalUri)
        seenAssetFiles.add(asset.file)
    }
    const expectedAssets = buildAssetEntries(pkg.members, pkg.group)
    if (JSON.stringify(pkg.assets) !== JSON.stringify(expectedAssets)) {
        throw new Error('Group package asset manifest does not match record assets')
    }
}

export function validateGroupPackage(value: unknown): asserts value is GroupPackageV1 {
    assertPackage(value)
}

function nextUniqueId(createId: () => string, reserved: Set<string>): string {
    for (let attempt = 0; attempt < 64; attempt++) {
        const id = createId()
        if (typeof id === 'string' && id && !reserved.has(id)) {
            reserved.add(id)
            return id
        }
    }
    throw new Error('Unable to create a unique ID for group package import')
}

function remapMessageSpeakers(record: PersistedRecord, idMap: Map<string, string>): void {
    if (!Array.isArray(record.chats)) return
    for (const chat of record.chats) {
        if (!chat || typeof chat !== 'object' || !Array.isArray(chat.message)) continue
        for (const message of chat.message) {
            if (!message || typeof message !== 'object' || message.saying == null || message.saying === '') continue
            if (typeof message.saying !== 'string' || !idMap.has(message.saying)) {
                throw new Error(`Unknown saying ID in group package: ${String(message.saying)}`)
            }
            message.saying = idMap.get(message.saying)
        }
    }
}

function rewriteAssetUris(value: unknown, assetUriMap: Record<string, string>, seen: WeakSet<object>): unknown {
    if (typeof value === 'string') return value.startsWith('assets/') ? assetUriMap[value] : value
    if (!value || typeof value !== 'object' || seen.has(value)) return value
    seen.add(value)
    if (Array.isArray(value)) {
        for (let index = 0; index < value.length; index++) {
            value[index] = rewriteAssetUris(value[index], assetUriMap, seen)
        }
        return value
    }
    for (const [key, entry] of Object.entries(value)) {
        value[key] = rewriteAssetUris(entry, assetUriMap, seen)
    }
    return value
}

function assertAssetUriMap(pkg: GroupPackageV1, assetUriMap: Record<string, string>): void {
    for (const asset of pkg.assets) {
        if (typeof assetUriMap[asset.originalUri] !== 'string' || !assetUriMap[asset.originalUri]) {
            throw new Error(`Missing imported asset mapping for ${asset.originalUri}`)
        }
    }
}

export function applyImportedGroupPackageAssetMap(
    database: GroupPackageDatabase,
    packageValue: unknown,
    importResult: GroupPackageImportResult,
    assetUriMap: Record<string, string>,
): void {
    assertPackage(packageValue)
    if (!Array.isArray(database?.characters)) throw new Error('Invalid target database')
    assertAssetUriMap(packageValue, assetUriMap)

    const expectedIds = [
        ...packageValue.members.map(member => importResult.memberIdMap[member.originalId]),
        importResult.groupId,
    ]
    if (importResult.insertedIndexes.length !== expectedIds.length
        || expectedIds.some(id => typeof id !== 'string' || !id)) {
        throw new Error('Invalid group package import result')
    }
    const originalRecords = importResult.insertedIndexes.map((index, offset) => {
        const record = database.characters[index]
        if (!record || record.chaId !== expectedIds[offset]) {
            throw new Error('Imported group package records no longer match the import result')
        }
        return record
    })
    const rewrittenRecords = originalRecords.map(record => {
        const rewritten = clone(record)
        rewriteAssetUris(rewritten, assetUriMap, new WeakSet())
        return rewritten
    })
    for (let offset = 0; offset < rewrittenRecords.length; offset++) {
        database.characters[importResult.insertedIndexes[offset]] = rewrittenRecords[offset]
    }
}

export function importGroupPackageAtomic(
    database: GroupPackageDatabase,
    packageValue: unknown,
    options: GroupPackageImportOptions = {},
): GroupPackageImportResult {
    assertPackage(packageValue)
    if (!Array.isArray(database?.characters)) throw new Error('Invalid target database')
    if (database.characterOrder !== undefined && !Array.isArray(database.characterOrder)) {
        throw new Error('Invalid target character order')
    }

    const pkg = clone(packageValue)
    const assetUriMap = options.assetUriMap ?? {}
    assertAssetUriMap(pkg, assetUriMap)
    const reserved = new Set(database.characters.map((record) => record?.chaId).filter((id): id is string => typeof id === 'string' && !!id))
    const createId = options.createId ?? defaultIdFactory
    const memberIdMap = Object.create(null) as Record<string, string>
    const idMap = new Map<string, string>()

    for (const member of pkg.members) {
        const id = nextUniqueId(createId, reserved)
        memberIdMap[member.originalId] = id
        idMap.set(member.originalId, id)
    }
    const groupId = nextUniqueId(createId, reserved)
    idMap.set(pkg.group.originalId, groupId)

    const stagedMembers = pkg.members.map((entry) => {
        const record = clone(entry.record)
        rewriteAssetUris(record, assetUriMap, new WeakSet())
        record.chaId = memberIdMap[entry.originalId]
        remapMessageSpeakers(record, idMap)
        return record
    })
    const stagedGroup = clone(pkg.group.record)
    rewriteAssetUris(stagedGroup, assetUriMap, new WeakSet())
    stagedGroup.chaId = groupId
    stagedGroup.characters = stagedGroup.characters.map((id: string) => memberIdMap[id])
    remapMessageSpeakers(stagedGroup, idMap)

    const startIndex = database.characters.length
    const insertedIndexes = Array.from({ length: stagedMembers.length + 1 }, (_, index) => startIndex + index)
    database.characters.push(...stagedMembers, stagedGroup)
    database.characterOrder ??= []
    database.characterOrder.push(...stagedMembers.map((record) => record.chaId), groupId)

    return { groupId, memberIdMap, insertedIndexes }
}

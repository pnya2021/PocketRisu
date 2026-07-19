export type GroupChatQuarantineReason =
    | 'invalid-record'
    | 'invalid-members'
    | 'invalid-chats'

export interface GroupChatOrderReference {
    kind: 'root' | 'folder'
    orderIndex: number
    folderId?: string
    memberIndex?: number
}

export interface QuarantinedGroupChat {
    reason: GroupChatQuarantineReason
    record: unknown
    originalIndex: number
    orderReferences: GroupChatOrderReference[]
}

export interface GroupChatDatabaseLike {
    characters: unknown[]
    characterOrder?: unknown[]
    quarantinedGroupChats?: unknown
}

export interface GroupChatNormalizationResult {
    changed: boolean
    normalizedCount: number
    quarantinedCount: number
}

type MutableRecord = Record<string, any>

function isRecord(value: unknown): value is MutableRecord {
    return value !== null && typeof value === 'object' && !Array.isArray(value)
}

export function isGroupChatRecord(value: unknown): value is MutableRecord & { type: 'group' } {
    return isRecord(value) && value.type === 'group'
}

export function isCharacterRecord(value: unknown): value is MutableRecord {
    return isRecord(value) && value.type !== 'group'
}

function defaultIdFactory(): string {
    if (typeof globalThis.crypto?.randomUUID === 'function') return globalThis.crypto.randomUUID()
    return `group-${Date.now()}-${Math.random().toString(36).slice(2)}`
}

const QUARANTINE_SNAPSHOT_VERSION = 1 as const
const MAX_QUARANTINE_SNAPSHOT_DEPTH = 64

type QuarantineSnapshotKind =
    | 'undefined'
    | 'function'
    | 'symbol'
    | 'bigint'
    | 'nan'
    | 'positive-infinity'
    | 'negative-infinity'
    | 'negative-zero'
    | 'circular-reference'
    | 'accessor'
    | 'object'
    | 'array'
    | 'uninspectable-object'
    | 'depth-limit'
    | 'invalid-array-length'

interface QuarantineSnapshotEnvelope {
    $risuQuarantineSnapshot: {
        version: typeof QUARANTINE_SNAPSHOT_VERSION
        kind: QuarantineSnapshotKind
        [key: string]: unknown
    }
}

interface QuarantineJsonValue {
    value: unknown
    jsonSafePlainData: boolean
}

function quarantineSnapshot(
    kind: QuarantineSnapshotKind,
    details: Record<string, unknown> = {},
): QuarantineSnapshotEnvelope {
    return {
        $risuQuarantineSnapshot: {
            version: QUARANTINE_SNAPSHOT_VERSION,
            kind,
            ...details,
        },
    }
}

function descriptorFromMap(
    descriptorMap: PropertyDescriptorMap,
    key: PropertyKey,
): PropertyDescriptor | undefined {
    const descriptor = Object.getOwnPropertyDescriptor(descriptorMap, key)
    return descriptor && Object.hasOwn(descriptor, 'value')
        ? descriptor.value as PropertyDescriptor
        : undefined
}

function primitiveQuarantineJsonValue(value: unknown): QuarantineJsonValue | null {
    if (value === null || typeof value === 'string' || typeof value === 'boolean') {
        return { value, jsonSafePlainData: true }
    }
    if (typeof value === 'number') {
        if (Number.isNaN(value)) {
            return { value: quarantineSnapshot('nan'), jsonSafePlainData: false }
        }
        if (value === Number.POSITIVE_INFINITY) {
            return { value: quarantineSnapshot('positive-infinity'), jsonSafePlainData: false }
        }
        if (value === Number.NEGATIVE_INFINITY) {
            return { value: quarantineSnapshot('negative-infinity'), jsonSafePlainData: false }
        }
        if (Object.is(value, -0)) {
            return { value: quarantineSnapshot('negative-zero'), jsonSafePlainData: false }
        }
        return { value, jsonSafePlainData: true }
    }
    if (value === undefined) {
        return { value: quarantineSnapshot('undefined'), jsonSafePlainData: false }
    }
    if (typeof value === 'function') {
        return { value: quarantineSnapshot('function'), jsonSafePlainData: false }
    }
    if (typeof value === 'symbol') {
        return { value: quarantineSnapshot('symbol'), jsonSafePlainData: false }
    }
    if (typeof value === 'bigint') {
        return { value: quarantineSnapshot('bigint'), jsonSafePlainData: false }
    }
    return null
}

function quarantineJsonValue(
    value: unknown,
    active: WeakSet<object>,
    depth: number,
): QuarantineJsonValue {
    const primitive = primitiveQuarantineJsonValue(value)
    if (primitive) return primitive

    const objectValue = value as object
    if (active.has(objectValue)) {
        return { value: quarantineSnapshot('circular-reference'), jsonSafePlainData: false }
    }
    if (depth >= MAX_QUARANTINE_SNAPSHOT_DEPTH) {
        return { value: quarantineSnapshot('depth-limit'), jsonSafePlainData: false }
    }

    let prototype: object | null
    let descriptorMap: PropertyDescriptorMap
    try {
        prototype = Object.getPrototypeOf(objectValue)
        descriptorMap = Object.getOwnPropertyDescriptors(objectValue)
    } catch {
        return { value: quarantineSnapshot('uninspectable-object'), jsonSafePlainData: false }
    }

    active.add(objectValue)
    try {
        const ownKeys = Reflect.ownKeys(descriptorMap)
        const stringKeys = ownKeys
            .filter((key): key is string => typeof key === 'string')
            .sort((left, right) => left < right ? -1 : left > right ? 1 : 0)
        const symbolPropertyCount = ownKeys.length - stringKeys.length
        const isArray = Array.isArray(objectValue)
        const properties: Array<{
            key: string
            enumerable: boolean
            value: unknown
        }> = []
        let jsonSafePlainData = symbolPropertyCount === 0
            && (isArray
                ? prototype === Array.prototype
                : prototype === Object.prototype || prototype === null)

        let arrayLength: number | QuarantineSnapshotEnvelope | undefined
        let denseArrayPropertyCount = 0
        if (isArray) {
            const lengthDescriptor = descriptorFromMap(descriptorMap, 'length')
            if (lengthDescriptor
                && Object.hasOwn(lengthDescriptor, 'value')
                && Number.isSafeInteger(lengthDescriptor.value)
                && lengthDescriptor.value >= 0
                && lengthDescriptor.enumerable === false) {
                arrayLength = lengthDescriptor.value as number
            } else {
                arrayLength = quarantineSnapshot('invalid-array-length')
                jsonSafePlainData = false
            }
        }

        for (const key of stringKeys) {
            if (isArray && key === 'length') continue
            const descriptor = descriptorFromMap(descriptorMap, key)
            if (!descriptor) {
                jsonSafePlainData = false
                continue
            }

            let propertyValue: QuarantineJsonValue
            if (Object.hasOwn(descriptor, 'value')) {
                propertyValue = quarantineJsonValue(descriptor.value, active, depth + 1)
            } else {
                propertyValue = {
                    value: quarantineSnapshot('accessor'),
                    jsonSafePlainData: false,
                }
            }
            properties.push({
                key,
                enumerable: descriptor.enumerable === true,
                value: propertyValue.value,
            })
            if (descriptor.enumerable !== true || !propertyValue.jsonSafePlainData) {
                jsonSafePlainData = false
            }

            if (isArray && typeof arrayLength === 'number') {
                const index = Number(key)
                const isCanonicalDenseIndex = Number.isSafeInteger(index)
                    && index >= 0
                    && index < arrayLength
                    && String(index) === key
                if (isCanonicalDenseIndex) denseArrayPropertyCount++
                else jsonSafePlainData = false
            }
        }

        if (isArray && typeof arrayLength === 'number'
            && denseArrayPropertyCount !== arrayLength) {
            jsonSafePlainData = false
        }
        if (jsonSafePlainData) return { value, jsonSafePlainData: true }

        return {
            value: quarantineSnapshot(isArray ? 'array' : 'object', {
                prototype: isArray
                    ? 'array'
                    : prototype === Object.prototype
                        ? 'plain'
                        : prototype === null
                            ? 'null'
                            : 'custom',
                ...(isArray ? { length: arrayLength } : {}),
                properties,
                symbolPropertyCount,
            }),
            jsonSafePlainData: false,
        }
    } finally {
        active.delete(objectValue)
    }
}

/**
 * Preserve already JSON-safe plain data by identity. Values that a RisuSave
 * root JSON block cannot faithfully encode become a deterministic,
 * descriptor-only snapshot. Property accessors are represented, never read.
 */
function copyForQuarantine(value: unknown): unknown {
    return quarantineJsonValue(value, new WeakSet(), 0).value
}

function readPlainDataRecord(value: unknown): Map<string, unknown> | null {
    if (!isRecord(value)) return null
    try {
        const prototype = Object.getPrototypeOf(value)
        if (prototype !== Object.prototype && prototype !== null) return null
        const descriptorMap = Object.getOwnPropertyDescriptors(value)
        const result = new Map<string, unknown>()
        for (const key of Reflect.ownKeys(descriptorMap)) {
            if (typeof key !== 'string') return null
            const descriptor = Object.getOwnPropertyDescriptor(descriptorMap, key)?.value as PropertyDescriptor | undefined
            if (!descriptor || !Object.hasOwn(descriptor, 'value') || descriptor.enumerable !== true) return null
            result.set(key, descriptor.value)
        }
        return result
    } catch {
        return null
    }
}

function hasExactDataKeys(
    record: Map<string, unknown>,
    required: readonly string[],
    optional: readonly string[] = [],
): boolean {
    const allowed = new Set([...required, ...optional])
    return required.every(key => record.has(key))
        && [...record.keys()].every(key => allowed.has(key))
}

function readDenseDataArray(value: unknown): unknown[] | null {
    try {
        if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype) return null
        const descriptorMap = Object.getOwnPropertyDescriptors(value)
        const lengthProperty = Object.getOwnPropertyDescriptor(descriptorMap, 'length')?.value as PropertyDescriptor | undefined
        if (!lengthProperty || !Object.hasOwn(lengthProperty, 'value')
            || !Number.isSafeInteger(lengthProperty.value) || lengthProperty.value < 0) {
            return null
        }
        const length = lengthProperty.value as number
        const keys = Reflect.ownKeys(descriptorMap)
        if (keys.some(key => typeof key !== 'string') || keys.length !== length + 1) return null
        const result: unknown[] = []
        for (let index = 0; index < length; index++) {
            const descriptor = Object.getOwnPropertyDescriptor(descriptorMap, String(index))?.value as PropertyDescriptor | undefined
            if (!descriptor || !Object.hasOwn(descriptor, 'value') || descriptor.enumerable !== true) return null
            result.push(descriptor.value)
        }
        return result
    } catch {
        return null
    }
}

function isExactOrderReference(value: unknown): value is GroupChatOrderReference {
    const record = readPlainDataRecord(value)
    if (!record || !hasExactDataKeys(record, ['kind', 'orderIndex'], ['folderId', 'memberIndex'])) return false
    const kind = record.get('kind')
    if (kind !== 'root' && kind !== 'folder') return false
    const orderIndex = record.get('orderIndex')
    if (!Number.isSafeInteger(orderIndex) || (orderIndex as number) < 0) return false
    if (record.has('folderId')) {
        const folderId = record.get('folderId')
        if (folderId !== undefined && typeof folderId !== 'string') return false
    }
    if (record.has('memberIndex')) {
        const memberIndex = record.get('memberIndex')
        if (memberIndex !== undefined
            && (!Number.isSafeInteger(memberIndex) || (memberIndex as number) < 0)) return false
    }
    return true
}

function isExactQuarantinedGroupChat(value: unknown): value is QuarantinedGroupChat {
    const record = readPlainDataRecord(value)
    if (!record || !hasExactDataKeys(
        record,
        ['reason', 'record', 'originalIndex', 'orderReferences'],
    )) return false
    const reason = record.get('reason')
    if (reason !== 'invalid-record' && reason !== 'invalid-members' && reason !== 'invalid-chats') return false
    const originalIndex = record.get('originalIndex')
    if (!Number.isSafeInteger(originalIndex) || (originalIndex as number) < -1) return false
    const orderReferences = readDenseDataArray(record.get('orderReferences'))
    return orderReferences !== null && orderReferences.every(isExactOrderReference)
}

function malformedQuarantineEntry(record: unknown): QuarantinedGroupChat {
    return {
        reason: 'invalid-record',
        record: copyForQuarantine(record),
        originalIndex: -1,
        orderReferences: [],
    }
}

function normalizeExactQuarantineEntry(entry: QuarantinedGroupChat): QuarantinedGroupChat {
    const fields = readPlainDataRecord(entry)!
    const record = fields.get('record')
    const normalizedRecord = copyForQuarantine(record)
    if (normalizedRecord === record) return entry
    return {
        reason: fields.get('reason') as GroupChatQuarantineReason,
        record: normalizedRecord,
        originalIndex: fields.get('originalIndex') as number,
        orderReferences: fields.get('orderReferences') as GroupChatOrderReference[],
    }
}

function normalizeQuarantineLog(database: GroupChatDatabaseLike): boolean {
    if (!Object.hasOwn(database, 'quarantinedGroupChats')
        || database.quarantinedGroupChats === undefined) return false
    const entries = readDenseDataArray(database.quarantinedGroupChats)
    if (entries === null) {
        database.quarantinedGroupChats = [malformedQuarantineEntry(database.quarantinedGroupChats)]
        return true
    }
    let changed = false
    const normalized = entries.map((entry) => {
        if (isExactQuarantinedGroupChat(entry)) {
            const normalizedEntry = normalizeExactQuarantineEntry(entry)
            if (normalizedEntry !== entry) changed = true
            return normalizedEntry
        }
        changed = true
        return malformedQuarantineEntry(entry)
    })
    if (changed) database.quarantinedGroupChats = normalized
    return changed
}

function collectOrderReferences(order: unknown[] | undefined, chaId: unknown): GroupChatOrderReference[] {
    if (!Array.isArray(order) || typeof chaId !== 'string' || !chaId) return []
    const references: GroupChatOrderReference[] = []
    for (let orderIndex = 0; orderIndex < order.length; orderIndex++) {
        const entry = order[orderIndex]
        if (entry === chaId) {
            references.push({ kind: 'root', orderIndex })
            continue
        }
        if (!isRecord(entry) || !Array.isArray(entry.data)) continue
        for (let memberIndex = 0; memberIndex < entry.data.length; memberIndex++) {
            if (entry.data[memberIndex] !== chaId) continue
            references.push({
                kind: 'folder',
                orderIndex,
                folderId: typeof entry.id === 'string' ? entry.id : undefined,
                memberIndex,
            })
        }
    }
    return references
}

function removeOrderReferences(order: unknown[] | undefined, chaId: unknown): boolean {
    if (!Array.isArray(order) || typeof chaId !== 'string' || !chaId) return false
    let changed = false
    for (let index = order.length - 1; index >= 0; index--) {
        const entry = order[index]
        if (entry === chaId) {
            order.splice(index, 1)
            changed = true
            continue
        }
        if (!isRecord(entry) || !Array.isArray(entry.data)) continue
        const next = entry.data.filter((id: unknown) => id !== chaId)
        if (next.length !== entry.data.length) {
            entry.data = next
            changed = true
        }
    }
    return changed
}

function invalidReason(group: MutableRecord): GroupChatQuarantineReason | null {
    const members = group.characters === undefined && Array.isArray(group.members)
        ? group.members
        : group.characters
    if (members !== undefined) {
        if (!Array.isArray(members)) return 'invalid-members'
        if (members.some((id) => typeof id !== 'string' || id.length === 0)) return 'invalid-members'
    }
    if (group.chats !== undefined) {
        if (!Array.isArray(group.chats) || group.chats.some((chat: unknown) => !isRecord(chat))) {
            return 'invalid-chats'
        }
    }
    return null
}

function normalizeAlignedArray<T>(
    current: unknown,
    length: number,
    fallback: (index: number) => T,
    valid: (value: unknown) => value is T,
): { value: T[]; changed: boolean } {
    const input = Array.isArray(current) ? current : []
    const value = Array.from({ length }, (_, index) => valid(input[index]) ? input[index] : fallback(index))
    const changed = !Array.isArray(current)
        || input.length !== length
        || value.some((entry, index) => entry !== input[index])
    return { value, changed }
}

function normalizeGroup(group: MutableRecord, createId: () => string): boolean {
    let changed = false
    if (typeof group.chaId !== 'string' || group.chaId.length === 0) {
        group.chaId = createId()
        changed = true
    }
    if (!Array.isArray(group.characters)) {
        group.characters = Array.isArray(group.members) ? [...group.members] : []
        changed = true
    }
    if (!Array.isArray(group.chats)) {
        group.chats = []
        changed = true
    }
    if (group.chats.length === 0) {
        group.chats.push({
            id: createId(),
            name: 'Chat 1',
            message: [],
            note: '',
            localLore: [],
        })
        changed = true
    }
    if (!Array.isArray(group.chatFolders)) {
        group.chatFolders = []
        changed = true
    }
    if (typeof group.firstMessage !== 'string') {
        group.firstMessage = ''
        changed = true
    }
    if (typeof group.name !== 'string') {
        group.name = ''
        changed = true
    }
    if (!Array.isArray(group.globalLore)) {
        group.globalLore = []
        changed = true
    }
    if (!Array.isArray(group.emotionImages)) {
        group.emotionImages = []
        changed = true
    }
    if (!Array.isArray(group.customscript)) {
        group.customscript = []
        changed = true
    }
    if (!['single', 'multiple', 'none', 'emp'].includes(group.viewScreen)) {
        group.viewScreen = 'none'
        changed = true
    }
    if (typeof group.autoMode !== 'boolean') {
        group.autoMode = false
        changed = true
    }
    if (typeof group.useCharacterLore !== 'boolean') {
        group.useCharacterLore = true
        changed = true
    }
    const talks = normalizeAlignedArray(group.characterTalks, group.characters.length, () => 2 / 3, (v): v is number => typeof v === 'number' && Number.isFinite(v))
    if (talks.changed) {
        group.characterTalks = talks.value
        changed = true
    }
    const active = normalizeAlignedArray(group.characterActive, group.characters.length, () => true, (v): v is boolean => typeof v === 'boolean')
    if (active.changed) {
        group.characterActive = active.value
        changed = true
    }
    if (!Number.isInteger(group.chatPage) || group.chatPage < 0 || group.chatPage >= Math.max(1, group.chats.length)) {
        group.chatPage = 0
        changed = true
    }
    for (const chat of group.chats) {
        if (!isRecord(chat)) continue
        if (typeof chat.id !== 'string' || !chat.id) {
            chat.id = createId()
            changed = true
        }
        if (typeof chat.name !== 'string') {
            chat.name = ''
            changed = true
        }
        if (chat._stub === true && Array.isArray(chat.message)) {
            delete chat._stub
            changed = true
        }
        if (chat._stub === true && '_placeholder' in chat) {
            delete chat._placeholder
            changed = true
        }
        if (chat._stub === true) continue
        if (!Array.isArray(chat.message)) {
            chat.message = []
            changed = true
        }
        if (typeof chat.note !== 'string') {
            chat.note = ''
            changed = true
        }
        if (!Array.isArray(chat.localLore)) {
            chat.localLore = []
            changed = true
        }
    }
    return changed
}

export function normalizeGroupChatDatabase(
    database: GroupChatDatabaseLike,
    createId: () => string = defaultIdFactory,
): GroupChatNormalizationResult {
    if (!Array.isArray(database.characters)) database.characters = []
    let changed = normalizeQuarantineLog(database)
    const reservedIds = new Set<string>()
    for (const record of database.characters) {
        if (!isRecord(record)) continue
        if (typeof record.chaId === 'string' && record.chaId) reservedIds.add(record.chaId)
        if (!Array.isArray(record.chats)) continue
        for (const chat of record.chats) {
            if (isRecord(chat) && typeof chat.id === 'string' && chat.id) reservedIds.add(chat.id)
        }
    }
    const createUniqueId = () => {
        for (let attempt = 0; attempt < 128; attempt++) {
            const candidate = createId()
            if (typeof candidate === 'string' && candidate && !reservedIds.has(candidate)) {
                reservedIds.add(candidate)
                return candidate
            }
        }
        throw new Error('Unable to assign a unique group or chat ID')
    }
    let normalizedCount = 0
    let quarantinedCount = 0
    const retained: unknown[] = []

    for (let index = 0; index < database.characters.length; index++) {
        const record = database.characters[index]
        if (!isGroupChatRecord(record)) {
            retained.push(record)
            continue
        }
        const reason = invalidReason(record)
        if (reason) {
            const orderReferences = collectOrderReferences(database.characterOrder, record.chaId)
            const quarantineLog = Array.isArray(database.quarantinedGroupChats)
                ? database.quarantinedGroupChats
                : []
            database.quarantinedGroupChats = quarantineLog
            quarantineLog.push({
                reason,
                record: copyForQuarantine(record),
                originalIndex: index,
                orderReferences,
            })
            removeOrderReferences(database.characterOrder, record.chaId)
            quarantinedCount++
            changed = true
            continue
        }
        if (normalizeGroup(record, createUniqueId)) changed = true
        normalizedCount++
        retained.push(record)
    }

    if (retained.length !== database.characters.length) database.characters = retained
    return { changed, normalizedCount, quarantinedCount }
}

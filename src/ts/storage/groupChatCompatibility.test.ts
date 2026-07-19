import { describe, expect, test } from 'vitest'
import { Unpackr } from 'msgpackr/index-no-eval'
import {
    isCharacterRecord,
    isGroupChatRecord,
    normalizeGroupChatDatabase,
} from './groupChatCompatibility'

const fullGroup = (overrides: Record<string, unknown> = {}) => ({
    type: 'group',
    chaId: 'group-1',
    name: 'Illustration club',
    image: 'assets/group.png',
    firstMessage: 'Welcome',
    chats: [{
        id: 'chat-1',
        name: 'Main',
        note: 'group note',
        localLore: [{ key: 'club', content: 'secret room' }],
        modules: ['module-chat'],
        scriptstate: { route: 'gallery' },
        pluginState: { owner: 'test-plugin' },
        message: [
            { role: 'user', data: 'hello', chatId: 'message-1' },
            { role: 'char', data: 'hi', saying: 'member-b', chatId: 'message-2' },
        ],
        unknownChatField: { preserved: true },
    }],
    chatFolders: [{ id: 'folder-1', name: 'Archive', folded: false }],
    chatPage: 0,
    viewScreen: 'multiple',
    characters: ['member-a', 'member-b'],
    characterTalks: [2, 1],
    characterActive: [true, false],
    globalLore: [{ key: 'group-only', content: 'lore' }],
    autoMode: true,
    useCharacterLore: true,
    emotionImages: [['smile', 'assets/smile.png']],
    customscript: [{ comment: 'group script' }],
    modules: ['module-group'],
    unknownPluginField: { nested: ['kept'] },
    ...overrides,
})

const character = (id: string) => ({
    type: 'character',
    chaId: id,
    name: id,
    chats: [],
    unknownCharacterField: { preserved: true },
})

describe('group record guards', () => {
    test('distinguishes groups from ordinary characters without coercion', () => {
        expect(isGroupChatRecord(fullGroup())).toBe(true)
        expect(isGroupChatRecord(character('member-a'))).toBe(false)
        expect(isCharacterRecord(character('member-a'))).toBe(true)
        expect(isCharacterRecord(fullGroup())).toBe(false)
    })
})

describe('normalizeGroupChatDatabase', () => {
    test('preserves complete current groups and plugin-owned fields', () => {
        const group = fullGroup()
        const db: any = {
            characters: [character('member-a'), character('member-b'), group],
            characterOrder: ['member-a', 'member-b', 'group-1'],
        }

        const result = normalizeGroupChatDatabase(db, () => 'unused-id')

        expect(result).toEqual({ changed: false, normalizedCount: 1, quarantinedCount: 0 })
        expect(db.characters[2]).toBe(group)
        expect(db.characters[2].unknownPluginField).toEqual({ nested: ['kept'] })
        expect(db.characters[2].chats[0]).toMatchObject({
            localLore: [{ key: 'club', content: 'secret room' }],
            modules: ['module-chat'],
            scriptstate: { route: 'gallery' },
            pluginState: { owner: 'test-plugin' },
            unknownChatField: { preserved: true },
        })
        expect(db.characters[2].chats[0].message[1].saying).toBe('member-b')
    })

    test('repairs legacy member aliases and aligned defaults without deleting legacy fields', () => {
        const legacy = fullGroup({
            chaId: '',
            characters: undefined,
            members: ['member-a', 'member-b'],
            characterTalks: [3],
            characterActive: undefined,
            chatPage: 99,
            chats: [{ id: 'legacy-chat', name: 'Legacy', _stub: true }],
            viewScreen: 'legacy-invalid',
            autoMode: 'yes',
            useCharacterLore: null,
            legacyExtension: { version: 1 },
        })
        const db: any = { characters: [character('member-a'), character('member-b'), legacy] }

        const result = normalizeGroupChatDatabase(db, () => 'generated-group-id')

        expect(result).toEqual({ changed: true, normalizedCount: 1, quarantinedCount: 0 })
        const repaired = db.characters[2]
        expect(repaired.chaId).toBe('generated-group-id')
        expect(repaired.characters).toEqual(['member-a', 'member-b'])
        expect(repaired.members).toEqual(['member-a', 'member-b'])
        expect(repaired.characterTalks).toEqual([3, 2 / 3])
        expect(repaired.characterActive).toEqual([true, true])
        expect(repaired.chatPage).toBe(0)
        expect(repaired.viewScreen).toBe('none')
        expect(repaired.autoMode).toBe(false)
        expect(repaired.useCharacterLore).toBe(true)
        expect(repaired.legacyExtension).toEqual({ version: 1 })
        expect(repaired.chats[0]).toEqual({ id: 'legacy-chat', name: 'Legacy', _stub: true })
        expect('message' in repaired.chats[0]).toBe(false)
    })

    test('keeps stub, placeholder, and hydrated chat shapes disjoint', () => {
        const group = fullGroup({
            chats: [
                { id: 'stub', name: 'Stub', _stub: true, modules: ['stub-module'] },
                {
                    id: 'placeholder', name: 'Placeholder', _placeholder: true,
                    message: [], note: '', localLore: [], modules: ['placeholder-module'],
                },
                {
                    id: 'hybrid', name: 'Hybrid', _stub: true,
                    message: [{ role: 'char', data: 'preserve me', saying: 'member-a' }],
                    note: 'real', localLore: [], scriptstate: { x: 1 },
                },
            ],
        })
        const db: any = { characters: [character('member-a'), character('member-b'), group] }

        normalizeGroupChatDatabase(db)

        const [stub, placeholder, healed] = db.characters[2].chats
        expect(stub._stub).toBe(true)
        expect('message' in stub).toBe(false)
        expect(placeholder._placeholder).toBe(true)
        expect(placeholder._stub).toBeUndefined()
        expect(healed._stub).toBeUndefined()
        expect(healed.message[0]).toMatchObject({ data: 'preserve me', saying: 'member-a' })
        expect(healed.scriptstate).toEqual({ x: 1 })
    })

    test('repairs missing full-chat identity and base arrays without touching unknown fields', () => {
        const group = fullGroup({
            chats: [{
                message: [{ role: 'char', data: 'kept', saying: 'member-a' }],
                pluginOwned: { kept: true },
            }],
        })
        const db: any = { characters: [character('member-a'), character('member-b'), group] }

        const result = normalizeGroupChatDatabase(db, () => 'generated-chat-id')

        expect(result.changed).toBe(true)
        expect(db.characters[2].chats[0]).toEqual({
            id: 'generated-chat-id',
            name: '',
            note: '',
            localLore: [],
            message: [{ role: 'char', data: 'kept', saying: 'member-a' }],
            pluginOwned: { kept: true },
        })
    })

    test('creates one usable full chat when a repairable legacy group has none', () => {
        const group = fullGroup({ chats: [], chatPage: 4 })
        const db: any = { characters: [character('member-a'), character('member-b'), group] }

        expect(normalizeGroupChatDatabase(db, () => 'blank-chat-id').changed).toBe(true)
        expect(db.characters[2].chatPage).toBe(0)
        expect(db.characters[2].chats).toEqual([{
            id: 'blank-chat-id',
            name: 'Chat 1',
            message: [],
            note: '',
            localLore: [],
        }])
    })

    test('does not assign missing group or chat IDs that collide with existing records', () => {
        const group = fullGroup({ chaId: '', chats: [] })
        const db: any = { characters: [character('reserved-id'), group] }
        const generated = ['reserved-id', 'new-group-id', 'new-chat-id']

        normalizeGroupChatDatabase(db, () => generated.shift()!)

        expect(db.characters[1].chaId).toBe('new-group-id')
        expect(db.characters[1].chats[0].id).toBe('new-chat-id')
    })

    test('quarantines a group containing non-object chat entries', () => {
        const invalid = fullGroup({ chats: ['not-a-chat'] })
        const db: any = { characters: [invalid], characterOrder: ['group-1'] }

        expect(normalizeGroupChatDatabase(db)).toMatchObject({ changed: true, quarantinedCount: 1 })
        expect(db.characters).toEqual([])
        expect(db.quarantinedGroupChats[0]).toMatchObject({ reason: 'invalid-chats', record: invalid })
    })

    test('quarantines structurally impossible groups with their order references', () => {
        const invalid = fullGroup({ characters: 'not-an-array' })
        const db: any = {
            characters: [character('member-a'), invalid, character('member-b')],
            characterOrder: [
                'member-a',
                { id: 'folder-1', name: 'Broken', folded: false, data: ['group-1', 'member-b'] },
            ],
            quarantinedGroupChats: [],
        }

        const result = normalizeGroupChatDatabase(db)

        expect(result).toEqual({ changed: true, normalizedCount: 0, quarantinedCount: 1 })
        expect(db.characters.map((entry: any) => entry.chaId)).toEqual(['member-a', 'member-b'])
        expect(db.quarantinedGroupChats).toEqual([expect.objectContaining({
            reason: 'invalid-members',
            record: invalid,
            originalIndex: 1,
            orderReferences: [{ kind: 'folder', orderIndex: 1, folderId: 'folder-1', memberIndex: 0 }],
        })])
        expect(db.characterOrder[1].data).toEqual(['member-b'])
    })

    test('recovers a malformed quarantine log without silently discarding its prior value', () => {
        const invalid = fullGroup({ characters: 'not-an-array' })
        const malformedPriorLog = { legacy: ['retain-me'] }
        const db: any = {
            characters: [invalid],
            characterOrder: ['group-1'],
            quarantinedGroupChats: malformedPriorLog,
        }

        const result = normalizeGroupChatDatabase(db)

        expect(result).toEqual({ changed: true, normalizedCount: 0, quarantinedCount: 1 })
        expect(db.quarantinedGroupChats).toEqual([
            {
                reason: 'invalid-record',
                record: malformedPriorLog,
                originalIndex: -1,
                orderReferences: [],
            },
            expect.objectContaining({
                reason: 'invalid-members',
                record: invalid,
                originalIndex: 0,
            }),
        ])
        expect(db.characterOrder).toEqual([])
    })

    test('normalizes every malformed quarantine entry once without executing accessors', () => {
        const valid = {
            reason: 'invalid-members',
            record: { type: 'group', chaId: 'kept' },
            originalIndex: 4,
            orderReferences: [{ kind: 'root', orderIndex: 2 }],
        }
        const nullPrototypeValid = Object.assign(Object.create(null), {
            reason: 'invalid-chats',
            record: 'preserved payload',
            originalIndex: 5,
            orderReferences: [Object.assign(Object.create(null), {
                kind: 'folder', orderIndex: 3, folderId: 'folder', memberIndex: 1,
            })],
        })
        const extraField = { ...valid, unexpected: true }
        const customPrototype = Object.assign(Object.create({ inherited: true }), valid)
        const missingRecord = {
            reason: 'invalid-record', originalIndex: -1, orderReferences: [],
        }

        let quarantineAccessorReads = 0
        const accessorEntry: Record<string, unknown> = {
            record: 'accessor entry', originalIndex: 6, orderReferences: [],
        }
        Object.defineProperty(accessorEntry, 'reason', {
            enumerable: true,
            get() {
                quarantineAccessorReads++
                throw new Error('quarantine accessor must not execute')
            },
        })

        let orderAccessorReads = 0
        const accessorOrderReference: Record<string, unknown> = { kind: 'root' }
        Object.defineProperty(accessorOrderReference, 'orderIndex', {
            enumerable: true,
            get() {
                orderAccessorReads++
                throw new Error('order-reference accessor must not execute')
            },
        })
        const malformedOrderReference = {
            reason: 'invalid-record',
            record: 'bad order reference',
            originalIndex: -1,
            orderReferences: [accessorOrderReference],
        }
        const malformed = [
            42,
            extraField,
            customPrototype,
            missingRecord,
            accessorEntry,
            malformedOrderReference,
        ]
        const db: any = {
            characters: [],
            quarantinedGroupChats: [valid, nullPrototypeValid, ...malformed],
        }

        const first = normalizeGroupChatDatabase(db)

        expect(first).toEqual({ changed: true, normalizedCount: 0, quarantinedCount: 0 })
        expect(quarantineAccessorReads).toBe(0)
        expect(orderAccessorReads).toBe(0)
        expect(db.quarantinedGroupChats).toHaveLength(8)
        expect(db.quarantinedGroupChats[0]).toBe(valid)
        expect(db.quarantinedGroupChats[1]).toBe(nullPrototypeValid)
        malformed.forEach((original, index) => {
            const recovered = db.quarantinedGroupChats[index + 2]
            expect(recovered).toMatchObject({
                reason: 'invalid-record',
                originalIndex: -1,
                orderReferences: [],
            })
            if ([0, 1, 3].includes(index)) {
                expect(recovered.record).toBe(original)
            } else {
                expect(recovered.record.$risuQuarantineSnapshot.kind).toBe('object')
            }
        })

        const onceNormalized = [...db.quarantinedGroupChats]
        const second = normalizeGroupChatDatabase(db)

        expect(second).toEqual({ changed: false, normalizedCount: 0, quarantinedCount: 0 })
        expect(db.quarantinedGroupChats).toEqual(onceNormalized)
        db.quarantinedGroupChats.forEach((entry: unknown, index: number) => {
            expect(entry).toBe(onceNormalized[index])
        })
        expect(quarantineAccessorReads).toBe(0)
        expect(orderAccessorReads).toBe(0)

        let arraySlotReads = 0
        const accessorArray: unknown[] = []
        Object.defineProperty(accessorArray, '0', {
            enumerable: true,
            configurable: true,
            get() {
                arraySlotReads++
                throw new Error('quarantine array slot accessor must not execute')
            },
        })
        accessorArray.length = 1
        const accessorArrayDb: any = { characters: [], quarantinedGroupChats: accessorArray }

        expect(normalizeGroupChatDatabase(accessorArrayDb)).toEqual({
            changed: true, normalizedCount: 0, quarantinedCount: 0,
        })
        expect(arraySlotReads).toBe(0)
        expect(accessorArrayDb.quarantinedGroupChats).toHaveLength(1)
        expect(accessorArrayDb.quarantinedGroupChats[0].record)
            .toMatchObject({ $risuQuarantineSnapshot: { version: 1, kind: 'array' } })
        expect(normalizeGroupChatDatabase(accessorArrayDb)).toEqual({
            changed: false, normalizedCount: 0, quarantinedCount: 0,
        })
        expect(arraySlotReads).toBe(0)
    })

    test('wraps non-enumerable quarantine data once and remains stable after JSON reload', () => {
        const validEntry = () => ({
            reason: 'invalid-members',
            record: { type: 'group', chaId: 'payload' },
            originalIndex: 2,
            orderReferences: [{
                kind: 'folder', orderIndex: 1, folderId: 'folder', memberIndex: 0,
            }],
        })
        const makeNonEnumerable = (value: Record<string, any>, key: string) => {
            const descriptor = Object.getOwnPropertyDescriptor(value, key)!
            Object.defineProperty(value, key, { ...descriptor, enumerable: false })
            return value
        }
        const malformedEntries: unknown[] = []
        for (const key of ['reason', 'record', 'originalIndex', 'orderReferences']) {
            malformedEntries.push(makeNonEnumerable(validEntry(), key))
        }
        for (const key of ['kind', 'orderIndex', 'folderId', 'memberIndex']) {
            const entry = validEntry()
            makeNonEnumerable(entry.orderReferences[0], key)
            malformedEntries.push(entry)
        }
        const nonEnumerableOrderSlot = validEntry()
        Object.defineProperty(nonEnumerableOrderSlot.orderReferences, '0', {
            ...Object.getOwnPropertyDescriptor(nonEnumerableOrderSlot.orderReferences, '0')!,
            enumerable: false,
        })
        malformedEntries.push(nonEnumerableOrderSlot)
        const db: any = { characters: [], quarantinedGroupChats: malformedEntries }

        expect(normalizeGroupChatDatabase(db)).toEqual({
            changed: true, normalizedCount: 0, quarantinedCount: 0,
        })
        expect(db.quarantinedGroupChats).toHaveLength(malformedEntries.length)
        db.quarantinedGroupChats.forEach((entry: any, index: number) => {
            expect(entry).toMatchObject({
                reason: 'invalid-record', originalIndex: -1, orderReferences: [],
            })
            expect(entry.record).not.toBe(malformedEntries[index])
            expect(entry.record).toMatchObject({
                $risuQuarantineSnapshot: { version: 1, kind: 'object' },
            })
        })

        const reloaded = JSON.parse(JSON.stringify(db))
        const reloadedEntries = reloaded.quarantinedGroupChats
        expect(reloadedEntries).toHaveLength(malformedEntries.length)
        expect(normalizeGroupChatDatabase(reloaded)).toEqual({
            changed: false, normalizedCount: 0, quarantinedCount: 0,
        })
        expect(reloaded.quarantinedGroupChats).toHaveLength(malformedEntries.length)
        expect(reloaded.quarantinedGroupChats).toEqual(reloadedEntries)

        const nonEnumerableLogSlot: unknown[] = [validEntry()]
        Object.defineProperty(nonEnumerableLogSlot, '0', {
            ...Object.getOwnPropertyDescriptor(nonEnumerableLogSlot, '0')!,
            enumerable: false,
        })
        const slotDb: any = { characters: [], quarantinedGroupChats: nonEnumerableLogSlot }

        expect(normalizeGroupChatDatabase(slotDb).changed).toBe(true)
        expect(slotDb.quarantinedGroupChats).toHaveLength(1)
        expect(slotDb.quarantinedGroupChats[0].record).toMatchObject({
            $risuQuarantineSnapshot: { version: 1, kind: 'array' },
        })
        const reloadedSlotDb = JSON.parse(JSON.stringify(slotDb))
        expect(reloadedSlotDb.quarantinedGroupChats).toHaveLength(1)
        expect(normalizeGroupChatDatabase(reloadedSlotDb).changed).toBe(false)
        expect(reloadedSlotDb.quarantinedGroupChats).toHaveLength(1)
    })

    test('promotes a legacy msgpack undefined entry once across a canonical JSON backup reload', () => {
        // msgpackr's legacy representation of `[undefined]`. This exact value can
        // occur in old PocketRisu saves even though JSON cannot represent it.
        const legacyFixture = new Uint8Array([145, 212, 0, 0])
        const legacyEntries = new Unpackr({ useRecords: false }).decode(legacyFixture)
        expect(legacyEntries).toEqual([undefined])
        const db: any = { characters: [], quarantinedGroupChats: legacyEntries }

        expect(normalizeGroupChatDatabase(db)).toEqual({
            changed: true, normalizedCount: 0, quarantinedCount: 0,
        })
        expect(db.quarantinedGroupChats).toEqual([{
            reason: 'invalid-record',
            record: {
                $risuQuarantineSnapshot: { version: 1, kind: 'undefined' },
            },
            originalIndex: -1,
            orderReferences: [],
        }])

        const canonicalBackup = JSON.stringify(db)
        const reloaded = JSON.parse(canonicalBackup)
        const oncePromoted = reloaded.quarantinedGroupChats
        expect(Object.hasOwn(oncePromoted[0], 'record')).toBe(true)
        expect(normalizeGroupChatDatabase(reloaded)).toEqual({
            changed: false, normalizedCount: 0, quarantinedCount: 0,
        })
        expect(reloaded.quarantinedGroupChats).toEqual(oncePromoted)
    })

    test('snapshots non-JSON quarantine values without evaluating accessors or exposing secret payloads', () => {
        let accessorReads = 0
        const accessorHostile: Record<string, unknown> = { visible: 'preserved' }
        Object.defineProperty(accessorHostile, 'secret', {
            enumerable: true,
            get() {
                accessorReads++
                return 'Secret getter payload must not be expanded'
            },
        })
        const cyclic: Record<string, unknown> = { visible: 'preserved' }
        cyclic.self = cyclic
        const malformed = [
            undefined,
            function SecretFunctionSourceMustNotBeExpanded() {},
            Symbol('Secret symbol description must not be expanded'),
            42n,
            Number.NaN,
            Number.POSITIVE_INFINITY,
            Number.NEGATIVE_INFINITY,
            cyclic,
            accessorHostile,
        ]
        const db: any = { characters: [], quarantinedGroupChats: malformed }

        expect(normalizeGroupChatDatabase(db).changed).toBe(true)
        expect(accessorReads).toBe(0)
        const kinds = db.quarantinedGroupChats.map((entry: any) =>
            entry.record.$risuQuarantineSnapshot.kind)
        expect(kinds).toEqual([
            'undefined', 'function', 'symbol', 'bigint', 'nan',
            'positive-infinity', 'negative-infinity', 'object', 'object',
        ])

        const canonicalBackup = JSON.stringify(db)
        expect(accessorReads).toBe(0)
        expect(canonicalBackup).not.toContain('Secret')
        const reloaded = JSON.parse(canonicalBackup)
        expect(reloaded.quarantinedGroupChats).toHaveLength(malformed.length)
        expect(normalizeGroupChatDatabase(reloaded)).toEqual({
            changed: false, normalizedCount: 0, quarantinedCount: 0,
        })
        expect(reloaded.quarantinedGroupChats).toHaveLength(malformed.length)
    })

    test('repairs a structurally valid legacy wrapper whose record is not JSON-safe', () => {
        const legacyWrapper = {
            reason: 'invalid-members',
            record: 42n,
            originalIndex: 7,
            orderReferences: [{ kind: 'root', orderIndex: 2 }],
        }
        const db: any = { characters: [], quarantinedGroupChats: [legacyWrapper] }

        expect(normalizeGroupChatDatabase(db)).toEqual({
            changed: true, normalizedCount: 0, quarantinedCount: 0,
        })
        expect(db.quarantinedGroupChats).toEqual([{
            reason: 'invalid-members',
            record: {
                $risuQuarantineSnapshot: { version: 1, kind: 'bigint' },
            },
            originalIndex: 7,
            orderReferences: [{ kind: 'root', orderIndex: 2 }],
        }])

        const reloaded = JSON.parse(JSON.stringify(db))
        expect(normalizeGroupChatDatabase(reloaded)).toEqual({
            changed: false, normalizedCount: 0, quarantinedCount: 0,
        })
    })

    test('accepts frozen and non-writable enumerable data quarantine records', () => {
        const frozen = Object.freeze({
            reason: 'invalid-chats',
            record: Object.freeze({ preserved: true }),
            originalIndex: 3,
            orderReferences: Object.freeze([
                Object.freeze({ kind: 'root', orderIndex: 1 }),
            ]),
        })
        const nonWritableReference = Object.create(null)
        Object.defineProperties(nonWritableReference, {
            kind: { value: 'folder', enumerable: true },
            orderIndex: { value: 2, enumerable: true },
            folderId: { value: 'folder', enumerable: true },
            memberIndex: { value: 0, enumerable: true },
        })
        const nonWritable = Object.create(null)
        Object.defineProperties(nonWritable, {
            reason: { value: 'invalid-members', enumerable: true },
            record: { value: { preserved: true }, enumerable: true },
            originalIndex: { value: 4, enumerable: true },
            orderReferences: { value: Object.freeze([nonWritableReference]), enumerable: true },
        })
        const db: any = { characters: [], quarantinedGroupChats: [frozen, nonWritable] }

        expect(normalizeGroupChatDatabase(db)).toEqual({
            changed: false, normalizedCount: 0, quarantinedCount: 0,
        })
        expect(db.quarantinedGroupChats[0]).toBe(frozen)
        expect(db.quarantinedGroupChats[1]).toBe(nonWritable)
    })

    test('is idempotent and does not duplicate quarantine records', () => {
        const invalid = fullGroup({ chats: 'not-an-array' })
        const db: any = { characters: [invalid], characterOrder: ['group-1'] }

        const first = normalizeGroupChatDatabase(db)
        const second = normalizeGroupChatDatabase(db)

        expect(first.changed).toBe(true)
        expect(first.quarantinedCount).toBe(1)
        expect(second).toEqual({ changed: false, normalizedCount: 0, quarantinedCount: 0 })
        expect(db.quarantinedGroupChats).toHaveLength(1)
    })

    test('does not mutate ordinary character records', () => {
        const ordinary = character('ordinary')
        const db: any = { characters: [ordinary], characterOrder: ['ordinary'] }

        expect(normalizeGroupChatDatabase(db)).toEqual({
            changed: false,
            normalizedCount: 0,
            quarantinedCount: 0,
        })
        expect(db.characters[0]).toBe(ordinary)
        expect(db.characters[0].unknownCharacterField).toEqual({ preserved: true })
    })
})

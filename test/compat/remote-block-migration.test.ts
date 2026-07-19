/**
 * REMOTE-block migration tests.
 *
 * Background — when database.bin still carries upstream-style REMOTE blocks
 * (one pointer per character, with the payload split into a separate
 * `remotes/<chaId>.local.bin` file), the server-side decoder used to drop
 * those characters outright. The fix:
 *
 *   1. RisuSaveDecoder accepts a `resolveRemote` callback so the server can
 *      hydrate REMOTE blocks from KV.
 *   2. `migrateRemoteBlocksIfNeeded` rewrites database.bin into the legacy
 *      msgpack format on first boot / after save-folder import. After that,
 *      no decode path ever sees a REMOTE block again.
 *
 * These tests cover both pieces.
 */
import { describe, test, expect, afterAll } from 'vitest'
import { Packr } from 'msgpackr'
import * as fflate from 'fflate'
import { spawnServer, type ServerHandle } from './helpers/spawnServer.js'
import { createClient } from './helpers/client.js'
import { decodeBackup } from './helpers/decode.js'
import { normalizeBackup } from './helpers/normalize.js'

// ─── Constants mirrored from server/node/utils.cjs ──────────────────────────
// Byte arrays instead of string literals. The previous form embedded a literal
// NUL in source, which made file(1)/rg/grep treat the whole file as binary and
// broke repo-wide searches across these tests.
const MAGIC_RISUSAVE = Buffer.from([82, 73, 83, 85, 83, 65, 86, 69, 0])  // 'RISUSAVE\0', 9 bytes
const MAGIC_RAW_LEGACY = Buffer.from([0, 82, 73, 83, 85, 83, 65, 86, 69, 0, 7])
const MAGIC_COMPRESSED_LEGACY = Buffer.from([0, 82, 73, 83, 85, 83, 65, 86, 69, 0, 8])

const RisuSaveType = {
    CONFIG: 0,
    ROOT: 1,
    CHARACTER_WITH_CHAT: 2,
    BOTPRESET: 4,
    MODULES: 5,
    REMOTE: 6,
    PLUGINS: 9,
    LOADOUTS: 10,
    PLUGIN_STORAGE: 11,
} as const

// ─── RisuSave-format builders (test-side, intentionally minimal) ────────────
/**
 * Encode a single block: [type:u8][compression:u8][nameLength:u8][name][length:u32LE][data]
 */
function encodeBlock(type: number, name: string, content: string): Buffer {
    const nameBuf = Buffer.from(name, 'utf-8')
    if (nameBuf.length > 255) throw new Error('Block name too long')
    const dataBuf = Buffer.from(content, 'utf-8')
    const buf = Buffer.alloc(2 + 1 + nameBuf.length + 4 + dataBuf.length)
    buf[0] = type
    buf[1] = 0  // compression: false
    buf[2] = nameBuf.length
    nameBuf.copy(buf, 3)
    buf.writeUInt32LE(dataBuf.length, 3 + nameBuf.length)
    dataBuf.copy(buf, 3 + nameBuf.length + 4)
    return buf
}

function encodeRisuSaveWithRemoteBlocks(args: {
    rootData: Record<string, unknown>
    remoteCharacterIds: string[]
    botPresets?: unknown[]
    modules?: unknown[]
}): Buffer {
    const { rootData, remoteCharacterIds, botPresets = [], modules = [] } = args
    const blocks: Buffer[] = []
    // ROOT block carries the non-character settings + a __directory listing
    const rootWithDir = {
        ...rootData,
        __directory: [...remoteCharacterIds, 'preset', 'modules', 'config'],
    }
    blocks.push(encodeBlock(RisuSaveType.ROOT, 'root', JSON.stringify(rootWithDir)))
    blocks.push(encodeBlock(RisuSaveType.BOTPRESET, 'preset', JSON.stringify(botPresets)))
    blocks.push(encodeBlock(RisuSaveType.MODULES, 'modules', JSON.stringify(modules)))
    // One REMOTE pointer per character — payload lives in remotes/<chaId>.local.bin
    for (const chaId of remoteCharacterIds) {
        const remotePtr = JSON.stringify({ v: 1, type: RisuSaveType.CHARACTER_WITH_CHAT, name: chaId })
        blocks.push(encodeBlock(RisuSaveType.REMOTE, chaId, remotePtr))
    }
    blocks.push(encodeBlock(RisuSaveType.CONFIG, 'config', JSON.stringify({ version: 1 })))
    return Buffer.concat([MAGIC_RISUSAVE, ...blocks])
}

/** Build a save-folder zip with hex-named entries the server can ingest. */
function buildSaveFolderZip(entries: Record<string, Buffer>): Buffer {
    const zippable: Record<string, Uint8Array> = {}
    for (const [key, value] of Object.entries(entries)) {
        const hexName = Buffer.from(key, 'utf-8').toString('hex')
        zippable[hexName] = new Uint8Array(value)
    }
    return Buffer.from(fflate.zipSync(zippable))
}

/** Make a complete character object matching what the server expects. */
function buildCharacter(chaId: string, name: string, firstMessage: string) {
    return {
        name,
        chaId,
        desc: 'A test character',
        firstMessage,
        image: '',
        type: 'character',
        chatPage: 0,
        firstMsgIndex: -1,
        chats: [{
            id: `${chaId}-chat-0`,
            name: 'Chat 0',
            message: [
                { role: 'char', data: firstMessage },
                { role: 'user', data: 'Hi back!' },
            ],
            lastDate: Date.now(),
            localLore: [],
            note: '',
        }],
        chatFolders: [],
        notes: '', emotionImages: [], bias: [], globalLore: [],
        viewScreen: 'none', sdData: [], utilityBot: false,
        customscript: [], triggerscript: [],
        exampleMessage: '', creatorNotes: '', systemPrompt: '',
        postHistoryInstructions: '', alternateGreetings: [],
        tags: [], creator: '', characterVersion: '',
        personality: '', scenario: '', replaceGlobalNote: '',
        additionalText: '',
    }
}

// ─── Unit tests against the decoder/scanner directly ────────────────────────
// utils.cjs is CommonJS — load via require() under the node-env compat suite.
const utils = require('../../server/node/utils.cjs') as typeof import('../../server/node/utils.cjs')

describe('hasRemoteBlocks scanner', () => {
    test('detects a REMOTE block in a RisuSave buffer', () => {
        const buf = encodeRisuSaveWithRemoteBlocks({
            rootData: { apiType: 'openai' },
            remoteCharacterIds: ['char-1'],
        })
        expect(utils.hasRemoteBlocks(buf)).toBe(true)
    })

    test('returns false when the buffer has no REMOTE block', () => {
        const buf = encodeRisuSaveWithRemoteBlocks({
            rootData: { apiType: 'openai' },
            remoteCharacterIds: [],  // only ROOT/BOTPRESET/MODULES/CONFIG
        })
        expect(utils.hasRemoteBlocks(buf)).toBe(false)
    })

    test('returns false for legacy (msgpack) format buffers', () => {
        const packr = new Packr({ useRecords: false })
        const legacyDb = Buffer.concat([MAGIC_RAW_LEGACY, packr.encode({ characters: [] })])
        expect(utils.hasRemoteBlocks(legacyDb)).toBe(false)
    })

    test('returns false for non-RisuSave buffers (empty, garbage)', () => {
        expect(utils.hasRemoteBlocks(Buffer.alloc(0))).toBe(false)
        expect(utils.hasRemoteBlocks(Buffer.from('not a risu save'))).toBe(false)
    })
})

describe('decodeRisuSave with resolveRemote', () => {
    test('skips REMOTE blocks when no resolver is provided', async () => {
        const buf = encodeRisuSaveWithRemoteBlocks({
            rootData: { apiType: 'openai' },
            remoteCharacterIds: ['ghost-1'],
        })
        const db = await utils.decodeRisuSave(buf) as { characters?: unknown[] }
        // The character should be missing — this is the bug behavior we're
        // documenting. The migration path supplies a resolver so this only
        // happens when the caller explicitly opts out.
        expect(Array.isArray(db.characters)).toBe(true)
        expect((db.characters as unknown[]).length).toBe(0)
    })

    test('resolves REMOTE blocks via the callback', async () => {
        const character = buildCharacter('alpha', 'Alpha', 'hi from alpha')
        const dbBuf = encodeRisuSaveWithRemoteBlocks({
            rootData: { apiType: 'openai' },
            remoteCharacterIds: ['alpha'],
        })
        // Resolver maps name → Uint8Array payload (UTF-8 of the JSON character)
        const charBytes = new TextEncoder().encode(JSON.stringify(character))
        const db = await utils.decodeRisuSave(dbBuf, {
            resolveRemote: async (name: string) => name === 'alpha' ? charBytes : null,
        }) as { characters: Array<{ chaId: string; name: string; chats: Array<{ message: unknown[] }> }> }
        expect(db.characters.length).toBe(1)
        expect(db.characters[0].chaId).toBe('alpha')
        expect(db.characters[0].name).toBe('Alpha')
        expect(db.characters[0].chats[0].message.length).toBe(2)
    })

    test('continues past a missing remote block instead of failing the whole decode', async () => {
        const goodChar = buildCharacter('good', 'Good', 'present')
        const dbBuf = encodeRisuSaveWithRemoteBlocks({
            rootData: { apiType: 'openai' },
            remoteCharacterIds: ['good', 'missing'],
        })
        const goodBytes = new TextEncoder().encode(JSON.stringify(goodChar))
        const db = await utils.decodeRisuSave(dbBuf, {
            resolveRemote: async (name: string) => name === 'good' ? goodBytes : null,
        }) as { characters: Array<{ chaId: string }> }
        // We get the good one; the missing one is dropped with a warning.
        expect(db.characters.map(c => c.chaId)).toEqual(['good'])
    })
})

// ─── Integration test: save-folder upload → boot migration ──────────────────
const servers: ServerHandle[] = []
afterAll(async () => {
    await Promise.allSettled(servers.map(s => s.cleanup()))
})

describe('boot-time remote-block migration', () => {
    test('inlines remote characters after save-folder upload', async () => {
        const srv = await spawnServer()
        servers.push(srv)
        const client = await createClient(srv.port, srv.password)

        // Build database.bin with two REMOTE-pointer characters and their group.
        const charA = buildCharacter('cha-A', 'Alpha', 'hello from alpha')
        const charB = buildCharacter('cha-B', 'Beta', 'hello from beta')
        const group = {
            type: 'group', chaId: 'group-AB', name: 'Alpha and Beta', firstMessage: 'together',
            characters: ['cha-A', 'cha-B'], characterTalks: [2 / 3, 2 / 3], characterActive: [true, true],
            chats: [{
                id: 'group-chat', name: 'Group chat', note: 'remote group', localLore: [],
                modules: ['remote-module'], scriptstate: { remote: true },
                pluginState: { retained: true }, unknownChatField: { retained: true },
                message: [
                    { role: 'char', data: 'alpha in group', saying: 'cha-A', chatId: 'remote-a' },
                    { role: 'char', data: 'beta in group', saying: 'cha-B', chatId: 'remote-b' },
                ],
            }],
            chatPage: 0, chatFolders: [], viewScreen: 'none', globalLore: [], autoMode: false,
            useCharacterLore: true, emotionImages: [], customscript: [], unknownGroupField: ['retained'],
        }
        const dbBin = encodeRisuSaveWithRemoteBlocks({
            rootData: {
                apiType: 'openai',
                mainPrompt: '',
                jailbreak: '',
                globalNote: '',
                temperature: 80,
                personas: [{ name: 'Default', icon: '', personaPrompt: '' }],
                selectedCharacter: 0,
            },
            remoteCharacterIds: ['cha-A', 'cha-B', 'group-AB'],
        })

        const zip = buildSaveFolderZip({
            'database/database.bin': dbBin,
            'remotes/cha-A.local.bin': Buffer.from(JSON.stringify(charA), 'utf-8'),
            'remotes/cha-B.local.bin': Buffer.from(JSON.stringify(charB), 'utf-8'),
            'remotes/group-AB.local.bin': Buffer.from(JSON.stringify(group), 'utf-8'),
        })

        // Upload via save-folder/upload endpoint
        const upRes = await client.fetch('/api/migrate/save-folder/upload', {
            method: 'POST',
            // 'application/zip' (not octet-stream) so the global express.raw()
            // middleware leaves the body unbuffered for the streaming handler.
            headers: { 'content-type': 'application/zip' },
            body: new Uint8Array(zip),
        })
        expect(upRes.ok).toBe(true)

        // Trigger ensureChatStore via /api/read on database.bin — this is the
        // first decode after import and where the migration kicks in.
        const readRes = await client.fetch('/api/read', {
            headers: {
                'file-path': Buffer.from('database/database.bin', 'utf-8').toString('hex'),
            },
        })
        expect(readRes.ok).toBe(true)

        // Export and verify both REMOTE characters are present with chats
        const exported = await client.exportBackup()
        const { normalized, raw } = normalizeBackup(exported)
        const ids = new Set(normalized.characters.map(c => c.chaId))
        expect(ids.has('cha-A')).toBe(true)
        expect(ids.has('cha-B')).toBe(true)
        expect(ids.has('group-AB')).toBe(true)

        const a = normalized.characters.find(c => c.chaId === 'cha-A')!
        const b = normalized.characters.find(c => c.chaId === 'cha-B')!
        expect(a.firstMessages).toEqual(['hello from alpha'])
        expect(b.firstMessages).toEqual(['hello from beta'])
        expect(a.messageCounts[0]).toBeGreaterThan(0)
        expect(b.messageCounts[0]).toBeGreaterThan(0)
        expect((raw as any).characters.find((record: any) => record.chaId === 'group-AB')).toMatchObject({
            type: 'group',
            characters: ['cha-A', 'cha-B'],
            unknownGroupField: ['retained'],
            chats: [{
                modules: ['remote-module'],
                scriptstate: { remote: true },
                pluginState: { retained: true },
                unknownChatField: { retained: true },
                message: [
                    { data: 'alpha in group', saying: 'cha-A', chatId: 'remote-a' },
                    { data: 'beta in group', saying: 'cha-B', chatId: 'remote-b' },
                ],
            }],
        })
    })

    test('migrated database.bin no longer carries a RisuSave magic header', async () => {
        const srv = await spawnServer()
        servers.push(srv)
        const client = await createClient(srv.port, srv.password)

        const ghost = buildCharacter('ghost', 'Ghost', 'boo')
        const zip = buildSaveFolderZip({
            'database/database.bin': encodeRisuSaveWithRemoteBlocks({
                rootData: { apiType: 'openai', selectedCharacter: 0 },
                remoteCharacterIds: ['ghost'],
            }),
            'remotes/ghost.local.bin': Buffer.from(JSON.stringify(ghost), 'utf-8'),
        })
        await client.fetch('/api/migrate/save-folder/upload', {
            method: 'POST',
            // 'application/zip' (not octet-stream) so the global express.raw()
            // middleware leaves the body unbuffered for the streaming handler.
            headers: { 'content-type': 'application/zip' },
            body: new Uint8Array(zip),
        })
        await client.fetch('/api/read', {
            headers: {
                'file-path': Buffer.from('database/database.bin', 'utf-8').toString('hex'),
            },
        })

        // After migration, the on-disk database.bin should be in legacy msgpack
        // format (compressed). Inspect it directly via the export endpoint's
        // database.risudat entry — server returns the kv blob verbatim.
        const exported = await client.exportBackup()
        const entries = decodeBackup(exported)
        const dbEntry = entries.find(e => e.name === 'database.risudat')!
        // Legacy compressed prefix: \0RISUSAVE\0\x08
        const isLegacyCompressed = dbEntry.data.subarray(0, MAGIC_COMPRESSED_LEGACY.length).equals(MAGIC_COMPRESSED_LEGACY)
        const isLegacyRaw = dbEntry.data.subarray(0, MAGIC_RAW_LEGACY.length).equals(MAGIC_RAW_LEGACY)
        expect(isLegacyCompressed || isLegacyRaw).toBe(true)
        // No RisuSave magic header — block format is gone
        const startsWithRisuSave = dbEntry.data.subarray(0, MAGIC_RISUSAVE.length).equals(MAGIC_RISUSAVE)
        expect(startsWithRisuSave).toBe(false)
    })

    test('migration is idempotent — second trigger is a no-op', async () => {
        const srv = await spawnServer()
        servers.push(srv)
        const client = await createClient(srv.port, srv.password)

        const ghost = buildCharacter('ghost2', 'Ghost2', 'boo2')
        const zip = buildSaveFolderZip({
            'database/database.bin': encodeRisuSaveWithRemoteBlocks({
                rootData: { apiType: 'openai', selectedCharacter: 0 },
                remoteCharacterIds: ['ghost2'],
            }),
            'remotes/ghost2.local.bin': Buffer.from(JSON.stringify(ghost), 'utf-8'),
        })
        await client.fetch('/api/migrate/save-folder/upload', {
            method: 'POST',
            // 'application/zip' (not octet-stream) so the global express.raw()
            // middleware leaves the body unbuffered for the streaming handler.
            headers: { 'content-type': 'application/zip' },
            body: new Uint8Array(zip),
        })

        // First read — triggers migration
        const r1 = await client.fetch('/api/read', {
            headers: { 'file-path': Buffer.from('database/database.bin', 'utf-8').toString('hex') },
        })
        expect(r1.ok).toBe(true)
        const exported1 = await client.exportBackup()

        // Second read — should not re-migrate
        const r2 = await client.fetch('/api/read', {
            headers: { 'file-path': Buffer.from('database/database.bin', 'utf-8').toString('hex') },
        })
        expect(r2.ok).toBe(true)
        const exported2 = await client.exportBackup()

        // Both exports should agree on character set (idempotent character data)
        const n1 = normalizeBackup(exported1).normalized
        const n2 = normalizeBackup(exported2).normalized
        expect(n2.characters.map(c => c.chaId)).toEqual(n1.characters.map(c => c.chaId))
    })

    test('non-existent remote file is reported and skipped (rest survive)', async () => {
        const srv = await spawnServer()
        servers.push(srv)
        const client = await createClient(srv.port, srv.password)

        const ok = buildCharacter('cha-ok', 'OK', 'fine')
        const zip = buildSaveFolderZip({
            'database/database.bin': encodeRisuSaveWithRemoteBlocks({
                rootData: { apiType: 'openai', selectedCharacter: 0 },
                remoteCharacterIds: ['cha-ok', 'cha-broken'],
            }),
            'remotes/cha-ok.local.bin': Buffer.from(JSON.stringify(ok), 'utf-8'),
            // Intentionally omit remotes/cha-broken.local.bin
        })
        await client.fetch('/api/migrate/save-folder/upload', {
            method: 'POST',
            // 'application/zip' (not octet-stream) so the global express.raw()
            // middleware leaves the body unbuffered for the streaming handler.
            headers: { 'content-type': 'application/zip' },
            body: new Uint8Array(zip),
        })
        await client.fetch('/api/read', {
            headers: { 'file-path': Buffer.from('database/database.bin', 'utf-8').toString('hex') },
        })

        const exported = await client.exportBackup()
        const { normalized } = normalizeBackup(exported)
        const ids = normalized.characters.map(c => c.chaId)
        expect(ids).toContain('cha-ok')
        // cha-broken's payload was missing — character is dropped (warning logged
        // server-side), but the migration as a whole still completes.
        expect(ids).not.toContain('cha-broken')
    })
})

// ─── Snapshot restore should re-run migration when needed ───────────────────
// Regression guard for the scenario where:
//   1. NodeOnly v1.5 has already migrated (marker = done, remotes/ GC'd).
//   2. A `database/dbbackup-*` snapshot taken on v1.4 still holds REMOTE-block
//      bytes pointing into remotes/<id>.local.bin.
//   3. User restores that snapshot.
//
// Without the fix, the pre-warm decode skipped REMOTE blocks (no resolver) and
// initialized fullChatStore with the missing-character dbObj. The marker stayed
// "done", so subsequent ensureChatStore calls also skipped migration — the
// restored data silently disappeared.
describe('snapshot restore with legacy REMOTE-block snapshots', () => {
    test('re-runs migration so REMOTE-pointed characters survive', async () => {
        const srv = await spawnServer()
        servers.push(srv)
        const client = await createClient(srv.port, srv.password)

        const character = buildCharacter('snap-char', 'SnapChar', 'restored from snapshot')
        // Live DB: an already-migrated legacy buffer with no characters — mimics
        // the post-migration state on v1.5.
        const packr = new Packr({ useRecords: false })
        const liveLegacyDb = Buffer.concat([MAGIC_RAW_LEGACY, packr.encode({ characters: [] })])
        // Snapshot: pre-migration REMOTE-block buffer.
        const remoteSnap = encodeRisuSaveWithRemoteBlocks({
            rootData: { apiType: 'openai', selectedCharacter: 0 },
            remoteCharacterIds: ['snap-char'],
        })
        const snapshotKey = `database/dbbackup-${Date.now()}.bin`

        // Seed KV via save-folder upload. The marker hex entry survives
        // clearExistingData's delete (deletion happens before INSERT in the
        // transaction), leaving the post-migration state intact.
        const zip = buildSaveFolderZip({
            'database/database.bin': liveLegacyDb,
            [snapshotKey]: remoteSnap,
            'remotes/snap-char.local.bin': Buffer.from(JSON.stringify(character), 'utf-8'),
            'migration/disable-remote-saving': Buffer.from('done', 'utf-8'),
        })
        await client.fetch('/api/migrate/save-folder/upload', {
            method: 'POST',
            headers: { 'content-type': 'application/zip' },
            body: new Uint8Array(zip),
        })

        // First /api/read populates dbCache + initChatStore for the legacy live DB.
        // Migration sees marker=done & legacy buffer → no-op.
        await client.fetch('/api/read', {
            headers: { 'file-path': Buffer.from('database/database.bin', 'utf-8').toString('hex') },
        })

        // Now restore the REMOTE-block snapshot. With the fix, the marker is
        // cleared and decodeDatabaseWithPersistentChatIds re-runs migration —
        // resolveRemote picks up the still-present remotes/ payload.
        const restoreRes = await client.fetch('/api/db/snapshots/restore', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ key: snapshotKey }),
        })
        expect(restoreRes.ok).toBe(true)

        // After restore + remigration, the character must be visible again.
        const exported = await client.exportBackup()
        const { normalized } = normalizeBackup(exported)
        const ids = normalized.characters.map(c => c.chaId)
        expect(ids).toContain('snap-char')
        const sc = normalized.characters.find(c => c.chaId === 'snap-char')!
        expect(sc.firstMessages).toEqual(['restored from snapshot'])
        expect(sc.messageCounts[0]).toBeGreaterThan(0)

        // The restored live DB should now be in legacy format (migration
        // reencoded it). The snapshot file itself is untouched.
        const dbEntry = decodeBackup(exported).find(e => e.name === 'database.risudat')!
        const isLegacy =
            dbEntry.data.subarray(0, MAGIC_RAW_LEGACY.length).equals(MAGIC_RAW_LEGACY) ||
            dbEntry.data.subarray(0, MAGIC_COMPRESSED_LEGACY.length).equals(MAGIC_COMPRESSED_LEGACY)
        expect(isLegacy).toBe(true)
    })

    test('post-migration restore of REMOTE snapshot still works when no remotes/ seeded by test setup', async () => {
        // Tighter regression for the "production GC'd state" case the original
        // suite missed. The previous test seeded remotes/snap-char.local.bin
        // explicitly via the save-folder zip — that masked whether the live
        // remotes/ survived the boot migration. Here we instead let the boot
        // migration run on a REMOTE-block DB, then take a snapshot ourselves
        // (so the snapshot points at the same remotes/ keys that the migration
        // would historically have deleted). If remotes/ get garbage-collected,
        // the subsequent snapshot restore fails to recover the character.
        const srv = await spawnServer()
        servers.push(srv)
        const client = await createClient(srv.port, srv.password)

        const character = buildCharacter('survivor', 'Survivor', 'still here')
        const remoteSnap = encodeRisuSaveWithRemoteBlocks({
            rootData: { apiType: 'openai', selectedCharacter: 0 },
            remoteCharacterIds: ['survivor'],
        })
        // Pre-stage a snapshot key holding the SAME REMOTE-block buffer so we
        // can restore it after the live DB has been migrated. No marker — boot
        // migration runs on first /api/read.
        const snapshotKey = `database/dbbackup-${Date.now()}.bin`
        const zip = buildSaveFolderZip({
            'database/database.bin': remoteSnap,
            [snapshotKey]: remoteSnap,
            'remotes/survivor.local.bin': Buffer.from(JSON.stringify(character), 'utf-8'),
        })
        await client.fetch('/api/migrate/save-folder/upload', {
            method: 'POST',
            headers: { 'content-type': 'application/zip' },
            body: new Uint8Array(zip),
        })

        // First read: triggers boot-time migration. After the fix, remotes/
        // survive. Before the fix, this is where they get wiped.
        const r1 = await client.fetch('/api/read', {
            headers: { 'file-path': Buffer.from('database/database.bin', 'utf-8').toString('hex') },
        })
        expect(r1.ok).toBe(true)

        // Now restore the snapshot — the snapshot still holds REMOTE pointers.
        // resolveRemote needs remotes/survivor.local.bin to still exist in KV.
        const restoreRes = await client.fetch('/api/db/snapshots/restore', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ key: snapshotKey }),
        })
        expect(restoreRes.ok).toBe(true)

        // If remotes/ were GC'd by the boot migration, the restore re-migration
        // can't resolve the REMOTE pointer and the character vanishes — that's
        // the regression this guards against.
        const exported = await client.exportBackup()
        const { normalized } = normalizeBackup(exported)
        const ids = normalized.characters.map(c => c.chaId)
        expect(ids).toContain('survivor')
        const sc = normalized.characters.find(c => c.chaId === 'survivor')!
        expect(sc.firstMessages).toEqual(['still here'])
        expect(sc.messageCounts[0]).toBeGreaterThan(0)
    })

    test('restoring an already-legacy snapshot is a no-op for migration', async () => {
        // Symmetric guard: when the snapshot has no REMOTE blocks the fix must
        // not regress — restore should just put the bytes in place.
        const srv = await spawnServer()
        servers.push(srv)
        const client = await createClient(srv.port, srv.password)

        const packr = new Packr({ useRecords: false })
        const dbA = Buffer.concat([MAGIC_RAW_LEGACY, packr.encode({
            characters: [{
                name: 'Snap',
                chaId: 'legacy-snap',
                desc: '',
                firstMessage: 'hi',
                image: '',
                type: 'character',
                chatPage: 0,
                chats: [{
                    id: 'legacy-snap-chat-0',
                    name: 'Chat 0',
                    message: [{ role: 'char', data: 'hello legacy' }],
                    lastDate: Date.now(),
                    localLore: [],
                    note: '',
                }],
            }],
        })])
        const snapshotKey = `database/dbbackup-${Date.now()}.bin`
        const zip = buildSaveFolderZip({
            'database/database.bin': Buffer.concat([MAGIC_RAW_LEGACY, packr.encode({ characters: [] })]),
            [snapshotKey]: dbA,
            'migration/disable-remote-saving': Buffer.from('done', 'utf-8'),
        })
        await client.fetch('/api/migrate/save-folder/upload', {
            method: 'POST',
            headers: { 'content-type': 'application/zip' },
            body: new Uint8Array(zip),
        })
        await client.fetch('/api/read', {
            headers: { 'file-path': Buffer.from('database/database.bin', 'utf-8').toString('hex') },
        })

        const restoreRes = await client.fetch('/api/db/snapshots/restore', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ key: snapshotKey }),
        })
        expect(restoreRes.ok).toBe(true)

        const exported = await client.exportBackup()
        const { normalized } = normalizeBackup(exported)
        expect(normalized.characters.map(c => c.chaId)).toContain('legacy-snap')
    })
})

// ─── Save-folder import must clear the previous user's remotes/ ─────────────
// Background: clearExistingData runs at the start of every save-folder import
// (kvDelPrefix on assets/, inlay*/, etc., then INSERT OR REPLACE from the new
// payload). If remotes/ isn't cleared, an imported database.bin that carries
// REMOTE pointers but no fresh remotes/ payload will silently stitch in the
// previous user's data via the migration resolver — cross-user contamination.
describe('save-folder import clears stale remotes/', () => {
    test('previous user\'s remotes/<id> is wiped before new import lands', async () => {
        const srv = await spawnServer()
        servers.push(srv)
        const client = await createClient(srv.port, srv.password)

        // Round 1 — user A's data. Legacy inline DB (no REMOTE blocks, so the
        // boot migration won't run and won't wipe remotes/) PLUS an "orphan"
        // remotes/shared-id.local.bin in the same import. This is the smallest
        // reproducer of the scenario where stale remote payloads sit in KV
        // without being needed by the live DB — a legitimate state if user A
        // had previously been running on a REMOTE-block DB and only later
        // moved to inline.
        const packr = new Packr({ useRecords: false })
        const liveLegacyDbA = Buffer.concat([MAGIC_RAW_LEGACY, packr.encode({ characters: [] })])
        const userA = buildCharacter('shared-id', 'UserA', 'user A first message')
        const zipA = buildSaveFolderZip({
            'database/database.bin': liveLegacyDbA,
            'remotes/shared-id.local.bin': Buffer.from(JSON.stringify(userA), 'utf-8'),
            'migration/disable-remote-saving': Buffer.from('done', 'utf-8'),
        })
        await client.fetch('/api/migrate/save-folder/upload', {
            method: 'POST',
            headers: { 'content-type': 'application/zip' },
            body: new Uint8Array(zipA),
        })
        await client.fetch('/api/read', {
            headers: { 'file-path': Buffer.from('database/database.bin', 'utf-8').toString('hex') },
        })

        // Round 2 — user B's import re-uses the same chaId in a REMOTE-block
        // DB but does NOT ship a remotes/ payload. clearExistingData should
        // wipe remotes/ before the new entries land; if it doesn't, user A's
        // stale payload is still in KV and the migration resolver hands it
        // back to user B as if it were B's data.
        const dbB = encodeRisuSaveWithRemoteBlocks({
            rootData: { apiType: 'openai', selectedCharacter: 0 },
            remoteCharacterIds: ['shared-id'],
        })
        const zipB = buildSaveFolderZip({
            'database/database.bin': dbB,
            // No remotes/shared-id.local.bin — the contamination opportunity.
            // Also no marker, so the migration runs on the new DB.
        })
        await client.fetch('/api/migrate/save-folder/upload', {
            method: 'POST',
            headers: { 'content-type': 'application/zip' },
            body: new Uint8Array(zipB),
        })
        await client.fetch('/api/read', {
            headers: { 'file-path': Buffer.from('database/database.bin', 'utf-8').toString('hex') },
        })

        // After the fix: user A's remotes/ was wiped at the start of B's
        // import. resolveRemote returns null on shared-id; the character is
        // dropped (the safer "missing" outcome — user sees nothing rather
        // than user A's content).
        //
        // Without the fix: user A's remotes/shared-id.local.bin survived the
        // clear, the migration's resolveRemote picked it up, and user A's
        // firstMessage shows up under chaId 'shared-id' in user B's session.
        const exportedB = await client.exportBackup()
        const b = normalizeBackup(exportedB).normalized.characters.find(c => c.chaId === 'shared-id')
        if (b) {
            expect(b.firstMessages).not.toEqual(['user A first message'])
        } else {
            expect(b).toBeUndefined()
        }
    })
})

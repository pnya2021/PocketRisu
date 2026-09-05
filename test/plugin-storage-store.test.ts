// @vitest-environment node
/**
 * plugin-storage-store: DB → kv migration of pluginCustomStorage.
 *
 * Unit tests drive the store against an in-memory SQLite with the same kv
 * schema as db.cjs. Integration tests spawn a real server and check the
 * import → migrate → index → export → re-import loop end to end.
 */
import { describe, test, expect, afterAll } from 'vitest'
import { createHash } from 'node:crypto'
import Database from 'better-sqlite3'
import { Packr } from 'msgpackr'
import { spawnServer, type ServerHandle } from './compat/helpers/spawnServer.js'
import { createClient, type RisuClient } from './compat/helpers/client.js'
import { encodeBackup } from './compat/helpers/encode.js'
import { decodeBackup } from './compat/helpers/decode.js'

const storeMod = require('../server/node/plugin-storage-store.cjs')
const utils = require('../server/node/utils.cjs') as typeof import('../server/node/utils.cjs')

const { createPluginStorageStore, encodeKey, decodeKey, PREFIX, MIGRATED_MARKER_KEY, SNAPSHOT_PREFIX, BLOB_PREFIX } = storeMod

// ─── Unit: in-memory kv with the db.cjs schema ─────────────────────────────

function memoryKv() {
    const db = new Database(':memory:')
    db.exec(`CREATE TABLE kv (key TEXT PRIMARY KEY, value BLOB NOT NULL, updated_at INTEGER NOT NULL DEFAULT 0)`)
    const esc = (p: string) => p.replace(/[\\%_]/g, '\\$&') + '%'
    const deps = {
        db,
        kvGet: (k: string) => (db.prepare('SELECT value FROM kv WHERE key = ?').get(k) as any)?.value ?? null,
        kvSet: (k: string, v: Buffer) => { db.prepare('INSERT OR REPLACE INTO kv (key, value, updated_at) VALUES (?, ?, ?)').run(k, v, Date.now()) },
        kvDel: (k: string) => { db.prepare('DELETE FROM kv WHERE key = ?').run(k) },
        kvDelPrefix: (p: string) => { db.prepare(`DELETE FROM kv WHERE key LIKE ? ESCAPE '\\'`).run(esc(p)) },
        kvListWithSizes: (p: string) => db.prepare(`SELECT key, LENGTH(value) AS size FROM kv WHERE key LIKE ? ESCAPE '\\'`).all(esc(p)) as { key: string; size: number }[],
    }
    return { db, deps, store: createPluginStorageStore(deps) }
}

// JSON.parse yields an OWN "__proto__" property — the shape a plugin key with
// that name actually has after decoding.
function seedStorage() {
    return JSON.parse(JSON.stringify({
        plain: 'hello',
        'a::chunk:v1:x': 'AAAA====',
        nested: { n: 1, list: [1, 2] },
    }).replace('"plain"', '"__proto__":"polluted","plain"'))
}

describe('key encoding', () => {
    test('matches persistentKv base64url and round-trips special keys', () => {
        expect(encodeKey('a::chunk:v1:x')).toBe(Buffer.from('a::chunk:v1:x').toString('base64url'))
        for (const k of ['a::chunk:v1:x', '한글 키', '__proto__', 'x/y+z=', ''.padEnd(300, 'k')]) {
            expect(decodeKey(`${PREFIX}${encodeKey(k)}`)).toBe(k)
        }
        expect(encodeKey('x/y+z=')).not.toMatch(/[+/=]/)
    })
})

describe('migrateFromDb (unit)', () => {
    test('moves every key into kv, lists them, and reports counts; caller empties the DB field', () => {
        const { store, deps } = memoryKv()
        const storage = seedStorage()
        expect(Object.keys(storage)).toContain('__proto__')
        const dbObj = { username: 'u', pluginCustomStorage: storage }

        let snapshots = 0
        const result = store.migrateFromDb(dbObj, { createSnapshot: () => { snapshots++ } })
        expect(snapshots).toBe(1)
        expect(result.migrated).toBe(true)
        expect(result.keys).toBe(4)
        const expectedBytes = Object.keys(storage).reduce((s, k) =>
            s + Buffer.byteLength(JSON.stringify(Object.getOwnPropertyDescriptor(storage, k)!.value)), 0)
        expect(result.bytes).toBe(expectedBytes)

        // Store never touches the caller's object.
        expect(dbObj.pluginCustomStorage).toBe(storage)

        const listed = store.list().map((e: any) => e.key).sort()
        expect(listed).toEqual(['__proto__', 'a::chunk:v1:x', 'nested', 'plain'])
        expect(store.get('a::chunk:v1:x')).toBe('AAAA====')
        expect(store.get('nested')).toEqual({ n: 1, list: [1, 2] })
        expect(store.get('__proto__')).toBe('polluted')
        expect(store.get('missing')).toBeNull()
        expect(store.isMigrated()).toBe(true)
        expect(JSON.parse(Buffer.from(deps.kvGet(MIGRATED_MARKER_KEY)).toString())).toMatchObject({ version: 1, keys: 4 })

        // readAll rebuilds the original shape without prototype pollution.
        const all = store.readAll()
        expect(Object.getPrototypeOf(all)).toBe(Object.prototype)
        expect(Object.keys(all).sort()).toEqual(listed)
        expect(({} as any).polluted).toBeUndefined()
    })

    test('is a no-op on missing or empty storage, and idempotent after a run', () => {
        const { store } = memoryKv()
        expect(store.migrateFromDb({})).toEqual({ migrated: false, keys: 0, bytes: 0 })
        expect(store.migrateFromDb({ pluginCustomStorage: {} })).toEqual({ migrated: false, keys: 0, bytes: 0 })
        expect(store.migrateFromDb({ pluginCustomStorage: null })).toEqual({ migrated: false, keys: 0, bytes: 0 })
        expect(store.list()).toEqual([])
        expect(store.isMigrated()).toBe(false)

        const dbObj: any = { pluginCustomStorage: { k: 'v' } }
        expect(store.migrateFromDb(dbObj).migrated).toBe(true)
        dbObj.pluginCustomStorage = {}
        let snapshots = 0
        expect(store.migrateFromDb(dbObj, { createSnapshot: () => { snapshots++ } })).toEqual({ migrated: false, keys: 0, bytes: 0 })
        expect(snapshots).toBe(0)
        expect(store.get('k')).toBe('v')
    })

    test('DB value wins over an existing kv key; untouched kv keys survive', () => {
        const { store } = memoryKv()
        store.set('shared', 'from-kv')
        store.set('only-kv', 'stays')
        store.migrateFromDb({ pluginCustomStorage: { shared: 'from-db', 'only-db': 1 } })
        expect(store.get('shared')).toBe('from-db')
        expect(store.get('only-kv')).toBe('stays')
        expect(store.get('only-db')).toBe(1)
        expect(store.list().length).toBe(3)
    })

    test('a failing write rolls back everything: no keys, no marker, DB untouched', () => {
        const { deps, store: _unused, db } = memoryKv()
        let calls = 0
        const failing = createPluginStorageStore({
            ...deps,
            kvSet: (k: string, v: Buffer) => {
                if (++calls === 2) throw new Error('disk full')
                deps.kvSet(k, v)
            },
        })
        failing.set('pre', 'existing')
        calls = 0
        const storage = { a: 'x'.repeat(100), b: 'y', c: 'z' }
        const dbObj = { pluginCustomStorage: storage }
        expect(() => failing.migrateFromDb(dbObj)).toThrow('disk full')
        expect(dbObj.pluginCustomStorage).toEqual({ a: 'x'.repeat(100), b: 'y', c: 'z' })
        expect(failing.list().map((e: any) => e.key)).toEqual(['pre'])
        expect(failing.isMigrated()).toBe(false)
        expect((db.prepare('SELECT COUNT(*) AS c FROM kv').get() as any).c).toBe(1)
    })

    test('verification catches a kvSet that silently drops writes', () => {
        const { deps } = memoryKv()
        const lossy = createPluginStorageStore({ ...deps, kvSet: () => {} })
        expect(() => lossy.migrateFromDb({ pluginCustomStorage: { a: 1 } })).toThrow(/missing after write/)
        expect(lossy.list()).toEqual([])
    })

    test('removeAll drops keys and the marker', () => {
        const { store } = memoryKv()
        store.migrateFromDb({ pluginCustomStorage: { a: 1 } })
        store.removeAll()
        expect(store.list()).toEqual([])
        expect(store.isMigrated()).toBe(false)
    })

    test('re-migration: kv wins for keys the client has since updated, DB-wins on first run', () => {
        const { store } = memoryKv()
        let snapshots = 0
        const snap = { createSnapshot: () => { snapshots++ } }
        // First migration: DB-wins, snapshot taken.
        store.set('a', 'stale-kv')
        expect(store.migrateFromDb({ pluginCustomStorage: { a: 'db-1', b: 'db-1' } }, { ...snap, kvWinsOnRemigration: true }))
            .toMatchObject({ migrated: true, keys: 2, skipped: 0 })
        expect(snapshots).toBe(1)
        expect(store.get('a')).toBe('db-1')

        // Emptied blob never persisted; meanwhile a client updated `a` in kv.
        store.set('a', 'client-2')
        const result = store.migrateFromDb(
            { pluginCustomStorage: { a: 'db-1', b: 'db-1', c: 'db-1' } },
            { ...snap, kvWinsOnRemigration: true },
        )
        expect(result).toMatchObject({ migrated: true, keys: 1, skipped: 2 })
        expect(snapshots).toBe(1) // no snapshot spam on retry
        expect(store.get('a')).toBe('client-2')
        expect(store.get('b')).toBe('db-1')
        expect(store.get('c')).toBe('db-1')

        // All keys already in kv → still `migrated: true` so the caller empties the blob.
        expect(store.migrateFromDb({ pluginCustomStorage: { a: 'x' } }, { kvWinsOnRemigration: true }))
            .toMatchObject({ migrated: true, keys: 0, skipped: 1 })
        expect(store.get('a')).toBe('client-2')

        // Full-write path (flag off): DB always wins, even after the marker exists.
        expect(store.migrateFromDb({ pluginCustomStorage: { a: 'writer-3' } }, snap))
            .toMatchObject({ migrated: true, keys: 1, skipped: 0 })
        expect(snapshots).toBe(1)
        expect(store.get('a')).toBe('writer-3')
    })
})

describe('content-addressed snapshots (unit)', () => {
    const sha = (v: unknown) => createHash('sha256').update(Buffer.from(JSON.stringify(v))).digest('hex')
    const blobKeys = (deps: any) => deps.kvListWithSizes(BLOB_PREFIX).map((e: any) => e.key.slice(BLOB_PREFIX.length)).sort()
    const mapOf = (deps: any, id: string) => JSON.parse(Buffer.from(deps.kvGet(storeMod.snapshotMapKeyFor(id))).toString())
    const bytesOf = (v: unknown) => Buffer.byteLength(JSON.stringify(v))

    test('snapshotTo/restoreFrom reproduce the exact set; one map row, no row copies', () => {
        const { store, deps, db } = memoryKv()
        // JSON.parse → own "__proto__" key (a literal would set the prototype).
        store.migrateFromDb({ pluginCustomStorage: JSON.parse('{"a":"A","__proto__":"P"}') })
        store.snapshotTo('100')

        // Layout: exactly one plugin-storage-snapshot/<id> row, no `/<enc>` copies.
        expect(deps.kvListWithSizes(SNAPSHOT_PREFIX).map((e: any) => e.key)).toEqual([store.snapshotMapKeyFor('100')])
        const map = mapOf(deps, '100')
        expect(map.v).toBe(2)
        expect(JSON.parse(map.marker)).toMatchObject({ version: 1, keys: 2 })
        expect(map.entries.sort()).toEqual([[encodeKey('__proto__'), sha('P')], [encodeKey('a'), sha('A')]].sort())
        expect(blobKeys(deps)).toEqual([sha('A'), sha('P')].sort())
        // Snapshot/blob rows never show up as live keys.
        expect(store.list().map((e: any) => e.key).sort()).toEqual(['__proto__', 'a'])

        // Mutate live: change a, add b, remove __proto__.
        store.set('a', 'A2')
        store.set('b', 'B')
        store.remove('__proto__')
        store.restoreFrom('100')
        expect(store.list().map((e: any) => e.key).sort()).toEqual(['__proto__', 'a'])
        expect(store.get('a')).toBe('A')
        expect(store.get('__proto__')).toBe('P')
        expect(store.get('b')).toBeNull()
        expect(store.isMigrated()).toBe(true)
        expect(JSON.parse(Buffer.from(deps.kvGet(MIGRATED_MARKER_KEY)).toString())).toEqual(JSON.parse(map.marker))

        // A pre-split snapshot (no map, no rows) restores to "nothing, no marker".
        store.restoreFrom('200')
        expect(store.list()).toEqual([])
        expect(store.isMigrated()).toBe(false)

        // Re-snapshotting the same id replaces rather than merges.
        store.set('z', 1)
        store.snapshotTo('100')
        expect(mapOf(deps, '100').entries).toEqual([[encodeKey('z'), sha(1)]])
        expect(mapOf(deps, '100').marker).toBeNull()

        store.dropSnapshot('100')
        expect(store.snapshotBytes('100')).toBe(0)
        expect((db.prepare(`SELECT COUNT(*) AS c FROM kv WHERE key LIKE 'plugin-storage-snapshot/%' OR key LIKE 'plugin-storage-blob/%'`).get() as any).c).toBe(0)
        // Live rows untouched by dropping a snapshot.
        expect(store.get('z')).toBe(1)
    })

    test('unchanged values are stored once across snapshots; a change adds one blob', () => {
        const { store, deps } = memoryKv()
        const big = 'x'.repeat(10_000)
        store.migrateFromDb({ pluginCustomStorage: { big, small: 's', dup: big } })
        store.snapshotTo('1')
        // Two keys with identical bytes share one blob.
        expect(blobKeys(deps)).toEqual([sha(big), sha('s')].sort())

        store.snapshotTo('2')
        expect(blobKeys(deps)).toEqual([sha(big), sha('s')].sort())

        store.set('small', 's2')
        store.snapshotTo('3')
        expect(blobKeys(deps)).toEqual([sha(big), sha('s'), sha('s2')].sort())
        // Blob rows hold the value bytes verbatim.
        expect(Buffer.from(deps.kvGet(store.blobKeyFor(sha(big)))).toString()).toBe(JSON.stringify(big))
    })

    test('size accounting: unique blobs + map row; shared blobs count for nobody', () => {
        const { store, deps } = memoryKv()
        const big = 'x'.repeat(10_000)
        store.migrateFromDb({ pluginCustomStorage: { big, small: 's' } })
        store.snapshotTo('1')
        const mapSize = (id: string) => deps.kvListWithSizes(store.snapshotMapKeyFor(id))
            .find((e: any) => e.key === store.snapshotMapKeyFor(id)).size

        // Alone: everything is unique.
        expect(store.snapshotBytes('1')).toBe(mapSize('1') + bytesOf(big) + bytesOf('s'))
        expect(store.snapshotLogicalBytes('1')).toBe(store.snapshotBytes('1'))

        store.set('small', 's2')
        store.snapshotTo('2')
        // `big` is shared → counted by neither; each owns its own `small`.
        expect(store.snapshotBytes('1')).toBe(mapSize('1') + bytesOf('s'))
        expect(store.snapshotBytes('2')).toBe(mapSize('2') + bytesOf('s2'))
        expect(store.snapshotLogicalBytes('2')).toBe(mapSize('2') + bytesOf(big) + bytesOf('s2'))

        // Dropping 1 hands `big` back to 2.
        store.dropSnapshot('1')
        expect(store.snapshotBytes('2')).toBe(mapSize('2') + bytesOf(big) + bytesOf('s2'))
        expect(store.snapshotBytes('missing')).toBe(0)
    })

    test('dropSnapshot garbage-collects only blobs unique to it', () => {
        const { store, deps } = memoryKv()
        store.migrateFromDb({ pluginCustomStorage: { shared: 'S', only1: 'one' } })
        store.snapshotTo('1')
        store.remove('only1')
        store.set('only2', 'two')
        store.snapshotTo('2')
        expect(blobKeys(deps)).toEqual([sha('S'), sha('one'), sha('two')].sort())

        store.dropSnapshot('1')
        expect(blobKeys(deps)).toEqual([sha('S'), sha('two')].sort())
        expect(deps.kvGet(store.snapshotMapKeyFor('1'))).toBeNull()

        // Snapshot 2 still restores in full after the GC.
        store.removeAll()
        store.restoreFrom('2')
        expect(store.readAll()).toEqual({ shared: 'S', only2: 'two' })

        store.dropSnapshot('2')
        expect(blobKeys(deps)).toEqual([])
    })

    test('gcBlobs drops a map row whose DB blob is gone and frees its unique blobs (R2)', () => {
        const { db, deps } = memoryKv()
        const dbBlobs = new Set(['1', '2'])
        const store = createPluginStorageStore({ ...deps, hasSnapshotBlob: (id: string) => dbBlobs.has(id) })
        store.migrateFromDb({ pluginCustomStorage: { shared: 'S', only1: 'one' } })
        store.snapshotTo('1')
        store.remove('only1')
        store.set('only2', 'two')
        store.snapshotTo('2')

        // Simulate a raw delete of snapshot 1's DB blob: the map row is orphaned.
        dbBlobs.delete('1')
        expect(deps.kvGet(store.snapshotMapKeyFor('1'))).not.toBeNull()
        store.gcBlobs()
        expect(deps.kvGet(store.snapshotMapKeyFor('1'))).toBeNull()
        expect(blobKeys(deps)).toEqual([sha('S'), sha('two')].sort())
        // Snapshot 2 still restores in full.
        store.removeAll()
        db.transaction(() => store.restoreFrom('2'))()
        expect(store.readAll()).toEqual({ shared: 'S', only2: 'two' })
    })

    test('a snapshot whose blob went missing fails restore atomically', () => {
        const { store, deps } = memoryKv()
        store.migrateFromDb({ pluginCustomStorage: { a: 'A', b: 'B' } })
        store.snapshotTo('1')
        deps.kvDel(store.blobKeyFor(sha('B')))
        store.set('live', 'L')
        const run = deps.db.transaction(() => store.restoreFrom('1'))
        expect(() => run()).toThrow(/blob .* missing/)
        // Rolled back: the live set is untouched.
        expect(store.list().map((e: any) => e.key).sort()).toEqual(['a', 'b', 'live'])
    })

    test('legacy row-copy layout still restores, sizes and drops', () => {
        const { store, deps, db } = memoryKv()
        store.migrateFromDb({ pluginCustomStorage: { a: 'A', b: 'B' } })
        // Old builds copied the rows under plugin-storage-snapshot/<id>/<enc>.
        db.prepare(`INSERT INTO kv (key, value, updated_at)
                    SELECT ? || substr(key, ?), value, updated_at FROM kv WHERE key LIKE 'plugin-storage/%'`)
            .run(store.snapshotPrefixFor('old'), PREFIX.length + 1)
        const legacyRows = deps.kvListWithSizes(store.snapshotPrefixFor('old'))
        expect(legacyRows.length).toBe(3)
        expect(store.snapshotBytes('old')).toBe(legacyRows.reduce((s: number, e: any) => s + e.size, 0))
        expect(store.snapshotLogicalBytes('old')).toBe(store.snapshotBytes('old'))

        // A new-layout snapshot next to it neither sees nor disturbs it.
        store.set('c', 'C')
        store.snapshotTo('new')
        store.set('a', 'A-live')
        store.remove('b')

        store.restoreFrom('old')
        expect(store.readAll()).toEqual({ a: 'A', b: 'B' })
        expect(store.isMigrated()).toBe(true)

        store.restoreFrom('new')
        expect(store.readAll()).toEqual({ a: 'A', b: 'B', c: 'C' })

        store.dropSnapshot('old')
        expect(deps.kvListWithSizes(store.snapshotPrefixFor('old'))).toEqual([])
        expect(store.snapshotBytes('old')).toBe(0)
        // New-layout blobs survive a legacy drop.
        expect(blobKeys(deps)).toEqual([sha('A'), sha('B'), sha('C')].sort())
    })
})

// ─── Integration: real server ───────────────────────────────────────────────

const MAGIC_RAW = Buffer.from([0, 82, 73, 83, 85, 83, 65, 86, 69, 0, 7])
const packr = new Packr({ useRecords: false })
const DB_KEY_HEX = Buffer.from('database/database.bin').toString('hex')

function seedBackupWithPluginStorage(pluginCustomStorage: Record<string, unknown>) {
    const database = {
        characters: [{
            name: 'C', chaId: 'c0', desc: '', firstMessage: 'hi', chatPage: 0, image: '', type: 'character',
            chats: [{ id: 'chat-0', name: 'Chat', message: [{ role: 'user', data: 'm' }], lastDate: 1, localLore: [], scriptstate: {}, note: '' }],
        }],
        apiType: 'openai', personas: [{ name: 'Default', icon: '', personaPrompt: '' }],
        botPresets: [], botPresetsId: 0, moduleIntergration: [], selectedCharacter: 0,
        pluginCustomStorage,
    }
    return encodeBackup([{ name: 'database.risudat', data: Buffer.concat([MAGIC_RAW, packr.encode(database)]) }])
}

const servers: ServerHandle[] = []
afterAll(async () => { await Promise.allSettled(servers.map(s => s.cleanup())) })

async function readDb(client: RisuClient) {
    const res = await client.fetch('/api/read', { headers: { 'file-path': DB_KEY_HEX } })
    expect(res.status).toBe(200)
    return utils.normalizeJSON(await utils.decodeRisuSave(Buffer.from(await res.arrayBuffer()))) as any
}

async function readIndex(client: RisuClient) {
    const res = await client.fetch('/api/plugin-storage/index')
    expect(res.status).toBe(200)
    return await res.json() as { entries: { key: string; size: number }[]; migrated: boolean }
}

describe('server: import → migrate → index → export', () => {
    const seeded = {
        'libra::manifest': JSON.stringify({ v: 1 }),
        'libra::item::chunk:v1:0': 'AAAA',
        hypaplus_state_c_chat: { nodes: [1, 2, 3] },
    }

    test('imported plugin storage is split into kv and the served DB field is empty', async () => {
        const srv = await spawnServer()
        servers.push(srv)
        const client = await createClient(srv.port, srv.password)
        expect((await readIndex(client)).migrated).toBe(false)

        const imported = await client.importBackup(seedBackupWithPluginStorage(seeded))
        expect(imported.ok).toBe(true)

        const index = await readIndex(client)
        expect(index.migrated).toBe(true)
        expect(index.entries.map(e => e.key).sort()).toEqual(Object.keys(seeded).sort())
        for (const e of index.entries) {
            expect(e.size).toBe(Buffer.byteLength(JSON.stringify((seeded as any)[e.key])))
        }

        // /api/read serves the stripped blob: field present, empty.
        const db = await readDb(client)
        expect(db.pluginCustomStorage).toEqual({})

        // Values are readable through the generic kv read path as JSON text.
        const hex = Buffer.from(`${PREFIX}${encodeKey('libra::item::chunk:v1:0')}`).toString('hex')
        const raw = await client.fetch('/api/read', { headers: { 'file-path': hex } })
        expect(JSON.parse(await raw.text())).toBe('AAAA')

        // Export reassembles the field so the .bin is upstream-compatible, and
        // never ships plugin-storage/ kv entries alongside.
        const exported = decodeBackup(await client.exportBackup())
        expect(exported.some(e => e.name.startsWith(PREFIX))).toBe(false)
        const dbEntry = exported.find(e => e.name === 'database.risudat')!
        const exportedDb = await utils.decodeRisuSave(dbEntry.data) as any
        expect(exportedDb.pluginCustomStorage).toEqual(seeded)
        expect(exportedDb.characters[0].chats[0].message.length).toBe(1)

        // Settings-only export carries no plugin storage.
        const settingsRes = await client.fetch('/api/backup/export?mode=settings')
        expect(settingsRes.status).toBe(200)
        const settingsDb = decodeBackup(Buffer.from(await settingsRes.arrayBuffer())).find(e => e.name === 'database.risudat')!
        expect(((await utils.decodeRisuSave(settingsDb.data)) as any).pluginCustomStorage).toEqual({})

        // Re-importing the export replaces kv wholesale and migrates again.
        await client.fetch('/api/write', {
            method: 'POST',
            headers: { 'file-path': Buffer.from(`${PREFIX}${encodeKey('stale')}`).toString('hex'), 'content-type': 'application/octet-stream' },
            body: Buffer.from('"old"'),
        })
        expect((await readIndex(client)).entries.map(e => e.key)).toContain('stale')
        const reimported = await client.importBackup(encodeBackup(exported))
        expect(reimported.ok).toBe(true)
        const after = await readIndex(client)
        expect(after.migrated).toBe(true)
        expect(after.entries.map(e => e.key).sort()).toEqual(Object.keys(seeded).sort())
        expect((await readDb(client)).pluginCustomStorage).toEqual({})
    })

    test('a legacy save folder is migrated on first cold load', async () => {
        const dbBin = Buffer.concat([MAGIC_RAW, packr.encode({
            characters: [], botPresets: [], botPresetsId: 0,
            pluginCustomStorage: { boot: 'value' },
        })])
        const srv = await spawnServer({
            seedSave: async (saveDir) => {
                const { writeFile } = await import('node:fs/promises')
                await writeFile(`${saveDir}/${DB_KEY_HEX}`, dbBin)
            },
        })
        servers.push(srv)
        const client = await createClient(srv.port, srv.password)
        expect((await readDb(client)).pluginCustomStorage).toEqual({})
        const index = await readIndex(client)
        expect(index.migrated).toBe(true)
        expect(index.entries).toEqual([{ key: 'boot', size: Buffer.byteLength('"value"') }])
    })
})

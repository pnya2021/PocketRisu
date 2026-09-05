import { describe, test, expect, vi, beforeEach } from 'vitest'

// C1: V2 plugins reach plugin storage through `risuai.db.pluginCustomStorage`
// and the setDatabase/setDatabaseLite bulk helpers. All of these must be
// served by pluginStorageStore; the real DB field stays `{}`.
const kv = new Map<string, Uint8Array>()

vi.mock('../globalApi.svelte', () => ({
    forageStorage: {
        async Init() {},
        async getPluginStorageIndex() {
            const entries = [...kv.entries()]
                .filter(([k]) => k.startsWith('plugin-storage/'))
                .map(([k, v]) => ({
                    key: Buffer.from(k.slice('plugin-storage/'.length), 'base64url').toString('utf-8'),
                    size: v.length,
                }))
            return { entries, migrated: true }
        },
        async getPluginStorageAll(onEntry: (key: string, text: string) => void) {
            for (const [k, v] of kv.entries()) {
                if (!k.startsWith('plugin-storage/')) continue
                onEntry(Buffer.from(k.slice('plugin-storage/'.length), 'base64url').toString('utf-8'), new TextDecoder().decode(v))
            }
        },
        async getItem(key: string) {
            return kv.get(key) ?? null
        },
        async setItem(key: string, value: Uint8Array) {
            kv.set(key, value)
        },
        async removeItem(key: string) {
            kv.delete(key)
        },
    },
}))
vi.mock('../alert', () => ({ alertError: vi.fn() }))
vi.mock('../parser/parser.svelte', () => ({ hasher: async () => '' }))

const store = await import('./pluginStorageStore')
const { PLUGIN_CUSTOM_STORAGE_KEY, applyPluginDbKey, pluginCustomStorageProxy } = await import('./pluginDbProxy')

const allowedDbKeys = ['characters', 'pluginCustomStorage']

// Mirrors the dispatch order of the safe DB proxy in plugins.svelte.ts:
// pluginCustomStorage is intercepted before the generic allowed-key path.
function makeRisuaiDb(db: any) {
    return new Proxy(db, {
        get(target, prop) {
            if (prop === PLUGIN_CUSTOM_STORAGE_KEY) return pluginCustomStorageProxy()
            if (typeof prop === 'string' && allowedDbKeys.includes(prop)) return target[prop]
            return store.getItemSync(String(prop)) ?? undefined
        },
        set(target, prop, value) {
            if (typeof prop === 'string' && applyPluginDbKey(prop, value)) return true
            if (typeof prop === 'string' && allowedDbKeys.includes(prop)) {
                target[prop] = value
                return true
            }
            store.setItemSync(String(prop), value)
            return true
        },
    })
}

function bulkSet(db: any, newDb: any) {
    for (const key of Object.keys(newDb)) {
        if (applyPluginDbKey(key, newDb[key])) continue
        if (allowedDbKeys.includes(key)) db[key] = newDb[key]
        else store.setItemSync(key, newDb[key])
    }
}

let db: any

beforeEach(async () => {
    kv.clear()
    store._resetForTests()
    db = { characters: [], pluginCustomStorage: {} }
    await store.preloadAll()
})

describe('risuai.db.pluginCustomStorage', () => {
    test('property write goes to the store, DB field stays {}', async () => {
        const risuaiDb = makeRisuaiDb(db)
        risuaiDb.pluginCustomStorage.foo = 'x'
        expect(store.getItemSync('foo')).toBe('x')
        expect(risuaiDb.pluginCustomStorage.foo).toBe('x')
        expect(db.pluginCustomStorage).toEqual({})
        await vi.waitFor(() => expect(kv.has(store.kvKeyFor('foo'))).toBe(true))
    })

    test('Object.keys / in / delete reflect the store', () => {
        store.setItemSync('a', 1)
        store.setItemSync('b', 2)
        const obj = makeRisuaiDb(db).pluginCustomStorage
        expect(Object.keys(obj).sort()).toEqual(['a', 'b'])
        expect('a' in obj).toBe(true)
        expect('zzz' in obj).toBe(false)
        expect({ ...obj }).toEqual({ a: 1, b: 2 })
        delete obj.a
        expect(store.keys()).toEqual(['b'])
        expect(obj.a).toBeUndefined()
        expect(db.pluginCustomStorage).toEqual({})
    })

    test('assigning a whole object merges into the store, keeping other keys', () => {
        store.setItemSync('old', 1)
        const risuaiDb = makeRisuaiDb(db)
        risuaiDb.pluginCustomStorage = { a: 1 }
        expect(store.keys().sort()).toEqual(['a', 'old'])
        expect(store.getItemSync('a')).toBe(1)
        expect(store.getItemSync('old')).toBe(1)
        expect(db.pluginCustomStorage).toEqual({})
    })

    test('setDatabase({pluginCustomStorage}) merges into the store, other keys hit the DB', () => {
        store.setItemSync('old', 1)
        bulkSet(db, { pluginCustomStorage: { a: 1 }, characters: ['c'], custom: 'v' })
        expect(store.keys().sort()).toEqual(['a', 'custom', 'old'])
        expect(store.getItemSync('a')).toBe(1)
        expect(db.characters).toEqual(['c'])
        expect(db.pluginCustomStorage).toEqual({})
    })

    // Regression: getDatabase() exposes pluginCustomStorage as {} (values live in
    // the store), so a plugin round-tripping getDatabase() -> setDatabase() used
    // to wipe every other plugin's data (module-manager / plugin-manager report).
    test('round-tripping an empty pluginCustomStorage does not wipe the store', () => {
        store.setItemSync('other-plugin', { keep: true })
        bulkSet(db, { pluginCustomStorage: {}, characters: [] })
        expect(store.keys()).toEqual(['other-plugin'])
        expect(store.getItemSync('other-plugin')).toEqual({ keep: true })
    })

    test('partial pluginCustomStorage write updates its key only', () => {
        store.setItemSync('other-plugin', 1)
        store.setItemSync('__mm_disabledModules__', ['x'])
        bulkSet(db, { pluginCustomStorage: { __mm_disabledModules__: [] } })
        expect(store.getItemSync('__mm_disabledModules__')).toEqual([])
        expect(store.getItemSync('other-plugin')).toBe(1)
    })
})

describe('wantsFullPluginStorage', () => {
    test('off unless the user allowed it for the plugin', async () => {
        const { wantsFullPluginStorage } = await import('./pluginDbProxy')
        expect(wantsFullPluginStorage({})).toBe(false)
        expect(wantsFullPluginStorage(undefined)).toBe(false)
        expect(wantsFullPluginStorage({ nodeOnlyFullStorageAccess: false })).toBe(false)
        expect(wantsFullPluginStorage({ nodeOnlyFullStorageAccess: true })).toBe(true)
    })
})

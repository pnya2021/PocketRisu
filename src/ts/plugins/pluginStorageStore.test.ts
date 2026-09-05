import { describe, test, expect, vi, beforeEach } from 'vitest'

// In-memory stand-in for the server kv. Mocked before the store is imported
// so the module-level forageStorage binding resolves to this object.
const kv = new Map<string, Uint8Array>()
const calls: string[] = []
const setValues: string[] = []
const mockState = {
    setItemFails: 0, holdNextSet: null as Promise<void> | null, bulkFails: false,
    holdNextGet: null as Promise<void> | null,
    holdNextIndex: null as Promise<void> | null,
    holdNextBulk: null as Promise<void> | null,
}

vi.mock('../globalApi.svelte', () => ({
    forageStorage: {
        async Init() {},
        async getPluginStorageIndex() {
            calls.push('index')
            const entries = [...kv.entries()]
                .filter(([k]) => k.startsWith('plugin-storage/'))
                .map(([k, v]) => ({
                    key: Buffer.from(k.slice('plugin-storage/'.length), 'base64url').toString('utf-8'),
                    size: v.length,
                }))
            const hold = mockState.holdNextIndex
            mockState.holdNextIndex = null
            if (hold) await hold
            return { entries, migrated: true }
        },
        async getItem(key: string) {
            calls.push('get:' + key)
            const value = kv.get(key) ?? null
            const hold = mockState.holdNextGet
            mockState.holdNextGet = null
            if (hold) await hold
            return value
        },
        async getPluginStorageAll(onEntry: (key: string, text: string) => void) {
            calls.push('all')
            if (mockState.bulkFails) { mockState.bulkFails = false; throw new Error('no bulk endpoint') }
            const entries = [...kv.entries()]
            const hold = mockState.holdNextBulk
            mockState.holdNextBulk = null
            if (hold) await hold
            for (const [k, v] of entries) {
                if (!k.startsWith('plugin-storage/')) continue
                onEntry(Buffer.from(k.slice('plugin-storage/'.length), 'base64url').toString('utf-8'), new TextDecoder().decode(v))
            }
        },
        async setItem(key: string, value: Uint8Array) {
            calls.push('set:' + key)
            setValues.push(new TextDecoder().decode(value))
            if (mockState.holdNextSet) {
                const hold = mockState.holdNextSet
                mockState.holdNextSet = null
                await hold
            }
            if (mockState.setItemFails > 0) {
                mockState.setItemFails--
                throw new Error('write failed')
            }
            kv.set(key, value)
        },
        async removeItem(key: string) {
            calls.push('remove:' + key)
            kv.delete(key)
        },
    },
}))
vi.mock('../alert', () => ({ alertError: vi.fn() }))
vi.mock('../parser/parser.svelte', () => ({ hasher: async () => '' }))

const store = await import('./pluginStorageStore')
const enc = new TextEncoder()

function seed(key: string, value: any) {
    kv.set(store.kvKeyFor(key), enc.encode(JSON.stringify(value)))
}

beforeEach(() => {
    vi.clearAllMocks()
    kv.clear()
    calls.length = 0
    setValues.length = 0
    mockState.setItemFails = 0
    mockState.holdNextSet = null
    mockState.holdNextGet = null
    mockState.holdNextIndex = null
    mockState.holdNextBulk = null
    store._resetForTests()
})

describe('server restore boundary', () => {
    test('reloads restored values, tombstoned keys and the V2 preload instead of trusting old write hashes', async () => {
        seed('profile', 'before')
        seed('removed', 'before')
        await store.preloadAll()
        await store.removeItem('removed')
        await store.drainPendingWrites()
        store.invalidateCache()
        kv.clear()
        seed('profile', 'restored')
        seed('removed', 'restored too')
        store.invalidateCache()
        expect(store.isPreloaded()).toBe(false)
        await store.preloadAll()
        expect(store.getItemSync('profile')).toBe('restored')
        expect(store.getItemSync('removed')).toBe('restored too')
        await store.setItem('profile', 'before')
        expect(JSON.parse(new TextDecoder().decode(kv.get(store.kvKeyFor('profile'))))).toBe('before')
    })

    test('drains both asynchronous and queued V2 writes before a server replacement can start', async () => {
        await store.preloadAll()
        let release!: () => void
        mockState.holdNextSet = new Promise<void>((resolve) => { release = resolve })
        const write = store.setItem('profile', 'async')
        await vi.waitFor(() => expect(setValues).toEqual(['"async"']))
        store.setItemSync('profile', 'sync')
        let drained = false
        const drain = store.drainPendingWrites().then(() => { drained = true })
        await Promise.resolve()
        expect(drained).toBe(false)
        expect(() => store.invalidateCache()).toThrow('pending writes')
        release()
        await Promise.all([write, drain])
        expect(setValues).toEqual(['"async"', '"sync"'])
        store.invalidateCache()
        seed('profile', 'restored')
        expect(await store.getItem('profile')).toBe('restored')
    })

    test('rejects an old in-flight value read instead of repopulating the restored cache', async () => {
        seed('profile', 'before')
        await store.init()
        let release!: () => void
        mockState.holdNextGet = new Promise<void>((resolve) => { release = resolve })
        const read = store.getItem('profile')
        const rejected = expect(read).rejects.toThrow('replaced')
        await vi.waitFor(() => expect(calls).toContain('get:' + store.kvKeyFor('profile')))
        store.invalidateCache()
        seed('profile', 'restored')
        release()
        await rejected
        expect(await store.getItem('profile')).toBe('restored')
    })

    test('an old index response cannot replace the new index or clear its initialization promise', async () => {
        seed('before', 1)
        let release!: () => void
        mockState.holdNextIndex = new Promise<void>((resolve) => { release = resolve })
        const oldInit = store.init()
        const rejected = expect(oldInit).rejects.toThrow('replaced')
        await vi.waitFor(() => expect(calls).toContain('index'))
        store.invalidateCache()
        kv.clear()
        seed('restored', 2)
        await store.init()
        release()
        await rejected
        await store.init()
        expect(store.keys()).toEqual(['restored'])
        expect(calls.filter((call) => call === 'index')).toHaveLength(2)
    })

    test('an old bulk preload cannot repopulate values or unset the new preload state', async () => {
        seed('profile', 'before')
        await store.init()
        let release!: () => void
        mockState.holdNextBulk = new Promise<void>((resolve) => { release = resolve })
        const oldPreload = store.preloadAll()
        const rejected = expect(oldPreload).rejects.toThrow('replaced')
        await vi.waitFor(() => expect(calls).toContain('all'))
        store.invalidateCache()
        seed('profile', 'restored')
        await store.preloadAll()
        release()
        await rejected
        expect(store.isPreloaded()).toBe(true)
        expect(store.getItemSync('profile')).toBe('restored')
    })
})

describe('key encoding', () => {
    test('matches persistentKv base64url scheme (no padding, - and _)', () => {
        // Chosen so plain base64 yields both '+'/'/' and '=' padding.
        const key = 'libra::chunk:v1:한글?>?>'
        const expected = 'plugin-storage/' + Buffer.from(key, 'utf-8').toString('base64')
            .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '')
        expect(store.kvKeyFor(key)).toBe(expected)
        expect(store.kvKeyFor(key)).toBe('plugin-storage/bGlicmE6OmNodW5rOnYxOu2VnOq4gD8-Pz4')
        expect(store.kvKeyFor(key).slice('plugin-storage/'.length)).not.toMatch(/[+/=]/)
    })
})

describe('index + getItem', () => {
    test('index fetched once; key missing from index → one cheap read, null', async () => {
        seed('a', { x: 1 })
        await store.init()
        await store.init()
        expect(calls.filter((c) => c === 'index')).toHaveLength(1)
        expect(store.keys()).toEqual(['a'])
        expect(store.length()).toBe(1)
        expect(store.key(0)).toBe('a')
        expect(store.key(5)).toBeNull()

        expect(await store.getItem('nope')).toBeNull()
        expect(calls.filter((c) => c.startsWith('get:'))).toHaveLength(1)
    })

    // C4: another device may have written the key after the index was fetched.
    test('index miss → server read; a hit adds the key to the index', async () => {
        await store.init()
        expect(store.keys()).toEqual([])
        seed('remote', { r: 1 })
        expect(await store.getItem('remote')).toEqual({ r: 1 })
        expect(store.keys()).toEqual(['remote'])
        expect(store.size('remote')).toBe(enc.encode('{"r":1}').length)
    })

    test('key removed in this session → tombstone, no request until refreshIndex', async () => {
        seed('a', 1)
        await store.init()
        await store.removeItem('a')
        calls.length = 0
        expect(await store.getItem('a')).toBeNull()
        expect(calls.filter((c) => c.startsWith('get:'))).toHaveLength(0)
        seed('a', 2)
        await store.refreshIndex()
        expect(await store.getItem('a')).toBe(2)
    })

    // C3: corrupt/empty rows must not throw into the plugin.
    test('empty or unparseable row → null and dropped from the index', async () => {
        kv.set(store.kvKeyFor('empty'), new Uint8Array(0))
        kv.set(store.kvKeyFor('bad'), enc.encode('{not json'))
        await store.init()
        expect(store.keys().sort()).toEqual(['bad', 'empty'])
        expect(await store.getItem('empty')).toBeNull()
        expect(await store.getItem('bad')).toBeNull()
        expect(store.keys()).toEqual([])
    })

    test('hit in index → one server read, then served from cache', async () => {
        seed('a', { x: 1 })
        expect(await store.getItem('a')).toEqual({ x: 1 })
        expect(await store.getItem('a')).toEqual({ x: 1 })
        expect(calls.filter((c) => c.startsWith('get:'))).toHaveLength(1)
    })
})

describe('write-through', () => {
    test('setItem writes to the server before touching cache/index', async () => {
        await store.init()
        await store.setItem('k', 'v')
        expect(calls).toEqual(['index', 'set:' + store.kvKeyFor('k')])
        expect(store.keys()).toEqual(['k'])
        expect(store.size('k')).toBe(enc.encode('"v"').length)
        expect(await store.getItem('k')).toBe('v')
        expect(calls.filter((c) => c.startsWith('get:'))).toHaveLength(0)
    })

    test('setItem failure throws and leaves cache/index untouched', async () => {
        await store.init()
        mockState.setItemFails = 1
        await expect(store.setItem('k', 'v')).rejects.toThrow('write failed')
        expect(store.keys()).toEqual([])
        expect(await store.getItem('k')).toBeNull()
    })

    // C3: the old DB-field storage dropped undefined on JSON serialization.
    test('setItem(key, undefined) removes the key instead of writing an empty row', async () => {
        seed('u', 1)
        await store.init()
        await store.setItem('u', undefined)
        expect(kv.has(store.kvKeyFor('u'))).toBe(false)
        expect(store.keys()).toEqual([])
        expect(calls.filter((c) => c.startsWith('set:'))).toHaveLength(0)
        expect(await store.getItem('u')).toBeNull()
    })

    // C2: async writes for one key are serialized too.
    test('rapid async setItem for one key lands in call order', async () => {
        await store.init()
        let release!: () => void
        mockState.holdNextSet = new Promise<void>((r) => { release = r })
        const first = store.setItem('k', 'old')
        const second = store.setItem('k', 'new')
        await new Promise((r) => setTimeout(r, 10))
        expect(setValues).toEqual(['"old"'])
        release()
        await Promise.all([first, second])
        expect(setValues).toEqual(['"old"', '"new"'])
        expect(new TextDecoder().decode(kv.get(store.kvKeyFor('k')))).toBe('"new"')
    })

    test('getItem during an in-flight async setItem returns the pending value', async () => {
        seed('k', 'old')
        await store.init()
        expect(await store.getItem('k')).toBe('old') // now cached
        let release!: () => void
        mockState.holdNextSet = new Promise<void>((r) => { release = r })
        const write = store.setItem('k', 'new')
        await vi.waitFor(() => expect(setValues).toEqual(['"new"'])) // 'new' is in flight (held)
        expect(await store.getItem('k')).toBe('new')
        const removal = store.removeItem('k')
        expect(await store.getItem('k')).toBeNull()
        release()
        await Promise.all([write, removal])
        expect(await store.getItem('k')).toBeNull()
    })

    test('removeItem + clear go through the server', async () => {
        seed('a', 1)
        seed('b', 2)
        await store.init()
        await store.removeItem('a')
        expect(kv.has(store.kvKeyFor('a'))).toBe(false)
        expect(store.keys()).toEqual(['b'])
        await store.clear()
        expect(store.length()).toBe(0)
        expect(kv.size).toBe(0)
    })
})

describe('LRU', () => {
    test('evicts oldest by JSON byte size, refreshes on hit', async () => {
        seed('a', 'aaaaaaaa') // 10 chars incl. quotes
        seed('b', 'bbbbbbbb')
        seed('c', 'cccccccc')
        await store.init()
        store.setCacheCap(25)
        await store.getItem('a')
        await store.getItem('b')
        await store.getItem('a') // a is now most recent
        await store.getItem('c') // 30 > 25 → evict b
        calls.length = 0
        await store.getItem('a')
        await store.getItem('c')
        expect(calls.filter((c) => c.startsWith('get:'))).toHaveLength(0)
        await store.getItem('b')
        expect(calls.filter((c) => c.startsWith('get:'))).toHaveLength(1)
    })

    // C5: sizes are UTF-8 bytes everywhere, not UTF-16 code units.
    test('charges cache by encoded byte length', async () => {
        seed('kr', '한한한한') // 6 UTF-16 units, 14 UTF-8 bytes
        await store.init()
        store.setCacheCap(10)
        expect(await store.getItem('kr')).toBe('한한한한')
        expect(await store.getItem('kr')).toBe('한한한한')
        expect(calls.filter((c) => c.startsWith('get:'))).toHaveLength(2)
        store.setCacheCap(14)
        await store.getItem('kr')
        await store.getItem('kr')
        expect(calls.filter((c) => c.startsWith('get:'))).toHaveLength(3)
    })

    test('a value larger than the cap is returned but not cached', async () => {
        seed('big', 'x'.repeat(100))
        await store.init()
        store.setCacheCap(10)
        expect(await store.getItem('big')).toBe('x'.repeat(100))
        expect(await store.getItem('big')).toBe('x'.repeat(100))
        expect(calls.filter((c) => c.startsWith('get:'))).toHaveLength(2)
    })
})

describe('preloadAll + sync ops (V2 mode)', () => {
    test('preload lifts the cap and enables sync reads', async () => {
        for (let i = 0; i < 20; i++) seed('k' + i, 'v'.repeat(50))
        store.setCacheCap(100)
        expect(store.getItemSync('k3')).toBeNull()
        await store.preloadAll()
        expect(store.isPreloaded()).toBe(true)
        for (let i = 0; i < 20; i++) expect(store.getItemSync('k' + i)).toBe('v'.repeat(50))
        expect(store.getItemSync('missing')).toBeNull()
        // One streamed response, not one GET per key.
        expect(calls.filter((c) => c === 'all')).toHaveLength(1)
        expect(calls.filter((c) => c.startsWith('get:'))).toHaveLength(0)
    })

    test('preload falls back to per-key reads when the bulk stream fails, and local writes win', async () => {
        for (let i = 0; i < 3; i++) seed('k' + i, i)
        mockState.bulkFails = true
        await store.init()
        store.setItemSync('k1', 'local')
        await store.preloadAll()
        expect(calls.filter((c) => c.startsWith('get:'))).toHaveLength(2)
        expect(store.getItemSync('k0')).toBe(0)
        expect(store.getItemSync('k1')).toBe('local')
        expect(store.getItemSync('k2')).toBe(2)
    })

    // v1.11.1 regression: refreshIndex re-ran preloadAll from scratch, and
    // preloadAll now starts with the bulk stream — so the background index
    // refresh (fired by keys()/length() every INDEX_STALE_MS while a V2
    // plugin runs) re-streamed the ENTIRE store over and over, saturating
    // remote links for minutes at a time.
    test('refreshIndex after preload fetches only missing keys, never the bulk stream again', async () => {
        for (let i = 0; i < 3; i++) seed('k' + i, i)
        await store.preloadAll()
        expect(calls.filter((c) => c === 'all')).toHaveLength(1)

        seed('newKey', 'from-another-device')
        calls.length = 0
        await store.refreshIndex()
        expect(store.isPreloaded()).toBe(true)
        // The bulk stream is not re-run...
        expect(calls.filter((c) => c === 'all')).toHaveLength(0)
        // ...cached keys are served without new reads, and only the key
        // written by the other device was fetched, so sync reads see it.
        expect(store.getItemSync('newKey')).toBe('from-another-device')
        expect(calls.filter((c) => c.startsWith('get:'))).toEqual(['get:' + store.kvKeyFor('newKey')])
        expect(store.getItemSync('k1')).toBe(1)
    })

    test('a corrupt row is fetched once, not on every index refresh', async () => {
        seed('good', 1)
        kv.set(store.kvKeyFor('bad'), new TextEncoder().encode('{not json'))
        await store.preloadAll()
        expect(store.getItemSync('bad')).toBeNull()

        calls.length = 0
        await store.refreshIndex()
        await store.refreshIndex()
        // The server index still lists the key; the top-up must not keep
        // re-reading a value that will never parse.
        expect(calls.filter((c) => c === 'get:' + store.kvKeyFor('bad'))).toHaveLength(0)
        expect(store.getItemSync('good')).toBe(1)

        // A rewrite makes the key readable again.
        store.setItemSync('bad', { fixed: true })
        expect(store.getItemSync('bad')).toEqual({ fixed: true })
    })

    test('setItemSync updates cache/index at once and writes in the background', async () => {
        await store.preloadAll()
        store.setItemSync('s', { n: 1 })
        expect(store.getItemSync('s')).toEqual({ n: 1 })
        expect(store.keys()).toEqual(['s'])
        await vi.waitFor(() => expect(kv.has(store.kvKeyFor('s'))).toBe(true))

        store.removeItemSync('s')
        expect(store.getItemSync('s')).toBeNull()
        expect(store.length()).toBe(0)
        await vi.waitFor(() => expect(kv.has(store.kvKeyFor('s'))).toBe(false))
    })

    // v1.11.0 report: a V2 setDatabase() round trip re-sent every key of the
    // store (hundreds of MB for long-term-memory plugins) on each save.
    test('rewriting an unchanged value is not uploaded again', async () => {
        seed('fromServer', { n: 1 })
        await store.preloadAll()
        const sets = () => calls.filter((c) => c.startsWith('set:')).length
        const before = sets()

        store.setItemSync('fromServer', { n: 1 })
        store.setItemSync('s', { n: 2 })
        await vi.waitFor(() => expect(kv.has(store.kvKeyFor('s'))).toBe(true))
        expect(sets()).toBe(before + 1)

        store.setItemSync('s', { n: 2 })
        await store.setItem('s', { n: 2 })
        expect(sets()).toBe(before + 1)

        store.setItemSync('s', { n: 3 })
        await vi.waitFor(() => expect(sets()).toBe(before + 2))
        expect(store.getItemSync('s')).toEqual({ n: 3 })

        // A removed key must be written again even with its old content.
        store.removeItemSync('s')
        await vi.waitFor(() => expect(kv.has(store.kvKeyFor('s'))).toBe(false))
        store.setItemSync('s', { n: 3 })
        await vi.waitFor(() => expect(kv.has(store.kvKeyFor('s'))).toBe(true))
    })

    test('unchanged-write detection survives value-cache eviction (full snapshot written back)', async () => {
        // A V3 plugin gets snapshotAll() and hands it straight back; values
        // over the cap never sit in the LRU, but their hashes are known.
        await store.init()
        store.setCacheCap(100)
        const big = 'v'.repeat(500)
        await store.setItem('big', big)
        expect(store.isPreloaded()).toBe(false)
        const sets = () => calls.filter((c) => c.startsWith('set:')).length
        const before = sets()
        const snapshot = await store.snapshotAll()
        expect(snapshot.big).toBe(big)
        for (const [k, v] of Object.entries(snapshot)) store.setItemSync(k, v)
        await new Promise((r) => setTimeout(r, 20))
        expect(sets()).toBe(before)
    })

    // C2: a slow first write must not overwrite a later one.
    test('setItemSync: slow first write, fast second → server ends with the newest', async () => {
        await store.preloadAll()
        let release!: () => void
        mockState.holdNextSet = new Promise<void>((r) => { release = r })
        store.setItemSync('k', 'old')
        await new Promise((r) => setTimeout(r, 10)) // 'old' is now in flight (held)
        expect(setValues).toEqual(['"old"'])
        store.setItemSync('k', 'mid')
        store.setItemSync('k', 'new')
        await new Promise((r) => setTimeout(r, 10))
        expect(setValues).toEqual(['"old"'])
        release()
        await vi.waitFor(() => expect(new TextDecoder().decode(kv.get(store.kvKeyFor('k')))).toBe('"new"'))
        // 'mid' was superseded before it was ever sent.
        expect(setValues).toEqual(['"old"', '"new"'])
    })

    test('setItemSync retry sends the newest pending value, never a superseded one', async () => {
        vi.useFakeTimers()
        try {
            await store.preloadAll()
            mockState.setItemFails = 1
            store.setItemSync('k', 'old')
            await vi.advanceTimersByTimeAsync(0) // 'old' attempted and failed, now backing off
            expect(setValues).toEqual(['"old"'])
            store.setItemSync('k', 'new')
            await vi.advanceTimersByTimeAsync(5000)
            expect(setValues).toEqual(['"old"', '"new"'])
            expect(new TextDecoder().decode(kv.get(store.kvKeyFor('k')))).toBe('"new"')
        } finally {
            vi.useRealTimers()
        }
    })

    test('setItemSync then removeItemSync is ordered: key ends absent', async () => {
        await store.preloadAll()
        let release!: () => void
        mockState.holdNextSet = new Promise<void>((r) => { release = r })
        store.setItemSync('k', 'v')
        store.removeItemSync('k')
        release()
        await vi.waitFor(() => expect(calls.filter((c) => c.startsWith('remove:'))).toHaveLength(1))
        expect(kv.has(store.kvKeyFor('k'))).toBe(false)
        expect(store.keys()).toEqual([])
    })

    test('setItemSync(key, undefined) removes the key', async () => {
        seed('u', 1)
        await store.preloadAll()
        store.setItemSync('u', undefined)
        expect(store.getItemSync('u')).toBeNull()
        expect(store.keys()).toEqual([])
        await vi.waitFor(() => expect(kv.has(store.kvKeyFor('u'))).toBe(false))
    })

    test('setItemSync retries a failed server write', async () => {
        vi.useFakeTimers()
        try {
            await store.preloadAll()
            mockState.setItemFails = 2
            store.setItemSync('r', 1)
            await vi.advanceTimersByTimeAsync(5000)
            expect(kv.has(store.kvKeyFor('r'))).toBe(true)
            expect(calls.filter((c) => c.startsWith('set:'))).toHaveLength(3)
        } finally {
            vi.useRealTimers()
        }
    })

    // C2b: sync and async writes to one key share a single ordering queue.
    test('sync (in flight) → async → sync: server ends with the last sync value, async resolves', async () => {
        await store.preloadAll()
        let release!: () => void
        mockState.holdNextSet = new Promise<void>((r) => { release = r })
        store.setItemSync('k', 'sync-old')
        await new Promise((r) => setTimeout(r, 10)) // 'sync-old' held in flight
        const asyncWrite = store.setItem('k', 'async-middle')
        await new Promise((r) => setTimeout(r, 10)) // async intent queued
        store.setItemSync('k', 'sync-new')
        release()
        await asyncWrite
        await vi.waitFor(() => expect(new TextDecoder().decode(kv.get(store.kvKeyFor('k')))).toBe('"sync-new"'))
        expect(setValues).toEqual(['"sync-old"', '"sync-new"'])
        // The superseded async write must not clobber the cache/index.
        expect(store.getItemSync('k')).toBe('sync-new')
        expect(store.size('k')).toBe(enc.encode('"sync-new"').length)
    })

    test('async (in flight) → sync → async: lands in call order', async () => {
        await store.preloadAll()
        let release!: () => void
        mockState.holdNextSet = new Promise<void>((r) => { release = r })
        const first = store.setItem('k', 'a1')
        await new Promise((r) => setTimeout(r, 10))
        store.setItemSync('k', 's')
        const second = store.setItem('k', 'a2')
        await new Promise((r) => setTimeout(r, 10))
        expect(setValues).toEqual(['"a1"'])
        release()
        await Promise.all([first, second])
        expect(setValues).toEqual(['"a1"', '"a2"'])
        expect(new TextDecoder().decode(kv.get(store.kvKeyFor('k')))).toBe('"a2"')
        expect(store.getItemSync('k')).toBe('a2')
    })

    test('set/remove/set across both paths: key ends with the final value', async () => {
        await store.preloadAll()
        let release!: () => void
        mockState.holdNextSet = new Promise<void>((r) => { release = r })
        store.setItemSync('k', 'v1')
        await new Promise((r) => setTimeout(r, 10))
        const removal = store.removeItem('k')
        await new Promise((r) => setTimeout(r, 10))
        store.setItemSync('k', 'v2')
        release()
        await removal
        await vi.waitFor(() => expect(new TextDecoder().decode(kv.get(store.kvKeyFor('k')))).toBe('"v2"'))
        // The remove was collapsed into the newer set and never sent.
        expect(calls.filter((c) => c.startsWith('remove:'))).toHaveLength(0)
        expect(store.keys()).toEqual(['k'])
        expect(store.getItemSync('k')).toBe('v2')
    })

    test('retry: a newer async intent arriving mid-backoff → only the newest is sent, both resolve', async () => {
        vi.useFakeTimers()
        try {
            await store.preloadAll()
            mockState.setItemFails = 1
            store.setItemSync('k', 'old')
            await vi.advanceTimersByTimeAsync(0) // failed, backing off
            expect(setValues).toEqual(['"old"'])
            const newer = store.setItem('k', 'new')
            await vi.advanceTimersByTimeAsync(5000)
            await newer
            expect(setValues).toEqual(['"old"', '"new"'])
            expect(new TextDecoder().decode(kv.get(store.kvKeyFor('k')))).toBe('"new"')
        } finally {
            vi.useRealTimers()
        }
    })

    test('collapsed async promises resolve once the surviving write succeeds', async () => {
        await store.preloadAll()
        let release!: () => void
        mockState.holdNextSet = new Promise<void>((r) => { release = r })
        store.setItemSync('k', 'hold')
        await new Promise((r) => setTimeout(r, 10))
        const p1 = store.setItem('k', 'p1')
        const p2 = store.setItem('k', 'p2')
        const p3 = store.setItem('k', 'p3')
        await new Promise((r) => setTimeout(r, 10))
        release()
        await expect(Promise.all([p1, p2, p3])).resolves.toBeDefined()
        expect(setValues).toEqual(['"hold"', '"p3"'])
        expect(store.getItemSync('k')).toBe('p3')
    })

    test('collapsed promises reject when the surviving (sync) write finally fails', async () => {
        const { alertError } = await import('../alert')
        vi.useFakeTimers()
        try {
            await store.preloadAll()
            let release!: () => void
            mockState.holdNextSet = new Promise<void>((r) => { release = r })
            const p1 = store.setItem('k', 'p1')
            await vi.advanceTimersByTimeAsync(0) // p1 held in flight
            const p2 = store.setItem('k', 'p2')
            await vi.advanceTimersByTimeAsync(0)
            store.setItemSync('k', 's') // collapses with p2; sync → retried
            mockState.setItemFails = 4
            release()
            const results = Promise.allSettled([p1, p2])
            await vi.advanceTimersByTimeAsync(5000)
            // p1 (async only) fails fast; the [p2, s] batch retries 3 times then rejects.
            expect((await results).map((r) => r.status)).toEqual(['rejected', 'rejected'])
            expect(setValues).toEqual(['"p1"', '"s"', '"s"', '"s"'])
            expect(alertError).toHaveBeenCalledTimes(1)
        } finally {
            vi.useRealTimers()
        }
    })

    test('setItemSync alerts after the final failed attempt', async () => {
        const { alertError } = await import('../alert')
        vi.useFakeTimers()
        try {
            await store.preloadAll()
            mockState.setItemFails = 3
            store.setItemSync('r', 1)
            await vi.advanceTimersByTimeAsync(5000)
            expect(kv.has(store.kvKeyFor('r'))).toBe(false)
            expect(alertError).toHaveBeenCalledTimes(1)
        } finally {
            vi.useRealTimers()
        }
    })
})

describe('snapshotAll', () => {
    test('returns every key as a plain object without flipping preloaded', async () => {
        kv.set('plugin-storage/' + Buffer.from('a').toString('base64url'), new TextEncoder().encode('1'))
        kv.set('plugin-storage/' + Buffer.from('b').toString('base64url'), new TextEncoder().encode('{"x":true}'))
        const snap = await store.snapshotAll()
        expect(snap).toEqual({ a: 1, b: { x: true } })
        expect(store.isPreloaded()).toBe(false)
        // the copy is detached from the store
        snap.a = 99
        expect(await store.getItem('a')).toBe(1)
    })

    test('reads the store from one streamed response; local state wins over the stream', async () => {
        for (let i = 0; i < 3; i++) seed('k' + i, i)
        await store.init()
        store.setItemSync('k1', 'local')
        calls.length = 0
        const snap = await store.snapshotAll()
        expect(snap).toEqual({ k0: 0, k1: 'local', k2: 2 })
        expect(calls.filter((c) => c === 'all')).toHaveLength(1)
        expect(calls.filter((c) => c.startsWith('get:'))).toHaveLength(0)
    })

    test('includes the value of an in-flight async setItem, not the server copy', async () => {
        for (let i = 0; i < 3; i++) seed('k' + i, i)
        await store.init()
        let release!: () => void
        mockState.holdNextSet = new Promise<void>((r) => { release = r })
        const write = store.setItem('k1', 'new')
        await vi.waitFor(() => expect(setValues).toEqual(['"new"'])) // 'new' is in flight (held)
        const snap = await store.snapshotAll()
        expect(snap).toEqual({ k0: 0, k1: 'new', k2: 2 })
        release()
        await write
    })

    test('falls back to per-key reads when the bulk stream fails', async () => {
        for (let i = 0; i < 3; i++) seed('k' + i, i)
        mockState.bulkFails = true
        calls.length = 0
        const snap = await store.snapshotAll()
        expect(snap).toEqual({ k0: 0, k1: 1, k2: 2 })
        expect(calls.filter((c) => c.startsWith('get:'))).toHaveLength(3)
    })

    test('keeps a "__proto__" key as an own property', async () => {
        kv.set('plugin-storage/' + Buffer.from('__proto__').toString('base64url'), new TextEncoder().encode('{"p":1}'))
        const snap = await store.snapshotAll()
        expect(Object.prototype.hasOwnProperty.call(snap, '__proto__')).toBe(true)
        expect(Object.getPrototypeOf(snap)).toBe(Object.prototype)
        expect(JSON.parse(JSON.stringify(snap))['__proto__']).toEqual({ p: 1 })
    })
})

import { beforeEach, describe, expect, it, vi } from 'vitest'
import { PluginDataLifecycleRegistry } from '../../pluginDataLifecycle'
import { CursorRegistry } from './cursorRegistry'

const rawHost = vi.hoisted(() => {
    const values = new Map<string, Uint8Array>()
    return {
        values,
        Init: vi.fn(async () => undefined),
        getItem: vi.fn(async (key: string) => {
            const value = values.get(key)
            return !value || value.byteLength === 0 ? null : value
        }),
        setItem: vi.fn(async (key: string, value: Uint8Array) => { values.set(key, value) }),
        removeItem: vi.fn(async (key: string) => { values.delete(key) }),
        keys: vi.fn(async (prefix = '') => [...values.keys()].filter((key) => key.startsWith(prefix))),
    }
})

vi.mock('../../../globalApi.svelte', () => ({ forageStorage: rawHost }))
vi.mock('../../../parser/parser.svelte', () => ({ hasher: vi.fn(async () => 'unused') }))

import {
    readPersistentBytes,
    removePersistentKey,
    writePersistentBytes,
} from '../../../storage/persistentKv'
import {
    DEVICE_CACHE_STORAGE_PREFIX,
    DeviceCacheService,
    PocketDeviceCacheStore,
    registerDeviceCacheLifecycle,
    type DeviceCacheStore,
    type PluginDeviceCacheLimits,
    type PocketDeviceCacheRawStorage,
    type StoredDeviceCacheRecord,
} from './deviceCache'

const PRINCIPAL_A = '11111111-1111-4111-8111-111111111111'
const PRINCIPAL_B = '22222222-2222-4222-8222-222222222222'

const cloneRecord = (record: StoredDeviceCacheRecord): StoredDeviceCacheRecord => ({
    descriptor: { ...record.descriptor },
    value: record.value.kind === 'bytes'
        ? {
            kind: 'bytes', data: record.value.data.slice(),
            ...(record.value.mediaType === undefined ? {} : { mediaType: record.value.mediaType }),
        }
        : { kind: 'json', value: structuredClone(record.value.value) },
})

class MemoryBucketStore implements DeviceCacheStore {
    readonly buckets = new Map<string, StoredDeviceCacheRecord[]>()
    failNextReplace = false
    replaceCount = 0

    async readPrincipal(principalId: string) {
        return (this.buckets.get(principalId) ?? []).map(cloneRecord)
    }

    async replacePrincipal(principalId: string, records: StoredDeviceCacheRecord[]) {
        if (this.failNextReplace) {
            this.failNextReplace = false
            throw new Error('simulated persistence failure')
        }
        this.replaceCount++
        this.buckets.set(principalId, records.map(cloneRecord))
    }

    async clearPrincipal(principalId: string) {
        this.buckets.delete(principalId)
    }
}

class MemoryRawStorage implements PocketDeviceCacheRawStorage {
    readonly values = new Map<string, Uint8Array>()
    readonly writes: string[] = []
    failNextWrite = false

    async readPersistentBytes(key: string) {
        const value = this.values.get(key)
        return value === undefined ? null : value.slice()
    }

    async writePersistentBytes(key: string, value: Uint8Array) {
        if (this.failNextWrite) {
            this.failNextWrite = false
            throw new Error('simulated raw write failure')
        }
        this.writes.push(key)
        this.values.set(key, value.slice())
    }

    async removePersistentKey(key: string) {
        this.values.delete(key)
    }
}

const context = (
    principalId = PRINCIPAL_A,
    instanceId = `instance-${principalId}`,
    controller = new AbortController(),
) => ({ principalId, instanceId, displayName: 'Pocket cache test', signal: controller.signal })

function harness(options: {
    principalId?: string
    instanceId?: string
    controller?: AbortController
    store?: DeviceCacheStore
    cursors?: CursorRegistry
    now?: { value: number }
    limits?: Partial<PluginDeviceCacheLimits>
} = {}) {
    const store = options.store ?? new MemoryBucketStore()
    const cursors = options.cursors ?? new CursorRegistry()
    const now = options.now ?? { value: 1_000 }
    let revision = 0
    const service = new DeviceCacheService(
        context(options.principalId, options.instanceId, options.controller),
        {
            store,
            cursorRegistry: cursors,
            now: () => now.value,
            createRevision: () => `revision-${++revision}`,
            limits: options.limits,
        },
    )
    return { service, store, cursors, now }
}

const codeOf = async (promise: Promise<unknown>) => {
    try {
        await promise
        return undefined
    } catch (error) {
        return (error as { code?: string }).code
    }
}

describe('Pocket persistent raw bytes', () => {
    beforeEach(() => {
        rawHost.values.clear()
        rawHost.getItem.mockClear()
        rawHost.setItem.mockClear()
        rawHost.removeItem.mockClear()
        rawHost.keys.mockClear()
    })

    it('initializes storage, clones reads/writes, and distinguishes missing from zero-length bytes', async () => {
        const input = new Uint8Array([1, 2, 3])
        await writePersistentBytes('cache/raw/nonempty', input)
        input[0] = 9
        expect([...rawHost.values.get('cache/raw/nonempty')!]).toEqual([1, 2, 3])
        const first = await readPersistentBytes('cache/raw/nonempty')
        ;(first as Uint8Array)[1] = 9
        expect([...(await readPersistentBytes('cache/raw/nonempty') as Uint8Array)]).toEqual([1, 2, 3])

        await writePersistentBytes('cache/raw/empty', new Uint8Array())
        expect(await readPersistentBytes('cache/raw/empty')).toEqual(new Uint8Array())
        expect(await readPersistentBytes('cache/raw/missing')).toBeNull()
        expect(rawHost.keys).toHaveBeenCalledWith('cache/raw/empty')
        expect(rawHost.Init).toHaveBeenCalled()
        await removePersistentKey('cache/raw/empty')
        expect(rawHost.values.has('cache/raw/empty')).toBe(false)
    })
})

describe('Pocket V3 principal-isolated device cache', () => {
    it('stores one msgpack principal bucket under the backup-excluded cache prefix and rolls failed replacement back', async () => {
        const raw = new MemoryRawStorage()
        const store = new PocketDeviceCacheStore(raw)
        const first = harness({ store }).service
        const callerKey = '../../database/database.bin'
        await first.putDeviceCacheEntry({
            key: callerKey,
            value: { kind: 'bytes', data: new Uint8Array([1, 2, 3]), mediaType: 'image/png' },
        })
        expect(raw.writes).toHaveLength(1)
        expect(raw.writes[0].startsWith(DEVICE_CACHE_STORAGE_PREFIX)).toBe(true)
        expect(raw.writes[0]).not.toContain(callerKey)
        expect(raw.values.get(raw.writes[0])?.byteLength).toBeGreaterThan(3)

        const recreated = harness({ store: new PocketDeviceCacheStore(raw) }).service
        expect(await recreated.getDeviceCacheEntry(callerKey)).toMatchObject({
            kind: 'bytes', data: new Uint8Array([1, 2, 3]), mediaType: 'image/png',
        })
        const before = raw.values.get(raw.writes[0])!.slice()
        raw.failNextWrite = true
        expect(await codeOf(recreated.putDeviceCacheEntry({ key: callerKey, value: { kind: 'json', value: 'changed' } }))).toBe('INTERNAL')
        expect(raw.values.get(raw.writes[0])).toEqual(before)
        expect(await harness({ store: new PocketDeviceCacheStore(raw) }).service.getDeviceCacheEntry(callerKey)).toMatchObject({
            kind: 'bytes', data: new Uint8Array([1, 2, 3]),
        })
    })

    it('round-trips canonical JSON and bytes by value with exact accounting, media type, and no detachment', async () => {
        const { service } = harness()
        const json = { z: '가', nested: { value: 1 } }
        const jsonPut = await service.putDeviceCacheEntry({ key: 'json', value: { kind: 'json', value: json } })
        expect(jsonPut.entry.byteLength).toBe(new TextEncoder().encode('{"nested":{"value":1},"z":"가"}').byteLength)
        json.nested.value = 9
        const firstJson = await service.getDeviceCacheEntry('json')
        expect(firstJson).toMatchObject({ value: { nested: { value: 1 }, z: '가' } })
        ;(firstJson as unknown as { value: { nested: { value: number } } }).value.nested.value = 8
        expect(await service.getDeviceCacheEntry('json')).toMatchObject({ value: { nested: { value: 1 } } })

        const bytes = new Uint8Array([1, 2, 3])
        const buffer = bytes.buffer
        const put = await service.putDeviceCacheEntry({ key: 'bytes', value: { kind: 'bytes', data: bytes, mediaType: 'image/webp' } })
        expect(put.entry).toMatchObject({ kind: 'bytes', byteLength: 3, mediaType: 'image/webp' })
        expect(bytes.buffer).toBe(buffer)
        bytes[0] = 9
        const read = await service.getDeviceCacheEntry('bytes') as { data: Uint8Array }
        expect([...read.data]).toEqual([1, 2, 3])
        read.data[1] = 9
        expect([...(await service.getDeviceCacheEntry('bytes') as { data: Uint8Array }).data]).toEqual([1, 2, 3])
    })

    it('rejects Blob, ArrayBuffer, lookalikes, empty/oversized keys, and sparse entry one-over before mutation', async () => {
        const { service, store } = harness({ limits: { maxEntryBytes: 4 } })
        await expect(service.putDeviceCacheEntry({ key: 'k'.repeat(256), value: { kind: 'bytes', data: new Uint8Array(4) } })).resolves.toBeDefined()
        const writes = (store as MemoryBucketStore).replaceCount
        for (const data of [new Blob(), new ArrayBuffer(1), { byteLength: 1 }]) {
            expect(await codeOf(service.putDeviceCacheEntry({ key: 'bad', value: { kind: 'bytes', data } as never }))).toBe('INVALID_ARGUMENT')
        }
        expect(await codeOf(service.putDeviceCacheEntry({ key: '', value: { kind: 'json', value: null } }))).toBe('INVALID_ARGUMENT')
        expect(await codeOf(service.putDeviceCacheEntry({ key: 'k'.repeat(257), value: { kind: 'json', value: null } }))).toBe('RESOURCE_LIMIT')
        expect(await codeOf(service.putDeviceCacheEntry({ key: 'over', value: { kind: 'bytes', data: new Uint8Array(5) } }))).toBe('RESOURCE_LIMIT')
        expect((store as MemoryBucketStore).replaceCount).toBe(writes)
    })

    it('isolates principals for get/list/delete/clear when caller keys are identical', async () => {
        const store = new MemoryBucketStore()
        const a = harness({ store, principalId: PRINCIPAL_A }).service
        const b = harness({ store, principalId: PRINCIPAL_B }).service
        await a.putDeviceCacheEntry({ key: 'same', value: { kind: 'json', value: 'a' } })
        await b.putDeviceCacheEntry({ key: 'same', value: { kind: 'json', value: 'b' } })
        await a.putDeviceCacheEntry({ key: 'prefix/a', value: { kind: 'json', value: 1 } })
        await b.putDeviceCacheEntry({ key: 'prefix/b', value: { kind: 'json', value: 2 } })
        expect(await a.getDeviceCacheEntry('same')).toMatchObject({ value: 'a' })
        expect(await b.getDeviceCacheEntry('same')).toMatchObject({ value: 'b' })
        expect((await a.listDeviceCacheEntries()).items.map((entry) => entry.key)).toEqual(['prefix/a', 'same'])
        expect(await a.deleteDeviceCacheEntry('same')).toBe(true)
        expect(await b.getDeviceCacheEntry('same')).toMatchObject({ value: 'b' })
        expect(await a.clearDeviceCache({ prefix: 'prefix/' })).toBe(1)
        expect((await b.listDeviceCacheEntries()).items.map((entry) => entry.key)).toEqual(['prefix/b', 'same'])
    })

    it('applies create-only/CAS/upsert atomically with one concurrent winner and persistence rollback', async () => {
        const { service, store } = harness()
        const created = await service.putDeviceCacheEntry({ key: 'cas', value: { kind: 'json', value: 1 }, expectedRevision: null })
        expect(await codeOf(service.putDeviceCacheEntry({ key: 'cas', value: { kind: 'json', value: 2 }, expectedRevision: null }))).toBe('CONFLICT')
        expect(await codeOf(service.putDeviceCacheEntry({ key: 'cas', value: { kind: 'json', value: 2 }, expectedRevision: 'wrong' }))).toBe('CONFLICT')
        const results = await Promise.allSettled([
            service.putDeviceCacheEntry({ key: 'cas', value: { kind: 'json', value: 2 }, expectedRevision: created.entry.revision }),
            service.putDeviceCacheEntry({ key: 'cas', value: { kind: 'json', value: 3 }, expectedRevision: created.entry.revision }),
        ])
        expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1)
        expect(results.filter((result) => result.status === 'rejected').map((result) => (result as PromiseRejectedResult).reason.code)).toEqual(['CONFLICT'])
        const before = await service.getDeviceCacheEntry('cas')
        ;(store as MemoryBucketStore).failNextReplace = true
        expect(await codeOf(service.putDeviceCacheEntry({ key: 'cas', value: { kind: 'json', value: 4 } }))).toBe('INTERNAL')
        expect(await service.getDeviceCacheEntry('cas')).toMatchObject({
            revision: (before as { revision: string }).revision,
            value: (before as { value: unknown }).value,
        })
        await expect(service.putDeviceCacheEntry({ key: 'cas', value: { kind: 'json', value: 5 } })).resolves.toBeDefined()
    })

    it('uses sparse exact/one-over byte and count limits, expired-first deterministic LRU, overwrite accounting, and incoming protection', async () => {
        const store = new MemoryBucketStore()
        const now = { value: 100 }
        const { service } = harness({ store, now, limits: { maxBytesPerPrincipal: 6, maxEntriesPerPrincipal: 3, maxEntryBytes: 6 } })
        await service.putDeviceCacheEntry({ key: 'expired', value: { kind: 'bytes', data: new Uint8Array(1) }, ttlMs: 1 })
        await service.putDeviceCacheEntry({ key: 'b', value: { kind: 'bytes', data: new Uint8Array(3) } })
        now.value = 101
        const afterExpiry = await service.putDeviceCacheEntry({ key: 'a', value: { kind: 'bytes', data: new Uint8Array(3) } })
        expect(afterExpiry.evictedKeys).toEqual([])
        expect((await service.listDeviceCacheEntries()).items.map((entry) => entry.key)).toEqual(['a', 'b'])
        const exact = await service.putDeviceCacheEntry({ key: 'b', value: { kind: 'bytes', data: new Uint8Array(3) } })
        expect(exact.evictedKeys).toEqual([])
        const over = await service.putDeviceCacheEntry({ key: 'incoming', value: { kind: 'bytes', data: new Uint8Array(1) } })
        expect(over.evictedKeys).toEqual(['a'])
        expect((await service.listDeviceCacheEntries()).items.map((entry) => entry.key)).toEqual(['b', 'incoming'])

        const countStore = new MemoryBucketStore()
        const count = harness({ store: countStore, limits: { maxEntriesPerPrincipal: 3 } }).service
        for (const key of ['a', 'b', 'c']) await count.putDeviceCacheEntry({ key, value: { kind: 'bytes', data: new Uint8Array() } })
        expect((await count.listDeviceCacheEntries()).items).toHaveLength(3)
        expect((await count.putDeviceCacheEntry({ key: 'd', value: { kind: 'bytes', data: new Uint8Array() } })).evictedKeys).toEqual(['a'])
    })

    it('validates TTL boundaries and persists expiry removal plus read-touch across recreation', async () => {
        const store = new MemoryBucketStore()
        const now = { value: 1_000 }
        const service = harness({ store, now }).service
        expect((await service.putDeviceCacheEntry({ key: 'permanent', value: { kind: 'json', value: true } })).entry.expiresAt).toBeUndefined()
        expect((await service.putDeviceCacheEntry({ key: 'short', value: { kind: 'json', value: true }, ttlMs: 1 })).entry.expiresAt).toBe(1_001)
        await expect(service.putDeviceCacheEntry({ key: 'max', value: { kind: 'bytes', data: new Uint8Array() }, ttlMs: 2_592_000_000 })).resolves.toBeDefined()
        expect(await codeOf(service.putDeviceCacheEntry({ key: 'over', value: { kind: 'json', value: null }, ttlMs: 2_592_000_001 }))).toBe('RESOURCE_LIMIT')
        for (const ttlMs of [0, -1, 1.5]) {
            expect(await codeOf(service.putDeviceCacheEntry({ key: `bad-${ttlMs}`, value: { kind: 'json', value: null }, ttlMs }))).toBe('INVALID_ARGUMENT')
        }
        now.value = 1_001
        expect(await service.getDeviceCacheEntry('short')).toBeNull()
        now.value = 2_000
        const recreated = harness({ store, now }).service
        expect(await recreated.getDeviceCacheEntry('permanent')).toMatchObject({ lastAccessedAt: 2_000 })
        expect((await harness({ store, now }).service.listDeviceCacheEntries()).items.find((entry) => entry.key === 'permanent')).toMatchObject({ lastAccessedAt: 2_000 })
    })

    it('pages sorted prefixes at 50/100 limits and binds cursors to principal, instance, query, tamper state, and unload', async () => {
        const store = new MemoryBucketStore()
        const cursors = new CursorRegistry()
        const controller = new AbortController()
        const service = harness({ store, cursors, controller, instanceId: 'a' }).service
        for (let index = 104; index >= 0; index--) {
            await service.putDeviceCacheEntry({ key: `item/${String(index).padStart(3, '0')}`, value: { kind: 'json', value: index } })
        }
        const first = await service.listDeviceCacheEntries({ prefix: 'item/' })
        expect(first.items).toHaveLength(50)
        expect(first.items[0].key).toBe('item/000')
        expect(first.items[49].key).toBe('item/049')
        expect((await service.listDeviceCacheEntries({ prefix: 'item/', cursor: first.nextCursor })).items[0].key).toBe('item/050')
        expect((await service.listDeviceCacheEntries({ prefix: 'item/', limit: 100 })).items).toHaveLength(100)
        expect(await codeOf(service.listDeviceCacheEntries({ limit: 101 }))).toBe('RESOURCE_LIMIT')

        const query = await service.listDeviceCacheEntries({ prefix: 'item/', limit: 1 })
        expect(await codeOf(service.listDeviceCacheEntries({ prefix: 'other/', limit: 1, cursor: query.nextCursor }))).toBe('INVALID_ARGUMENT')
        const owner = await service.listDeviceCacheEntries({ prefix: 'item/', limit: 1 })
        const foreign = harness({ store, cursors, principalId: PRINCIPAL_B, instanceId: 'b' }).service
        expect(await codeOf(foreign.listDeviceCacheEntries({ prefix: 'item/', limit: 1, cursor: owner.nextCursor }))).toBe('INVALID_ARGUMENT')
        const instance = await service.listDeviceCacheEntries({ prefix: 'item/', limit: 1 })
        expect(await codeOf(harness({ store, cursors, instanceId: 'other' }).service.listDeviceCacheEntries({ prefix: 'item/', limit: 1, cursor: instance.nextCursor }))).toBe('INVALID_ARGUMENT')
        const tamper = await service.listDeviceCacheEntries({ prefix: 'item/', limit: 1 })
        expect(await codeOf(service.listDeviceCacheEntries({ prefix: 'item/', limit: 1, cursor: `${tamper.nextCursor}x` }))).toBe('INVALID_ARGUMENT')
        const unload = await service.listDeviceCacheEntries({ prefix: 'item/', limit: 1 })
        controller.abort()
        expect(await codeOf(harness({ store, cursors, instanceId: 'a' }).service.listDeviceCacheEntries({ prefix: 'item/', limit: 1, cursor: unload.nextCursor }))).toBe('INVALID_ARGUMENT')
    })

    it('deletes by expected revision and clears exact prefix counts after expiry', async () => {
        const now = { value: 100 }
        const { service } = harness({ now })
        const target = await service.putDeviceCacheEntry({ key: 'group/a', value: { kind: 'json', value: 1 } })
        await service.putDeviceCacheEntry({ key: 'group/b', value: { kind: 'json', value: 2 } })
        await service.putDeviceCacheEntry({ key: 'group/expired', value: { kind: 'json', value: 3 }, ttlMs: 1 })
        await service.putDeviceCacheEntry({ key: 'other', value: { kind: 'json', value: 4 } })
        expect(await codeOf(service.deleteDeviceCacheEntry('group/a', { expectedRevision: 'wrong' }))).toBe('CONFLICT')
        expect(await service.deleteDeviceCacheEntry('group/a', { expectedRevision: target.entry.revision })).toBe(true)
        expect(await service.deleteDeviceCacheEntry('group/a')).toBe(false)
        now.value = 101
        expect(await service.clearDeviceCache({ prefix: 'group/' })).toBe(1)
        expect((await service.listDeviceCacheEntries()).items.map((entry) => entry.key)).toEqual(['other'])
        expect(await service.clearDeviceCache()).toBe(1)
    })

    it.each(['purge', 'quarantine', 'delete'] as const)('cleans only the lifecycle principal and its cursors on %s', async (action) => {
        const store = new MemoryBucketStore()
        const cursors = new CursorRegistry()
        const lifecycle = new PluginDataLifecycleRegistry()
        const unregister = registerDeviceCacheLifecycle(store, cursors, lifecycle)
        const a = harness({ store, cursors, principalId: PRINCIPAL_A, instanceId: 'a' }).service
        const b = harness({ store, cursors, principalId: PRINCIPAL_B, instanceId: 'b' }).service
        for (let index = 0; index < 2; index++) {
            await a.putDeviceCacheEntry({ key: `a/${index}`, value: { kind: 'json', value: index } })
            await b.putDeviceCacheEntry({ key: `b/${index}`, value: { kind: 'json', value: index } })
        }
        const aPage = await a.listDeviceCacheEntries({ limit: 1 })
        const bPage = await b.listDeviceCacheEntries({ limit: 1 })
        expect((await lifecycle.run(PRINCIPAL_A, action)).failures).toEqual([])
        expect(await a.listDeviceCacheEntries()).toEqual({ items: [] })
        expect((await b.listDeviceCacheEntries()).items.map((entry) => entry.key)).toEqual(['b/0', 'b/1'])
        expect(await codeOf(a.listDeviceCacheEntries({ limit: 1, cursor: aPage.nextCursor }))).toBe('INVALID_ARGUMENT')
        await expect(b.listDeviceCacheEntries({ limit: 1, cursor: bPage.nextCursor })).resolves.toMatchObject({ items: [{ key: 'b/1' }] })
        unregister()
    })
})

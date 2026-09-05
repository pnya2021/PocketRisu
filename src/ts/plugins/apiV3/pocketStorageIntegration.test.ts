import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const storage = vi.hoisted(() => ({
    values: new Map<string, unknown>(),
    pending: undefined as Promise<void> | undefined,
    started: undefined as (() => void) | undefined,
    failure: false,
}))
vi.mock('../pluginStorageStore', () => ({
    init: async () => undefined,
    getItem: async (key: string) => storage.values.get(key) ?? null,
    getItemSync: () => null, // V3-only startup has no V2 preload.
    setItem: async (key: string, value: unknown) => {
        storage.started?.()
        await storage.pending
        if (storage.failure) throw new Error('server write rejected')
        storage.values.set(key, value)
    },
    removeItem: async (key: string) => { storage.values.delete(key) },
    clear: async () => { storage.values.clear() },
    keys: () => [...storage.values.keys()],
    key: (index: number) => [...storage.values.keys()][index],
    length: () => storage.values.size,
}))

describe('Pocket V3 externalized storage integration', () => {
    let v3: typeof import('./v3.svelte')
    let stores: typeof import('../../stores.svelte')
    let instance: ReturnType<typeof v3.getV3PluginInstance>
    let previousPlugins: typeof stores.DBState.db.plugins
    let api: any
    let plugin: any

    beforeEach(async () => {
        storage.values.clear()
        storage.pending = undefined
        storage.started = undefined
        storage.failure = false
        vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
            const path = new URL(String(input), 'http://localhost').pathname
            if (path === '/api/test_auth') return Response.json({ status: 'correct', token: 'storage-test' })
            if (path === '/api/session') return Response.json({})
            if (path === '/api/list') return Response.json({ content: [] })
            if (path === '/api/read') return new Response(new Uint8Array())
            throw new Error(`Unexpected storage-test fetch: ${path}`)
        }))
        stores = await import('../../stores.svelte')
        v3 = await import('./v3.svelte')
        plugin = { name: 'storage-test', displayName: 'Storage test', script: '', arguments: {},
            realArg: {}, customLink: [], argMeta: {}, version: '3.0', enabled: true,
            principalId: crypto.randomUUID() }
        previousPlugins = stores.DBState.db.plugins
        stores.DBState.db.plugins = [plugin]
        await v3.executePluginV3(plugin)
        instance = v3.getV3PluginInstance(plugin.name)
        expect(instance).toBeDefined()
        api = (instance!.host as any).apiFactory
    }, 30_000)

    afterEach(async () => {
        if (instance) await v3.unloadV3Plugin(instance.instanceId)
        stores.DBState.db.plugins = previousPlugins
        vi.unstubAllGlobals()
    })

    it('reads migrated values without a V2 preload or materializing the DB field', async () => {
        storage.values.set('cold-profile', { version: 11 })
        expect(await api._getPluginStorage('cold-profile')).toEqual({ version: 11 })
        expect(stores.DBState.db.pluginCustomStorage?.['cold-profile']).toBeUndefined()
    })

    it('awaits server persistence and surfaces rejection instead of reporting an early success', async () => {
        let release!: () => void
        storage.pending = new Promise<void>((resolve) => { release = resolve })
        let started!: () => void
        const entered = new Promise<void>((resolve) => { started = resolve })
        storage.started = started
        let settled = false
        const write = api._setPluginStorage('profile', { version: 12 }).finally(() => { settled = true })
        await entered
        expect(settled).toBe(false)
        expect(storage.values.has('profile')).toBe(false)
        release()
        await write
        expect(storage.values.get('profile')).toEqual({ version: 12 })
        expect(stores.DBState.db.pluginStorageMeta.profile).toMatchObject({
            state: 'principal', principalId: plugin.principalId,
        })
        storage.failure = true
        await expect(api._setPluginStorage('profile', 'lost')).rejects.toThrow('server write rejected')
        expect(storage.values.get('profile')).toEqual({ version: 12 })
    })

    it('blocks new writes after unload', async () => {
        await v3.unloadV3Plugin(instance!.instanceId)
        await api._setPluginStorage('after-unload', 'stale')
        expect(storage.values.has('after-unload')).toBe(false)
    })

    it('keeps an in-flight write quarantined when its principal retires', async () => {
        let release!: () => void
        storage.pending = new Promise<void>((resolve) => { release = resolve })
        let started!: () => void
        const entered = new Promise<void>((resolve) => { started = resolve })
        storage.started = started
        const write = api._setPluginStorage('retiring-value', 'kept for recovery')
        await entered
        const { pluginDataLifecycle } = await import('../pluginDataLifecycle')
        await pluginDataLifecycle.retirePrincipal(plugin.principalId, { invalidate: () => undefined })
        release()
        await write
        expect(storage.values.get('retiring-value')).toBe('kept for recovery')
        expect(stores.DBState.db.pluginStorageMeta['retiring-value']).toMatchObject({
            state: 'quarantined', principalId: plugin.principalId,
        })
    })
})

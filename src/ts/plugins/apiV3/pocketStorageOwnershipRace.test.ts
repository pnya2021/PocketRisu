import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

describe('V3 ownership across real asynchronous plugin storage queues', () => {
    const kv = new Map<string, Uint8Array>()
    let v3: typeof import('./v3.svelte')
    let stores: typeof import('../../stores.svelte')
    let store: typeof import('../pluginStorageStore')
    let previousPlugins: typeof stores.DBState.db.plugins
    let previousMeta: typeof stores.DBState.db.pluginStorageMeta
    let oldPlugin: any
    let newPlugin: any
    let oldApi: any
    let newApi: any
    const instances: string[] = []
    let removeGate: Promise<void> | undefined
    let removeStarted: (() => void) | undefined
    let failedWriteGate: Promise<void> | undefined
    let failedWriteStarted: (() => void) | undefined

    beforeEach(async () => {
        kv.clear()
        removeGate = undefined
        removeStarted = undefined
        failedWriteGate = undefined
        failedWriteStarted = undefined
        vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
            const pathname = new URL(String(input), 'http://localhost').pathname
            if (pathname === '/api/test_auth') return Response.json({ status: 'correct', token: 'owner-race-test' })
            if (pathname === '/api/session') return Response.json({})
            if (pathname === '/api/list') return Response.json({ content: [] })
            if (pathname === '/api/read') return new Response(new Uint8Array())
            throw new Error(`Unexpected ownership-test fetch: ${pathname}`)
        }))
        stores = await import('../../stores.svelte')
        v3 = await import('./v3.svelte')
        store = await import('../pluginStorageStore')
        const { forageStorage } = await import('../../globalApi.svelte')
        store._resetForTests()
        vi.spyOn(forageStorage, 'Init').mockResolvedValue(undefined)
        vi.spyOn(forageStorage, 'getPluginStorageIndex').mockResolvedValue({ entries: [], migrated: true })
        vi.spyOn(forageStorage, 'getItem').mockImplementation((async (key: string) => kv.get(key) ?? null) as any)
        vi.spyOn(forageStorage, 'setItem').mockImplementation((async (key: string, value: Uint8Array) => {
            if (key.startsWith('plugin-storage/') && new TextDecoder().decode(value).startsWith('"rejected')) {
                failedWriteStarted?.()
                await failedWriteGate
                throw new Error('server rejected write')
            }
            kv.set(key, value)
        }) as any)
        vi.spyOn(forageStorage, 'removeItem').mockImplementation(async (key: string) => {
            if (key.startsWith('plugin-storage/')) { removeStarted?.(); await removeGate }
            kv.delete(key)
        })
        const plugin = (name: string) => ({ name, displayName: name, script: '', arguments: {}, realArg: {},
            customLink: [], argMeta: {}, version: '3.0', enabled: true, principalId: crypto.randomUUID() })
        oldPlugin = plugin('old-owner')
        newPlugin = plugin('new-owner')
        previousPlugins = stores.DBState.db.plugins
        previousMeta = stores.DBState.db.pluginStorageMeta
        stores.DBState.db.plugins = [oldPlugin, newPlugin]
        stores.DBState.db.pluginStorageMeta = {}
        for (const entry of [oldPlugin, newPlugin]) {
            await v3.executePluginV3(entry)
            const instance = v3.getV3PluginInstance(entry.name)!
            instances.push(instance.instanceId)
            if (entry === oldPlugin) oldApi = (instance.host as any).apiFactory
            else newApi = (instance.host as any).apiFactory
        }
        await oldApi._setPluginStorage('shared', 'old')
    }, 30_000)

    afterEach(async () => {
        for (const id of instances.splice(0)) await v3.unloadV3Plugin(id)
        await store.drainPendingWrites()
        store._resetForTests()
        stores.DBState.db.plugins = previousPlugins
        stores.DBState.db.pluginStorageMeta = previousMeta
        vi.restoreAllMocks()
        vi.unstubAllGlobals()
    })

    it.each(['remove', 'clear'] as const)('does not erase a newer writer owner after an older %s', async (operation) => {
        let release!: () => void
        removeGate = new Promise<void>((resolve) => { release = resolve })
        const entered = new Promise<void>((resolve) => { removeStarted = resolve })
        const removing = operation === 'remove' ? oldApi._removePluginStorage('shared') : oldApi._clearPluginStorage()
        await entered
        const writing = newApi._setPluginStorage('shared', 'new')
        release()
        await Promise.all([removing, writing])
        expect(await store.getItem('shared')).toBe('new')
        expect(stores.DBState.db.pluginStorageMeta.shared).toMatchObject({
            state: 'principal', principalId: newPlugin.principalId,
        })
    })

    it('restores the surviving value owner when a replacement write fails', async () => {
        await expect(newApi._setPluginStorage('shared', 'rejected')).rejects.toThrow('server rejected write')
        expect(await store.getItem('shared')).toBe('old')
        expect(stores.DBState.db.pluginStorageMeta.shared).toMatchObject({
            state: 'principal', principalId: oldPlugin.principalId,
        })
    })

    it('does not roll back a newer successful writer ownership after an earlier write fails', async () => {
        let release!: () => void
        failedWriteGate = new Promise<void>((resolve) => { release = resolve })
        const entered = new Promise<void>((resolve) => { failedWriteStarted = resolve })
        const failing = newApi._setPluginStorage('shared', 'rejected').catch((error: Error) => error)
        await entered
        const writing = oldApi._setPluginStorage('shared', 'newer success')
        const newerOwner = stores.DBState.db.pluginStorageMeta.shared
        release()
        await Promise.all([failing, writing])
        expect(await store.getItem('shared')).toBe('newer success')
        expect(stores.DBState.db.pluginStorageMeta.shared).toBe(newerOwner)
    })

    it('preserves lifecycle-normalized ownership during a failed replacement', async () => {
        let release!: () => void
        failedWriteGate = new Promise<void>((resolve) => { release = resolve })
        const entered = new Promise<void>((resolve) => { failedWriteStarted = resolve })
        const failing = newApi._setPluginStorage('shared', 'rejected').catch((error: Error) => error)
        await entered
        const { pluginDataLifecycle } = await import('../pluginDataLifecycle')
        await pluginDataLifecycle.retirePrincipal(oldPlugin.principalId, { invalidate: () => undefined })
        const lifecycleOwner = stores.DBState.db.pluginStorageMeta.shared
        release()
        await failing
        expect(await store.getItem('shared')).toBe('old')
        expect(stores.DBState.db.pluginStorageMeta.shared).toBe(lifecycleOwner)
    })

    it('restores the original owner when two overlapping replacements both fail', async () => {
        let release!: () => void
        failedWriteGate = new Promise<void>((resolve) => { release = resolve })
        const entered = new Promise<void>((resolve) => { failedWriteStarted = resolve })
        const originalOwner = stores.DBState.db.pluginStorageMeta.shared
        const first = newApi._setPluginStorage('shared', 'rejected-first').catch((error: Error) => error)
        await entered
        const second = oldApi._setPluginStorage('shared', 'rejected-second').catch((error: Error) => error)
        release()
        await Promise.all([first, second])
        expect(await store.getItem('shared')).toBe('old')
        expect(stores.DBState.db.pluginStorageMeta.shared).toBe(originalOwner)
    })

    it('does not roll back quarantine when a retiring writer request fails', async () => {
        let release!: () => void
        failedWriteGate = new Promise<void>((resolve) => { release = resolve })
        const entered = new Promise<void>((resolve) => { failedWriteStarted = resolve })
        const failing = newApi._setPluginStorage('shared', 'rejected').catch((error: Error) => error)
        await entered
        const { pluginDataLifecycle } = await import('../pluginDataLifecycle')
        await pluginDataLifecycle.retirePrincipal(newPlugin.principalId, { invalidate: () => undefined })
        release()
        await failing
        expect(await store.getItem('shared')).toBe('old')
        expect(stores.DBState.db.pluginStorageMeta.shared).toMatchObject({
            state: 'quarantined', principalId: newPlugin.principalId,
        })
    })

    it('preserves the newer writer quarantine when retirement overlaps the older removal', async () => {
        let release!: () => void
        removeGate = new Promise<void>((resolve) => { release = resolve })
        const entered = new Promise<void>((resolve) => { removeStarted = resolve })
        const removing = oldApi._removePluginStorage('shared')
        await entered
        const writing = newApi._setPluginStorage('shared', 'new')
        const { pluginDataLifecycle } = await import('../pluginDataLifecycle')
        await pluginDataLifecycle.retirePrincipal(newPlugin.principalId, { invalidate: () => undefined })
        release()
        await Promise.all([removing, writing])
        expect(await store.getItem('shared')).toBe('new')
        expect(stores.DBState.db.pluginStorageMeta.shared).toMatchObject({
            state: 'quarantined', principalId: newPlugin.principalId,
        })
    })
})

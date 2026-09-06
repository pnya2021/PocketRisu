import { afterEach, describe, expect, it, vi } from 'vitest'
import { Buffer as NodeBuffer } from 'node:buffer'

vi.mock('../platform', async (original) => ({
    ...await original<typeof import('../platform')>(),
    supportsPatchSync: true,
}))

describe('PocketRisu upstream save conflict with downstream persistence ownership', () => {
    afterEach(() => {
        vi.restoreAllMocks()
        vi.unstubAllGlobals()
    })

    it('rebases a foreign patch revision before writing and preserves unedited remote settings', async () => {
        vi.spyOn(console, 'log').mockImplementation(() => undefined)
        vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
            const path = new URL(String(input), 'http://localhost').pathname
            if (path === '/api/test_auth') return Response.json({ status: 'correct', token: 'sync-save-test' })
            if (path === '/api/session') return Response.json({})
            if (path === '/api/list') return Response.json({ content: [] })
            if (path === '/api/read') return new Response(new Uint8Array())
            throw new Error(`Unexpected sync-save request: ${path}`)
        }))
        vi.stubGlobal('BroadcastChannel', undefined)
        const stores = await import('../stores.svelte')
        const database = await import('./database.svelte')
        const api = await import('../globalApi.svelte')
        const save = await import('./risuSave')
        const util = await import('../util')
        const { tick } = await import('svelte')
        const storage = await import('../plugins/pluginStorageStore')
        // The app's browser polyfill replaces Buffer during import; Node's
        // external msgpackr module must keep the same native Buffer realm.
        vi.stubGlobal('Buffer', NodeBuffer)
        storage._resetForTests()
        database.setDatabase({ characters: [], plugins: [], temperature: 0.8, maxResponse: 1024 } as any)
        const baseline = database.getDatabase({ snapshot: true })
        const remote = { ...structuredClone(baseline), temperature: 0.3 }
        const remoteBytes = save.encodeRisuSaveLegacy(remote)
        let etag = 'local-revision'
        let reads = 0
        const writes: Array<{ temperature: number; maxResponse: number }> = []
        vi.spyOn(api.forageStorage, 'Init').mockResolvedValue(undefined)
        vi.spyOn(api.forageStorage, 'getPluginStorageIndex').mockResolvedValue({ entries: [], migrated: true })
        vi.spyOn(api.forageStorage, 'getDbEtag').mockImplementation(() => etag)
        vi.spyOn(api.forageStorage, 'setDbEtag').mockImplementation((value) => { etag = value ?? '' })
        vi.spyOn(api.forageStorage, 'getItem').mockImplementation((async (key: string) => {
            if (key !== 'database/database.bin') throw new Error(`Unexpected storage key: ${key}`)
            reads++
            etag = 'remote-revision'
            return remoteBytes
        }) as any)
        vi.spyOn(api.forageStorage, 'patchItem').mockResolvedValue({ success: false, etag: 'remote-revision' })
        vi.spyOn(api.forageStorage, 'setItem').mockImplementation(async (key, bytes, expectedEtag) => {
            expect(key).toBe('database/database.bin')
            expect(expectedEtag).toBe('remote-revision')
            const value = await save.decodeRisuSave(bytes)
            writes.push({ temperature: value.temperature, maxResponse: value.maxResponse })
            etag = 'merged-revision'
            return null
        })
        let ready!: () => void
        const initialized = new Promise<void>((resolve) => { ready = resolve })
        // Park only the background save loop; the explicit save below uses the
        // real encoder, patcher, conflict handler and persistence coordinator.
        vi.spyOn(util, 'sleep').mockImplementation((ms) => {
            if (ms === 200) {
                ready()
                return new Promise<void>(() => {})
            }
            return Promise.resolve()
        })
        api.setPatchSyncBaseline(baseline)
        void api.saveDb()
        await initialized
        await tick()
        stores.DBState.db.maxResponse = 2048
        await tick()
        await api.requestImmediateSave()
        expect(reads).toBeGreaterThan(0)
        expect(writes).toEqual([{ temperature: 0.3, maxResponse: 2048 }])
        expect(stores.DBState.db.temperature).toBe(0.3)
        storage._resetForTests()
    }, 30_000)
})

import { afterEach, describe, expect, it, vi } from 'vitest'
import { Buffer as NodeBuffer } from 'node:buffer'

describe('acknowledged live full-write preserves lazy chats', () => {
    afterEach(() => {
        vi.restoreAllMocks()
        vi.unstubAllGlobals()
    })

    async function harness() {
        // afterEach restores the globals from vitest.setup too; reinstall its
        // clone shim for each case rather than depending on test order.
        vi.stubGlobal('safeStructuredClone', (value: unknown) => JSON.parse(JSON.stringify(value)))
        vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
            const path = new URL(String(input), 'http://localhost').pathname
            if (path === '/api/test_auth') return Response.json({ status: 'correct', token: 'full-write-test' })
            if (path === '/api/session') return Response.json({})
            if (path === '/api/list') return Response.json({ content: [] })
            if (path === '/api/read') return new Response(new Uint8Array())
            throw new Error(`Unexpected full-write request: ${path}`)
        }))
        await import('../stores.svelte')
        const database = await import('./database.svelte')
        const api = await import('../globalApi.svelte')
        const save = await import('./risuSave')
        const pluginStorage = await import('../plugins/pluginStorageStore')
        const { databasePersistenceCoordinator } = await import('./databasePersistenceCoordinator')
        vi.stubGlobal('Buffer', NodeBuffer)
        pluginStorage._resetForTests()
        const snapshot = {
            ...database.getDatabase({ snapshot: true }),
            characters: [{
                chaId: 'character-a', name: 'Latest name',
                chats: [
                    { id: 'loaded-chat', name: 'Loaded', message: [{ role: 'user', data: 'Unsaved latest edit' }], note: '' },
                    { id: 'lazy-chat', name: 'Lazy', _placeholder: true, message: [], note: '', localLore: [], folderId: null },
                ],
            }],
            plugins: [], pluginCustomStorage: {},
        } as any
        api.requiresFullEncoderReload.state = false
        vi.spyOn(api.forageStorage, 'getDbEtag').mockReturnValue('acknowledged-revision')
        return { api, save, snapshot, pluginStorage, databasePersistenceCoordinator }
    }

    it.each(['persistRestoredDatabaseUnderLease', 'persistLiveDatabaseUnderLease'] as const)(
        '%s writes loaded edits inline but sends lazy placeholders as server-mergeable stubs without mutating the snapshot', async (method) => {
        const { api, save, snapshot, pluginStorage, databasePersistenceCoordinator } = await harness()
        const before = structuredClone(snapshot)
        let written: any
        vi.spyOn(api.forageStorage, 'setItem').mockImplementation(async (key, bytes, etag) => {
            expect(key).toBe('database/database.bin')
            expect(etag).toBe('acknowledged-revision')
            written = await save.decodeRisuSave(bytes)
            return null
        })

        await databasePersistenceCoordinator.runExclusiveMutation(
            () => api[method](snapshot),
        )

        expect(written.characters[0].name).toBe('Latest name')
        expect(written.characters[0].chats[0]).toEqual(before.characters[0].chats[0])
        expect(written.characters[0].chats[1]).toEqual({
            id: 'lazy-chat', name: 'Lazy', _stub: true, folderId: null,
        })
        expect(snapshot).toEqual(before)
        expect(api.requiresFullEncoderReload.state).toBe(true)
        pluginStorage._resetForTests()
    }, 30_000)

    it.each(['persistRestoredDatabaseUnderLease', 'persistLiveDatabaseUnderLease'] as const)(
        '%s rejects an unresolved placeholder with no stable id before writing', async (method) => {
        const { api, snapshot, pluginStorage, databasePersistenceCoordinator } = await harness()
        snapshot.characters[0].chats[1].id = ''
        const write = vi.spyOn(api.forageStorage, 'setItem').mockResolvedValue(null)

        await expect(databasePersistenceCoordinator.runExclusiveMutation(
            () => api[method](snapshot),
        )).rejects.toThrow('without a stable id')

        expect(write).not.toHaveBeenCalled()
        pluginStorage._resetForTests()
    }, 30_000)

    it('keeps the live plugin cache intact and rejects a stale inline plugin overlay', async () => {
        const { api, snapshot, pluginStorage, databasePersistenceCoordinator } = await harness()
        const invalidate = vi.spyOn(pluginStorage, 'invalidateCache')
        const write = vi.spyOn(api.forageStorage, 'setItem').mockResolvedValue(null)
        await databasePersistenceCoordinator.runExclusiveMutation(
            () => api.persistLiveDatabaseUnderLease(snapshot),
        )
        expect(invalidate).not.toHaveBeenCalled()
        snapshot.pluginCustomStorage = { stale: 'must not overwrite live KV' }
        await expect(databasePersistenceCoordinator.runExclusiveMutation(
            () => api.persistLiveDatabaseUnderLease(snapshot),
        )).rejects.toThrow('must be migrated')
        expect(write).toHaveBeenCalledTimes(1)
        expect(invalidate).not.toHaveBeenCalled()
        pluginStorage._resetForTests()
    }, 30_000)

    it('refuses an unconditional live full-write when the acknowledged database revision is missing', async () => {
        const { api, snapshot, pluginStorage, databasePersistenceCoordinator } = await harness()
        vi.spyOn(api.forageStorage, 'getDbEtag').mockReturnValue(null)
        const write = vi.spyOn(api.forageStorage, 'setItem').mockResolvedValue(null)
        await expect(databasePersistenceCoordinator.runExclusiveMutation(
            () => api.persistLiveDatabaseUnderLease(snapshot),
        )).rejects.toThrow('acknowledged database revision')
        expect(write).not.toHaveBeenCalled()
        pluginStorage._resetForTests()
    }, 30_000)

    it('propagates a failed write instead of acknowledging persistence or invalidating the encoder', async () => {
        const { api, snapshot, pluginStorage, databasePersistenceCoordinator } = await harness()
        const failure = new Error('Simulated storage failure')
        vi.spyOn(api.forageStorage, 'setItem').mockRejectedValue(failure)

        await expect(databasePersistenceCoordinator.runExclusiveMutation(
            () => api.persistRestoredDatabaseUnderLease(snapshot),
        )).rejects.toBe(failure)

        expect(api.requiresFullEncoderReload.state).toBe(false)
        pluginStorage._resetForTests()
    }, 30_000)
})

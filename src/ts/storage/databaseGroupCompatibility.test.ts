import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../stores.svelte', () => {
    const state: { db: any } = { db: {} }
    const noopStore = { subscribe: () => () => {}, set: () => {}, update: () => {} }
    return {
        DBState: state,
        selectedCharID: noopStore,
        selIdState: { selId: -1 },
    }
})

vi.mock('../globalApi.svelte', () => ({
    forageStorage: { realStorage: null },
    downloadFile: () => {},
    saveAsset: () => Promise.resolve(''),
}))

vi.mock('../alert', () => ({
    notifySuccess: () => {},
    alertError: () => {},
}))

vi.mock('../../lang', () => ({
    language: {},
    changeLanguage: () => {},
}))

const databaseModule = await import('./database.svelte')
const storesModule = await import('../stores.svelte')
const coldHydrationModule = await import('./coldDatabaseHydration')

const { setDatabase } = databaseModule
const { DBState } = storesModule as any
const {
    flushColdDatabaseWriteback,
    hydrateColdDatabase,
    loadPluginsAfterColdDatabaseWriteback,
} = coldHydrationModule

function makeColdDatabase() {
    return {
        characters: [{
            type: 'group',
            chaId: 'broken-group',
            name: 'Broken group',
            characters: 'not-an-array',
            chats: [],
            unknownPluginField: { preserved: true },
        }],
        characterOrder: ['broken-group'],
        plugins: [],
        pluginStorageMeta: {},
        pluginStorageMetaMigrationV2: true,
    } as any
}

describe('setDatabase group compatibility integration', () => {
    beforeEach(async () => {
        await flushColdDatabaseWriteback(async () => undefined)
        DBState.db = {}
    })

    it('quarantines invalid groups and requests durable writeback before plugins load', async () => {
        const events: string[] = []
        const cold = makeColdDatabase()

        const result = hydrateColdDatabase(cold, {
            setDatabase: (data) => {
                events.push('normalize')
                return setDatabase(data)
            },
            getSnapshot: () => DBState.db,
        })

        expect(result.pluginStateChanged).toBe(true)
        expect(DBState.db.characters).toEqual([])
        expect(DBState.db.characterOrder).toEqual([])
        expect(DBState.db.quarantinedGroupChats).toEqual([
            expect.objectContaining({
                reason: 'invalid-members',
                originalIndex: 0,
                orderReferences: [{ kind: 'root', orderIndex: 0 }],
            }),
        ])

        await loadPluginsAfterColdDatabaseWriteback(
            async () => { events.push('durable-write') },
            async () => { events.push('plugin-load') },
        )

        expect(events).toEqual(['normalize', 'durable-write', 'plugin-load'])
    })
})

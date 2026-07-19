import { beforeEach, describe, expect, it, vi } from 'vitest'

const state = vi.hoisted(() => ({
    db: { pluginStorageMeta: {}, pluginStorageMetaMigrationV2: true } as any,
    persistent: new Map<string, unknown>(),
    beforeWrite: undefined as undefined | ((key: string, value: unknown) => void | Promise<void>),
}))

vi.mock('../storage/database.svelte', () => ({ getDatabase: () => state.db }))
vi.mock('../storage/persistentKv', () => ({
    listPersistentKeys: async (prefix: string) => [...state.persistent.keys()].filter((key) => key.startsWith(prefix)),
    makeEncodedStorageKey: (prefix: string, key: string) => `${prefix}${key}.json`,
    decodeStorageKeyComponent: (key: string) => key,
    readPersistentJson: async (key: string) => state.persistent.get(key) ?? null,
    writePersistentJson: async (key: string, value: unknown) => {
        await state.beforeWrite?.(key, value)
        state.persistent.set(key, value)
    },
    removePersistentKey: async (key: string) => { state.persistent.delete(key) },
    clearPersistentPrefix: async (prefix: string) => {
        for (const key of state.persistent.keys()) if (key.startsWith(prefix)) state.persistent.delete(key)
    },
}))

import { clearOwners, recordOwner } from './pluginStorageMeta'
import { pluginDataLifecycle } from './pluginDataLifecycle'

describe('plugin storage migration markers', () => {
    beforeEach(() => {
        localStorage.clear()
        state.persistent.clear()
        state.db = { pluginStorageMeta: {}, pluginStorageMetaMigrationV2: true }
        state.beforeWrite = undefined
    })

    it('clearOwners and uninstall-style clearing never remove one-shot migration markers', async () => {
        localStorage.setItem('risu_plugin_storage_owners', '{}')
        localStorage.setItem('risu_plugin_storage_owners_migrated_v2', '1')
        state.persistent.set('cache/plugin-storage-meta/key.json', { state: 'principal', principalId: 'p', displayName: 'P', updatedAt: 1 })
        state.persistent.set('cache/plugin-storage-meta-migrated-v2.json', true)

        await clearOwners('local')
        await clearOwners('idb')
        await clearOwners('save')

        expect(localStorage.getItem('risu_plugin_storage_owners_migrated_v2')).toBe('1')
        expect(state.persistent.get('cache/plugin-storage-meta-migrated-v2.json')).toBe(true)
        expect(state.db.pluginStorageMetaMigrationV2).toBe(true)
    })

    it('clearOwners completes first migration even when legacy data has no marker', async () => {
        state.db = {
            pluginStorageMeta: { old: { plugin: 'Legacy save', updatedAt: 1 } },
            pluginStorageMetaMigrationV2: false,
        }
        localStorage.setItem('risu_plugin_storage_owners', JSON.stringify({ old: { plugin: 'Legacy local' } }))
        state.persistent.set('cache/plugin-storage-meta/old.json', { plugin: 'Legacy idb' })

        await clearOwners('save')
        await clearOwners('local')
        await clearOwners('idb')

        expect(state.db.pluginStorageMeta).toEqual({})
        expect(state.db.pluginStorageMetaMigrationV2).toBe(true)
        expect(localStorage.getItem('risu_plugin_storage_owners')).toBe('{}')
        expect(localStorage.getItem('risu_plugin_storage_owners_migrated_v2')).toBe('1')
        expect(state.persistent.get('cache/plugin-storage-meta-migrated-v2.json')).toBe(true)
        expect([...state.persistent.keys()].filter((key) => key.startsWith('cache/plugin-storage-meta/'))).toEqual([])
    })

    it('does not re-own storage after principal retirement begins', async () => {
        const principalId = '33333333-3333-4333-8333-333333333333'
        await pluginDataLifecycle.retirePrincipal(principalId, { invalidate: () => undefined })
        recordOwner('save', 'late-write', principalId, 'Retiring')
        expect(state.db.pluginStorageMeta['late-write']).toBeUndefined()
    })

    it('quarantines an IDB owner write that races with principal retirement', async () => {
        const principalId = '44444444-4444-4444-8444-444444444444'
        let release!: () => void
        let started!: () => void
        const gate = new Promise<void>((resolve) => { release = resolve })
        const writeStarted = new Promise<void>((resolve) => { started = resolve })
        let blocked = false
        state.beforeWrite = async (key) => {
            if (key.includes('racing-write') && !blocked) {
                blocked = true
                started()
                await gate
            }
        }

        const write = recordOwner('idb', 'racing-write', principalId, 'Retiring') as Promise<boolean>
        await writeStarted
        await pluginDataLifecycle.retirePrincipal(principalId, { invalidate: () => undefined })
        release()
        await write

        expect(state.persistent.get('cache/plugin-storage-meta/racing-write.json')).toMatchObject({
            state: 'quarantined', principalId,
        })
    })
})

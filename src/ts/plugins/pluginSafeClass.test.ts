import { beforeEach, describe, expect, it, vi } from 'vitest'

const state = vi.hoisted(() => ({
    db: { pluginStorageMeta: {}, pluginStorageMetaMigrationV2: true } as any,
    persistent: new Map<string, unknown>(),
    beforeWrite: undefined as undefined | ((key: string) => void | Promise<void>),
}))

vi.mock('../globalApi.svelte', () => ({ toGetter: (value: unknown) => value }))
vi.mock('../storage/database.svelte', () => ({ getDatabase: () => state.db }))
vi.mock('../storage/persistentKv', () => ({
    listPersistentKeys: async (prefix: string) => [...state.persistent.keys()].filter((key) => key.startsWith(prefix)),
    makeEncodedStorageKey: (prefix: string, key: string) => `${prefix}${key}.json`,
    decodeStorageKeyComponent: (key: string) => key,
    readPersistentJson: async (key: string) => state.persistent.get(key) ?? null,
    writePersistentJson: async (key: string, value: unknown) => {
        await state.beforeWrite?.(key)
        state.persistent.set(key, value)
    },
    removePersistentKey: async (key: string) => { state.persistent.delete(key) },
    clearPersistentPrefix: async (prefix: string) => {
        for (const key of state.persistent.keys()) if (key.startsWith(prefix)) state.persistent.delete(key)
    },
}))

import { SafeLocalPluginStorage } from './pluginSafeClass'
import { pluginDataLifecycle } from './pluginDataLifecycle'

describe('Pocket owned plugin storage writes', () => {
    beforeEach(() => {
        state.db = { pluginStorageMeta: {}, pluginStorageMetaMigrationV2: true }
        state.persistent.clear()
        state.beforeWrite = undefined
    })

    it('never leaves a value unassociated when retirement completes during its IDB write', async () => {
        const principalId = '55555555-5555-4555-8555-555555555555'
        const storage = new SafeLocalPluginStorage({ principalId, displayName: 'Retiring' })
        let release!: () => void
        let started!: () => void
        const gate = new Promise<void>((resolve) => { release = resolve })
        const valueWriteStarted = new Promise<void>((resolve) => { started = resolve })
        let blocked = false
        state.beforeWrite = async (key) => {
            if (key === 'cache/plugin-storage/racing-write.json' && !blocked) {
                blocked = true
                started()
                await gate
            }
        }

        const write = storage.setItem('racing-write', { value: 1 })
        await valueWriteStarted
        await pluginDataLifecycle.retirePrincipal(principalId, { invalidate: () => undefined })
        release()
        await write

        expect(state.persistent.get('cache/plugin-storage/racing-write.json')).toEqual({ value: 1 })
        expect(state.persistent.get('cache/plugin-storage-meta/racing-write.json')).toMatchObject({
            state: 'quarantined', principalId,
        })
    })
})

import { beforeEach, describe, expect, it } from 'vitest'
import { PersistentPermissionPersistence, type PersistentPermissionKv } from './permissions'

const storage = {
    values: new Map<string, unknown>(),
    failNextWrite: false,
}

const kv: PersistentPermissionKv = {
    makeEncodedStorageKey: (prefix: string, raw: string) => `${prefix}${Buffer.from(raw).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '')}.json`,
    decodeStorageKeyComponent: (encoded: string) => Buffer.from(encoded.replace(/-/g, '+').replace(/_/g, '/').padEnd(Math.ceil(encoded.length / 4) * 4, '='), 'base64').toString(),
    readPersistentJson: async <T>(key: string) => (storage.values.get(key) as T | undefined) ?? null,
    writePersistentJson: async <T>(key: string, value: T) => {
        if (storage.failNextWrite) {
            storage.failNextWrite = false
            throw new Error('write failed')
        }
        storage.values.set(key, value)
    },
    listPersistentKeys: async (prefix: string) => [...storage.values.keys()].filter((key) => key.startsWith(prefix)),
    removePersistentKey: async (key: string) => { storage.values.delete(key) },
    clearPersistentPrefix: async (prefix: string) => {
        for (const key of storage.values.keys()) if (key.startsWith(prefix)) storage.values.delete(key)
    },
}

describe('persistent principal permission records', () => {
    beforeEach(() => {
        storage.values.clear()
        storage.failNextWrite = false
    })

    it('preserves concurrent writes for distinct principal-permission keys', async () => {
        const persistence = new PersistentPermissionPersistence(kv)
        await Promise.all([
            persistence.set('principal-a', 'db', { state: 'granted', decidedAt: 1 }),
            persistence.set('principal-b', 'chatObserve', { state: 'denied', decidedAt: 2 }),
        ])
        await expect(persistence.get('principal-a', 'db')).resolves.toEqual({ state: 'granted', decidedAt: 1 })
        await expect(persistence.get('principal-b', 'chatObserve')).resolves.toEqual({ state: 'denied', decidedAt: 2 })
    })

    it('does not poison later writes after one storage failure', async () => {
        const persistence = new PersistentPermissionPersistence(kv)
        storage.failNextWrite = true
        await expect(persistence.set('principal-a', 'db', { state: 'granted', decidedAt: 1 })).rejects.toThrow('write failed')
        await expect(persistence.set('principal-b', 'db', { state: 'denied', decidedAt: 2 })).resolves.toBeUndefined()
        await expect(persistence.get('principal-b', 'db')).resolves.toEqual({ state: 'denied', decidedAt: 2 })
    })

    it('clears only the selected principal and can clear the whole namespace', async () => {
        const persistence = new PersistentPermissionPersistence(kv)
        await persistence.set('principal-a', 'db', { state: 'granted', decidedAt: 1 })
        await persistence.set('principal-b', 'db', { state: 'granted', decidedAt: 1 })
        await persistence.clearPrincipal('principal-a')
        await expect(persistence.get('principal-a', 'db')).resolves.toBeNull()
        await expect(persistence.get('principal-b', 'db')).resolves.toEqual({ state: 'granted', decidedAt: 1 })
        await persistence.clearAll()
        await expect(persistence.get('principal-b', 'db')).resolves.toBeNull()
    })
})

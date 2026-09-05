import { describe, test, expect, vi, beforeEach } from 'vitest'

// In-memory stand-in for the server kv behind persistentKv, with a switch to
// make writes fail like a 423 session-lock rejection or a dropped connection.
const kv = new Map<string, Uint8Array>()
let failWrites = false
// Serialized values containing this text are rejected (a per-write switch,
// so a failing write and a later successful one can be in flight together).
let poison: string | null = null
vi.mock('../globalApi.svelte', () => ({
    toGetter: (v: any) => v,
    forageStorage: {
        Init: async () => {},
        getItem: async (key: string) => kv.get(key) ?? null,
        setItem: async (key: string, value: Uint8Array) => {
            if (failWrites) throw new Error('write rejected')
            // One-shot: the first matching write fails, later ones succeed.
            if (poison && new TextDecoder().decode(value).includes(poison)) { poison = null; throw new Error('write rejected') }
            kv.set(key, value)
        },
        removeItem: async (key: string) => {
            if (failWrites) throw new Error('remove rejected')
            kv.delete(key)
        },
        keys: async (prefix: string) => [...kv.keys()].filter((k) => k.startsWith(prefix)),
    },
}))
vi.mock('../parser/parser.svelte', () => ({ hasher: async () => '' }))
const meta = { recordOwner: vi.fn(async () => true), removeOwner: vi.fn(async () => {}), clearOwners: vi.fn(async () => {}) }
vi.mock('./pluginStorageMeta', () => meta)

const { SafeLocalPluginStorage } = await import('./pluginSafeClass')

describe('SafeLocalPluginStorage write failure', () => {
    beforeEach(async () => {
        kv.clear()
        failWrites = false
        poison = null
        meta.recordOwner.mockClear()
        await new SafeLocalPluginStorage().clear()
    })

    test('a rejected server write is rolled back and surfaced', async () => {
        const storage = new SafeLocalPluginStorage({ principalId: '11111111-1111-4111-8111-111111111111', displayName: 'p' })
        await storage.setItem('cfg', { v: 1 })
        expect(await storage.getItem('cfg')).toEqual({ v: 1 })

        failWrites = true
        await expect(storage.setItem('cfg', { v: 2 })).rejects.toThrow('write rejected')
        // The plugin reads what the server holds, not the value it never got.
        expect(await storage.getItem('cfg')).toEqual({ v: 1 })
        expect(meta.recordOwner).toHaveBeenCalledTimes(2)
    })

    test('a rejected first write leaves no phantom value', async () => {
        const storage = new SafeLocalPluginStorage({ principalId: '11111111-1111-4111-8111-111111111111', displayName: 'p' })
        failWrites = true
        await expect(storage.setItem('fresh', 1)).rejects.toThrow()
        expect(await storage.getItem('fresh')).toBeNull()
    })

    test('a rejected remove keeps the value readable', async () => {
        const storage = new SafeLocalPluginStorage({ principalId: '11111111-1111-4111-8111-111111111111', displayName: 'p' })
        await storage.setItem('keep', 'x')
        failWrites = true
        await expect(storage.removeItem('keep')).rejects.toThrow('remove rejected')
        expect(await storage.getItem('keep')).toBe('x')
    })

    test('rollback does not clobber a newer write to the same key', async () => {
        const storage = new SafeLocalPluginStorage({ principalId: '11111111-1111-4111-8111-111111111111', displayName: 'p' })
        await storage.setItem('k', 'a')
        poison = 'b'
        const failing = storage.setItem('k', 'b')
        await storage.setItem('k', 'c')
        await expect(failing).rejects.toThrow()
        expect(await storage.getItem('k')).toBe('c')
    })

    test('rollback does not clobber a newer write of the same value', async () => {
        const storage = new SafeLocalPluginStorage({ principalId: '11111111-1111-4111-8111-111111111111', displayName: 'p' })
        await storage.setItem('k', 'a')
        poison = 'same'
        const failing = storage.setItem('k', 'same')
        await storage.setItem('k', 'same')
        await expect(failing).rejects.toThrow()
        expect(await storage.getItem('k')).toBe('same')
    })

    test('an owner-record failure prevents an unassociated value write', async () => {
        meta.recordOwner.mockImplementationOnce(async () => { throw new Error('meta down') })
        const storage = new SafeLocalPluginStorage({ principalId: '11111111-1111-4111-8111-111111111111', displayName: 'p' })
        await expect(storage.setItem('cfg', { v: 3 })).rejects.toThrow('meta down')
        expect(await storage.getItem('cfg')).toBeNull()
    })
})

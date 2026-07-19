import { describe, expect, it, vi } from 'vitest'
import { createOwnedSyncStorageMutations } from './ownedSyncStorage'

describe('V3 owned synchronous storage mutations', () => {
    it('blocks save/local writes and destructive mutations from an onUnload callback after retirement starts', () => {
        let retiring = false
        const values = new Map([['existing', 'value']])
        const owners = new Set(['existing'])
        const mutations = createOwnedSyncStorageMutations<string>({
            storage: {
                setItem: (key, value) => { values.set(key, value) },
                removeItem: (key) => { values.delete(key) },
                clear: () => { values.clear() },
            },
            canMutate: () => !retiring,
            recordOwner: (key) => { owners.add(key); return true },
            removeOwner: (key) => { owners.delete(key) },
            clearOwners: () => { owners.clear() },
        })

        retiring = true
        expect(mutations.setItem('late', 'secret')).toBe(false)
        expect(mutations.removeItem('existing')).toBe(false)
        expect(mutations.clear()).toBe(false)
        expect([...values]).toEqual([['existing', 'value']])
        expect([...owners]).toEqual(['existing'])
    })

    it('records ownership before exposing a new value and does not write when ownership is rejected', () => {
        const setItem = vi.fn()
        const events: string[] = []
        const mutations = createOwnedSyncStorageMutations<string>({
            storage: { setItem: (key, value) => { events.push('value'); setItem(key, value) }, removeItem: vi.fn(), clear: vi.fn() },
            canMutate: () => true,
            recordOwner: () => { events.push('owner'); return false },
            removeOwner: vi.fn(),
            clearOwners: vi.fn(),
        })
        expect(mutations.setItem('late', 'value')).toBe(false)
        expect(events).toEqual(['owner'])
        expect(setItem).not.toHaveBeenCalled()
    })
})

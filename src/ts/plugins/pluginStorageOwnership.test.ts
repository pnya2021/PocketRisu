import { describe, expect, it } from 'vitest'
import { normalizePluginStorageOwner, principalOwner, quarantinePluginStorageOwners, reconcilePluginStorageOwners } from './pluginStorageOwnership'

describe('Pocket plugin storage ownership', () => {
    it('keeps ambiguous name-only sidecars explicitly legacy and unassociated', () => {
        expect(normalizePluginStorageOwner({ plugin: 'same-name', updatedAt: 1 })).toEqual({
            state: 'legacy-unassociated', displayName: 'same-name', updatedAt: 1,
        })
    })

    it('records new ownership by principal instead of plugin name', () => {
        expect(principalOwner('11111111-1111-4111-8111-111111111111', 'Demo', 2)).toEqual({
            state: 'principal', principalId: '11111111-1111-4111-8111-111111111111', displayName: 'Demo', updatedAt: 2,
        })
    })

    it('quarantines only records owned by the invalidated principal', () => {
        const records = {
            own: principalOwner('p1', 'One', 1),
            other: principalOwner('p2', 'Two', 1),
            legacy: normalizePluginStorageOwner({ plugin: 'Old', updatedAt: 1 }),
        }
        expect(quarantinePluginStorageOwners(records, 'p1').own.state).toBe('quarantined')
        expect(quarantinePluginStorageOwners(records, 'p1').other.state).toBe('principal')
        expect(quarantinePluginStorageOwners(records, 'p1').legacy.state).toBe('legacy-unassociated')
    })

    it('quarantines restored sidecars whose principal is not in the final installed set', () => {
        const active = '11111111-1111-4111-8111-111111111111'
        const removed = '22222222-2222-4222-8222-222222222222'
        const reconciled = reconcilePluginStorageOwners({
            active: principalOwner(active, 'Active', 1),
            removed: principalOwner(removed, 'Removed', 1),
            ambiguous: { plugin: 'Name only', updatedAt: 1 },
        }, new Set([active]))
        expect(reconciled.active.state).toBe('principal')
        expect(reconciled.removed.state).toBe('quarantined')
        expect(reconciled.ambiguous.state).toBe('legacy-unassociated')
    })

    it('does not trust malformed principal-shaped sidecars', () => {
        expect(normalizePluginStorageOwner({ state: 'principal', principalId: 'plugin-name', displayName: 'Demo', updatedAt: 1 }))
            .toEqual({ state: 'legacy-unassociated', displayName: 'Demo', updatedAt: 1 })
    })
})

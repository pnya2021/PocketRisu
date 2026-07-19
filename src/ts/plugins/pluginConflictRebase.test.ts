import { describe, expect, it } from 'vitest'
import { applyTrackedPluginStateDuringConflict } from './pluginConflictRebase'

describe('plugin state conflict rebase', () => {
    it('keeps a tracked local uninstall absent instead of resurrecting the stale server principal', () => {
        const staleServer = {
            plugins: [{ name: 'removed', principalId: '11111111-1111-4111-8111-111111111111' }],
            pluginCustomStorage: { old: true },
        }
        const local = { plugins: [], pluginCustomStorage: { current: true } }
        const merged = applyTrackedPluginStateDuringConflict(staleServer, local, {
            plugins: true,
            pluginCustomStorage: true,
        })
        expect(merged.plugins).toEqual([])
        expect(merged.plugins).toHaveLength(0)
        expect(merged.pluginCustomStorage).toEqual({ current: true })
    })

    it('preserves the local update identity and storage when both changed during a conflict', () => {
        const principalId = '22222222-2222-4222-8222-222222222222'
        const merged = applyTrackedPluginStateDuringConflict(
            { plugins: [{ name: 'demo', script: 'old', principalId }], pluginCustomStorage: { value: 'server' } },
            { plugins: [{ name: 'demo', script: 'new', principalId }], pluginCustomStorage: { value: 'local' } },
            { plugins: true, pluginCustomStorage: true },
        )
        expect(merged.plugins).toEqual([{ name: 'demo', script: 'new', principalId }])
        expect(merged.pluginCustomStorage).toEqual({ value: 'local' })
    })
})

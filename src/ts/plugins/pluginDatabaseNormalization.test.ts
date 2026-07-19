import { describe, expect, it } from 'vitest'
import { clearPrincipalTombstonesForTests, invalidatePluginPrincipal, isCanonicalPluginPrincipalId } from './pluginPrincipal'
import { normalizePluginDatabaseState } from './pluginDatabaseNormalization'
import { pluginDataLifecycle } from './pluginDataLifecycle'

describe('Pocket plugin database normalization', () => {
    it('assigns durable principals and completes save-sidecar migration exactly once', () => {
        const data: {
            plugins: Array<{ name: string; script: string; enabled: boolean; principalId?: string }>
            pluginStorageMeta: Record<string, any>
            pluginStorageMetaMigrationV2?: boolean
        } = {
            plugins: [{ name: 'legacy', script: 'code', enabled: true }],
            pluginStorageMeta: { old: { plugin: 'Legacy name', updatedAt: 1 } },
        }

        const first = normalizePluginDatabaseState(data)
        const principalId = data.plugins[0].principalId
        expect(first.pluginStateChanged).toBe(true)
        expect(isCanonicalPluginPrincipalId(principalId)).toBe(true)
        expect(data.pluginStorageMetaMigrationV2).toBe(true)
        expect(data.pluginStorageMeta.old).toEqual({
            state: 'legacy-unassociated', displayName: 'Legacy name', updatedAt: 1,
        })

        const second = normalizePluginDatabaseState(data)
        expect(second.pluginStateChanged).toBe(false)
        expect(data.plugins[0].principalId).toBe(principalId)
    })

    it('preserves a tombstoned record only until its active retirement removes it', async () => {
        clearPrincipalTombstonesForTests()
        const principalId = '77777777-7777-4777-8777-777777777777'
        const data: any = {
            plugins: [{ name: 'demo', script: 'code', principalId }],
            pluginStorageMeta: {
                asset: { state: 'principal' as const, principalId, displayName: 'Demo', updatedAt: 1 },
            },
            pluginStorageMetaMigrationV2: true,
        }
        let releaseStop!: () => void
        let markStopStarted!: () => void
        const stopGate = new Promise<void>((resolve) => { releaseStop = resolve })
        const stopStarted = new Promise<void>((resolve) => { markStopStarted = resolve })
        pluginDataLifecycle.registerInstanceStop(principalId, 'instance', async () => {
            markStopStarted()
            await stopGate
        })
        const retirement = pluginDataLifecycle.retirePrincipal(principalId, {
            invalidate: () => invalidatePluginPrincipal(principalId),
            remove: () => { data.plugins = data.plugins.filter((plugin) => plugin.principalId !== principalId) },
        })
        await stopStarted
        expect(pluginDataLifecycle.isRetirementInProgress(principalId)).toBe(true)

        normalizePluginDatabaseState(data)
        expect(data.plugins[0].principalId).toBe(principalId)
        expect(data.pluginStorageMeta.asset.state).toBe('quarantined')
        releaseStop()
        await retirement
        expect(data.plugins).toEqual([])
        expect(data.pluginStorageMeta.asset.state).toBe('quarantined')
        expect(pluginDataLifecycle.isRetirementInProgress(principalId)).toBe(false)

        const coldOldSave = { plugins: [{ name: 'demo', script: 'code', principalId }] }
        normalizePluginDatabaseState(coldOldSave)
        expect(coldOldSave.plugins[0].principalId).not.toBe(principalId)
        expect(isCanonicalPluginPrincipalId(coldOldSave.plugins[0].principalId)).toBe(true)
        clearPrincipalTombstonesForTests()
    })
})

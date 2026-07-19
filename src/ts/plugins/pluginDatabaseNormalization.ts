import { normalizePluginPrincipals, type PrincipalPluginRecord } from './pluginPrincipal'
import { reconcilePluginStorageOwners, type PluginStorageOwnerRecord } from './pluginStorageOwnership'
import { pluginDataLifecycle } from './pluginDataLifecycle'

export interface PluginDatabaseNormalizationTarget<TPlugin extends PrincipalPluginRecord = PrincipalPluginRecord> {
    plugins?: TPlugin[]
    pluginStorageMeta?: Record<string, unknown>
    pluginStorageMetaMigrationV2?: boolean
}

export function normalizePluginDatabaseState<TPlugin extends PrincipalPluginRecord>(
    data: PluginDatabaseNormalizationTarget<TPlugin>,
    isRetirementInProgress: (principalId: string) => boolean = (principalId) =>
        pluginDataLifecycle.isRetirementInProgress(principalId),
) {
    const normalizedPlugins = normalizePluginPrincipals(data.plugins ?? [], {
        preserveTombstonedPrincipal: isRetirementInProgress,
    })
    const previousMeta = data.pluginStorageMeta ?? {}
    const reconciledMeta = reconcilePluginStorageOwners(
        previousMeta,
        new Set(normalizedPlugins.records
            .map((plugin) => plugin.principalId!)
            .filter((principalId) => !!principalId && !pluginDataLifecycle.isRetiring(principalId))),
    )
    const storageChanged = data.pluginStorageMetaMigrationV2 !== true
        || JSON.stringify(previousMeta) !== JSON.stringify(reconciledMeta)
    data.plugins = normalizedPlugins.records
    data.pluginStorageMeta = reconciledMeta as Record<string, PluginStorageOwnerRecord>
    data.pluginStorageMetaMigrationV2 = true
    return { pluginStateChanged: normalizedPlugins.changed || storageChanged }
}

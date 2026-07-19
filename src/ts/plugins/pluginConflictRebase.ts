import type { toSaveType } from '../storage/risuSave'

type PluginTrackedDatabase = {
    plugins?: unknown[]
    pluginCustomStorage?: Record<string, unknown>
}

export function applyTrackedPluginStateDuringConflict<T extends PluginTrackedDatabase>(
    merged: T,
    local: PluginTrackedDatabase,
    tracked: Pick<toSaveType, 'plugins' | 'pluginCustomStorage'>,
) {
    if (tracked.plugins) merged.plugins = structuredClone(local.plugins ?? [])
    if (tracked.pluginCustomStorage) {
        merged.pluginCustomStorage = structuredClone(local.pluginCustomStorage ?? {})
    }
    return merged
}

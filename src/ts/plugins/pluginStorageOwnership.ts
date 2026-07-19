export type PluginStorageOwnerRecord =
    | { state: 'principal'; principalId: string; displayName: string; updatedAt: number }
    | { state: 'legacy-unassociated'; displayName: string; updatedAt: number }
    | { state: 'quarantined'; principalId: string; displayName: string; updatedAt: number }

export const principalOwner = (principalId: string, displayName: string, updatedAt = Date.now()): PluginStorageOwnerRecord => ({
    state: 'principal', principalId, displayName, updatedAt,
})

export function normalizePluginStorageOwner(value: unknown): PluginStorageOwnerRecord {
    if (value && typeof value === 'object') {
        const record = value as Record<string, unknown>
        const updatedAt = typeof record.updatedAt === 'number' ? record.updatedAt : 0
        const displayName = typeof record.displayName === 'string'
            ? record.displayName
            : typeof record.plugin === 'string' ? record.plugin : 'Unknown plugin'
        if ((record.state === 'principal' || record.state === 'quarantined') && isCanonicalPluginPrincipalId(record.principalId)) {
            return { state: record.state, principalId: record.principalId, displayName, updatedAt }
        }
        return { state: 'legacy-unassociated', displayName, updatedAt }
    }
    return { state: 'legacy-unassociated', displayName: 'Unknown plugin', updatedAt: 0 }
}

export function reconcilePluginStorageOwners(
    records: Record<string, unknown>,
    activePrincipalIds: ReadonlySet<string>,
): Record<string, PluginStorageOwnerRecord> {
    return Object.fromEntries(Object.entries(records).map(([key, value]) => {
        const record = normalizePluginStorageOwner(value)
        return [key, record.state === 'principal' && !activePrincipalIds.has(record.principalId)
            ? { ...record, state: 'quarantined' as const }
            : record]
    }))
}

export function quarantinePluginStorageOwners<T extends Record<string, PluginStorageOwnerRecord>>(records: T, principalId: string): T {
    return Object.fromEntries(Object.entries(records).map(([key, record]) => [key,
        record.state === 'principal' && record.principalId === principalId
            ? { ...record, state: 'quarantined' as const }
            : record,
    ])) as T
}
import { isCanonicalPluginPrincipalId } from './pluginPrincipal'

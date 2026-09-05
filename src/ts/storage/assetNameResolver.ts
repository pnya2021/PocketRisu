import type { AssetManifestDescriptor, AssetNameResolution } from './nodeStorage'

export type ResolveOwners = Array<{ manifestId: string; kind?: string; ownerId?: string; fuzzy: boolean }>
export type ResolveFn = (owners: ResolveOwners, names: string[], maxDistance: number) => Promise<AssetNameResolution>
export type AssetNameHit = { path: string; fuzzy: boolean }

const MAX_OWNER_SETS = 32
const MAX_NAMES_PER_SET = 4096

/**
 * Resolves `{{img::name}}`-style asset names against lazy asset manifests in
 * ONE server call, character manifest first, and remembers the answer.
 *
 * Why one call: the server matches every owner exactly before it tries the
 * fuzzy fallback, so an exact module asset can never lose to a fuzzy
 * near-miss on the character (v1.11.0 did character-fuzzy first, which
 * swallowed almost every module asset name on characters with many assets).
 * Hits report whether they were fuzzy so callers can keep their own exact
 * (inline) matches ahead of a fuzzy manifest match.
 *
 * Why remember: the parser runs for every message and for the background
 * embedding on each re-render. Manifest ids are content-addressed, so a
 * result for a given set of manifests never goes stale; misses are cached
 * too, keyed by the same set, so a chat-variable change does not cost a
 * round trip per message.
 */
export function createAssetNameResolver(resolve: ResolveFn) {
    const cache = new Map<string, Map<string, AssetNameHit | null>>()

    function bucket(key: string): Map<string, AssetNameHit | null> {
        let entry = cache.get(key)
        if (entry) {
            cache.delete(key)
            cache.set(key, entry)
            return entry
        }
        if (cache.size >= MAX_OWNER_SETS) cache.delete(cache.keys().next().value as string)
        entry = new Map()
        cache.set(key, entry)
        return entry
    }

    return async function resolveNames(
        characterManifest: AssetManifestDescriptor | undefined,
        moduleManifests: AssetManifestDescriptor[],
        names: string[],
        fuzzy: boolean,
        maxDistance: number,
    ): Promise<Record<string, AssetNameHit>> {
        const uniqueNames = [...new Set(names.map((name) => name.toLocaleLowerCase()))].filter((name) => name.length > 0)
        const manifests = [characterManifest, ...moduleManifests].filter((manifest): manifest is AssetManifestDescriptor => !!manifest?.id)
        const out: Record<string, AssetNameHit> = {}
        if (manifests.length === 0 || uniqueNames.length === 0) return out

        // The fuzzy distance is part of the key: a changed setting must not
        // serve near-misses computed with the old one.
        const key = (fuzzy ? `f${maxDistance}|` : 'e|') + manifests.map((manifest) => manifest.id).join('|')
        const known = bucket(key)
        const missing = uniqueNames.filter((name) => !known.has(name))
        if (missing.length > 0) {
            const owners: ResolveOwners = manifests.map((manifest) => ({
                manifestId: manifest.id,
                kind: manifest.ownerKind,
                ownerId: manifest.ownerId,
                fuzzy: fuzzy && manifest === characterManifest,
            }))
            const { resolved, fuzzy: fuzzyNames } = await resolve(owners, missing, maxDistance)
            const fuzzySet = new Set(fuzzyNames)
            for (const name of missing) {
                known.set(name, Object.hasOwn(resolved, name) ? { path: resolved[name], fuzzy: fuzzySet.has(name) } : null)
            }
            while (known.size > MAX_NAMES_PER_SET) known.delete(known.keys().next().value as string)
        }
        for (const name of uniqueNames) {
            const hit = known.get(name)
            if (hit) out[name] = hit
        }
        return out
    }
}

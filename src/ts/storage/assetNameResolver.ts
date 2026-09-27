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
    // Names already being asked for, per manifest set. A chat opening mounts
    // many messages at once and each parse asks for its own names; a name
    // another message is already resolving waits for that answer instead of
    // going out again (v1.11: one POST per visible message on a cold cache).
    const inFlight = new Map<string, Map<string, Promise<void>>>()

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
        let pending = inFlight.get(key)
        const waits = new Set<Promise<void>>()
        const missing: string[] = []
        for (const name of uniqueNames) {
            if (bucket(key).has(name)) continue
            const other = pending?.get(name)
            if (other) waits.add(other)
            else missing.push(name)
        }
        if (missing.length > 0) {
            const owners: ResolveOwners = manifests.map((manifest) => ({
                manifestId: manifest.id,
                kind: manifest.ownerKind,
                ownerId: manifest.ownerId,
                fuzzy: fuzzy && manifest === characterManifest,
            }))
            const request = (async () => {
                const { resolved, fuzzy: fuzzyNames } = await resolve(owners, missing, maxDistance)
                const fuzzySet = new Set(fuzzyNames)
                const known = bucket(key)
                for (const name of missing) {
                    known.set(name, Object.hasOwn(resolved, name) ? { path: resolved[name], fuzzy: fuzzySet.has(name) } : null)
                }
                while (known.size > MAX_NAMES_PER_SET) known.delete(known.keys().next().value as string)
            })()
            if (!pending) inFlight.set(key, (pending = new Map()))
            for (const name of missing) pending.set(name, request)
            const cleanup = () => {
                const current = inFlight.get(key)
                if (!current) return
                for (const name of missing) {
                    if (current.get(name) === request) current.delete(name)
                }
                if (current.size === 0) inFlight.delete(key)
            }
            request.then(cleanup, cleanup)
            waits.add(request)
        }
        // A failed request rejects every caller waiting on it, as before.
        await Promise.all(waits)
        const known = bucket(key)
        for (const name of uniqueNames) {
            const hit = known.get(name)
            if (hit) out[name] = hit
        }
        return out
    }
}

// Cold-cache server fallback, batched: the messages a chat opening mounts
// parse in the same task, so names asked for the same owners within one
// macrotask go out as ONE request instead of one POST per message — on a
// remote link those POSTs queued behind the six HTTP/1.1 connections with the
// chat body and images. Each caller gets the whole answer; the resolver only
// reads the names it asked for. The server rejects more than 1000 names per
// call, so a batch closes well before that.
export const RESOLVE_BATCH_MAX_NAMES = 900

export function createBatchedResolve(send: ResolveFn): ResolveFn {
    type Batch = { names: Set<string>, promise: Promise<AssetNameResolution> }
    const batches = new Map<string, Batch>()
    return (owners, names, maxDistance) => {
        const key = JSON.stringify([owners, maxDistance])
        let batch = batches.get(key)
        if (batch && batch.names.size + names.length > RESOLVE_BATCH_MAX_NAMES) batch = undefined
        if (!batch) {
            const batchNames = new Set<string>()
            const created: Batch = {
                names: batchNames,
                promise: new Promise<void>((resolve) => setTimeout(resolve, 0)).then(() => {
                    if (batches.get(key) === created) batches.delete(key)
                    return send(owners, [...batchNames], maxDistance)
                }),
            }
            batch = created
            batches.set(key, created)
        }
        for (const name of names) batch.names.add(name)
        return batch.promise
    }
}

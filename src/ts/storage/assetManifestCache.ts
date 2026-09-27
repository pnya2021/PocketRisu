import type { AssetManifestDescriptor, AssetManifestTuple } from './nodeStorage'

// Sized so a heavy setup (character + dozens of asset modules) fits without
// thrashing: entries are name→path tuples (~1MB per 5,000 assets), and the
// local name resolver serves the chat render path straight from this cache —
// an evicted manifest costs a full re-download on the next parse.
const MAX_ENTRIES = 64
const MAX_BYTES = 32 * 1024 * 1024
const fullManifestCache = new Map<string, { items: AssetManifestTuple[]; bytes: number }>()
let fullManifestCacheBytes = 0

function estimateTupleBytes(items: AssetManifestTuple[]) {
    let bytes = 0
    for (const item of items) {
        for (const value of item) bytes += (value?.length ?? 0) * 2
        bytes += 32
    }
    return bytes
}

export function cacheFullAssetManifest(id: string, items: AssetManifestTuple[]) {
    const previous = fullManifestCache.get(id)
    if (previous) fullManifestCacheBytes -= previous.bytes
    fullManifestCache.delete(id)
    const bytes = estimateTupleBytes(items)
    if (bytes > MAX_BYTES) return
    fullManifestCache.set(id, { items, bytes })
    fullManifestCacheBytes += bytes
    while (fullManifestCache.size > MAX_ENTRIES || fullManifestCacheBytes > MAX_BYTES) {
        const oldestId = fullManifestCache.keys().next().value as string | undefined
        if (!oldestId) break
        const oldest = fullManifestCache.get(oldestId)
        fullManifestCache.delete(oldestId)
        fullManifestCacheBytes -= oldest?.bytes ?? 0
    }
}

export function getCachedFullAssetManifest(id?: string): AssetManifestTuple[] | undefined {
    if (!id) return undefined
    const entry = fullManifestCache.get(id)
    if (!entry) return undefined
    fullManifestCache.delete(id)
    fullManifestCache.set(id, entry)
    return entry.items
}

// Manifest ids are content-addressed, so a cached full manifest is never
// stale: serve it instead of re-downloading every page (dynamic-asset scripts
// and the CBS list functions used to fetch the whole manifest per message on
// a cold cache). Concurrent loads of the same id share one download. Callers
// get their own copy — editors mutate the returned list, which must not leak
// into the shared cache.
export function createManifestItemsLoader(fetchItems: (manifest: AssetManifestDescriptor) => Promise<AssetManifestTuple[]>) {
    const inFlight = new Map<string, Promise<AssetManifestTuple[]>>()
    const copy = (items: AssetManifestTuple[]) => items.map((item) => [...item] as AssetManifestTuple)
    return async function loadAssetManifestItems(manifest?: AssetManifestDescriptor): Promise<AssetManifestTuple[]> {
        if (!manifest) return []
        const cached = getCachedFullAssetManifest(manifest.id)
        if (cached) return copy(cached)
        const id = manifest.id
        let load = id ? inFlight.get(id) : undefined
        if (!load) {
            load = (async () => {
                const items = await fetchItems(manifest)
                // The descriptor id can be refreshed in place by a 404 retry,
                // so cache under the id the items actually belong to.
                cacheFullAssetManifest(manifest.id, items)
                return items
            })()
            if (id) {
                const started = load
                inFlight.set(id, started)
                const clear = () => { if (inFlight.get(id) === started) inFlight.delete(id) }
                started.then(clear, clear)
            }
        }
        return copy(await load)
    }
}

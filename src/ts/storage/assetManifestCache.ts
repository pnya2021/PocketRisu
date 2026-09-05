import type { AssetManifestTuple } from './nodeStorage'

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

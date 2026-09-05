import { loadAssetManifestItems } from '../globalApi.svelte'
import { getCachedFullAssetManifest } from '../storage/assetManifestCache'
import type { character } from '../storage/database.svelte'
import type { AssetManifestDescriptor } from '../storage/nodeStorage'

type AssetFields = Pick<character, 'additionalAssets' | 'additionalAssetManifest'>

// Manifest ids are content-addressed, so a cached copy is never stale; only
// go to the server for what the cache is missing (plugins may poll).
//
// The parser's full-manifest cache holds eight entries, which is far below
// the character count getDatabase() fills, so lists handed to plugins are
// also kept here (bounded by bytes) — otherwise a plugin polling
// getDatabase() would re-fetch every character manifest on each call.
const ITEM_CACHE_LIMIT_BYTES = 64 * 1024 * 1024
const itemCache = new Map<string, { items: AssetManifestTuple[]; bytes: number }>()
let itemCacheBytes = 0

type AssetManifestTuple = readonly string[]

function cachedItems(id: string): AssetManifestTuple[] | undefined {
    const own = itemCache.get(id)
    if (own) {
        itemCache.delete(id)
        itemCache.set(id, own)
        return own.items
    }
    const parser = getCachedFullAssetManifest(id)
    // Promote a parser-cache hit: that cache is tiny and evicts fast.
    if (parser) rememberItems(id, parser)
    return parser ?? undefined
}

// Non-enumerable mark on a snapshot whose list this module filled. Survives
// in-place edits of that object; a structured/JSON clone drops it, which is
// fine because such a clone also lacks the descriptor (hydrate deleted it).
const HYDRATED = Symbol('risu.plugin.hydrated')
function markHydrated(snapshot: object, manifestId: string) {
    Object.defineProperty(snapshot, HYDRATED, { value: manifestId, enumerable: false, configurable: true, writable: true })
}

function rememberItems(id: string, items: AssetManifestTuple[]) {
    let bytes = 0
    for (const tuple of items) for (const part of tuple) bytes += part.length * 2
    if (bytes > ITEM_CACHE_LIMIT_BYTES) return
    const existing = itemCache.get(id)
    if (existing) {
        itemCache.delete(id)
        itemCacheBytes -= existing.bytes
    }
    itemCache.set(id, { items, bytes })
    itemCacheBytes += bytes
    for (const [key, entry] of itemCache) {
        if (itemCacheBytes <= ITEM_CACHE_LIMIT_BYTES) break
        itemCache.delete(key)
        itemCacheBytes -= entry.bytes
    }
}

async function manifestItems(descriptor: AssetManifestDescriptor): Promise<AssetManifestTuple[]> {
    const cached = cachedItems(descriptor.id)
    if (cached) return cached
    const items = await loadAssetManifestItems(descriptor)
    rememberItems(descriptor.id, items)
    return items
}

// Fingerprint of every list handed to a plugin, by manifest id. The
// write-back compares against this rather than the full-manifest cache,
// which is a small LRU and may have evicted the entry by the time the
// plugin writes (e.g. getDatabase() filling more than eight modules).
const HANDED_OUT_LIMIT = 4096
const handedOut = new Map<string, string>()

function fingerprint(items: readonly (readonly string[])[]): string {
    // Two independent FNV-1a passes over the joined tuples.
    let a = 0x811c9dc5, b = 0x01000193
    const text = items.map((tuple) => tuple.join('\u0000')).join('\u0001')
    for (let i = 0; i < text.length; i++) {
        const c = text.charCodeAt(i)
        a = Math.imul(a ^ c, 0x01000193)
        b = Math.imul(b ^ c, 0x2f0b4a3d) + 0x9e3779b9
    }
    return `${items.length}:${(a >>> 0).toString(16)}:${(b >>> 0).toString(16)}`
}

function rememberHandedOut(id: string, items: readonly (readonly string[])[]) {
    if (handedOut.size >= HANDED_OUT_LIMIT) handedOut.delete(handedOut.keys().next().value as string)
    handedOut.set(id, fingerprint(items))
}

// True when `incoming` is the list we handed out for `descriptor`, or, if we
// never handed it out, the list the cache still holds.
function matchesManifest(descriptor: AssetManifestDescriptor, incoming: readonly (readonly string[])[]): boolean {
    const remembered = handedOut.get(descriptor.id)
    if (remembered !== undefined) return remembered === fingerprint(incoming)
    const cached = cachedItems(descriptor.id)
    return !!cached && sameAssetTuples(cached, incoming)
}

// Resolves an incoming array against the stored descriptor. Only a list the
// plugin actually received (handed out by a hydrate) may replace the
// manifest; an edit built from the lazy shape (a sync V2 read on a cache
// miss) started from nothing, so replacing the manifest with it would drop
// every existing asset. That edit is discarded with a warning instead.
//
// "Received" means the written object carries the hydrate mark, or — for a
// plugin that cloned the snapshot before writing — the manifest was handed
// out and the write no longer carries the descriptor (hydrate removed it; a
// lazy-shape writer never knows to). handedOut alone is not enough: it is
// keyed by manifest id, and another plugin's lazy read of the same character
// must not inherit this plugin's hydrate.
type Resolution = 'restore' | 'inline' | 'discard'
function resolveIncoming(
    descriptor: AssetManifestDescriptor,
    incoming: object & { [HYDRATED]?: string },
    list: readonly (readonly string[])[],
    stillHasDescriptor: boolean,
    what: string,
): Resolution {
    if (matchesManifest(descriptor, list)) return 'restore'
    const mark = incoming[HYDRATED]
    if (mark !== undefined && mark !== descriptor.id) {
        // Hydrated from an older manifest of this owner: the list moved on
        // since the plugin read it. Keep the current list over the stale one.
        console.warn(`[plugin] ${what} asset list was written from a stale read (manifest ${mark} → ${descriptor.id}) — keeping the stored manifest, discarding the write`)
        return 'discard'
    }
    const received = mark === descriptor.id
        || (!stillHasDescriptor && handedOut.has(descriptor.id))
    if (received) return 'inline'
    console.warn(`[plugin] ${what} asset list was written from a lazy (never hydrated) read — keeping the stored manifest, discarding the write`)
    return 'discard'
}

// Manifest-backed characters keep only an `additionalAssetManifest` descriptor
// in DBState (lazy asset manifests, issue #80). Plugins predate that and read
// `additionalAssets`, so a detached snapshot handed to a plugin is filled for
// that one character. DBState itself stays lazy; only the copy changes.
//
// Takes an already-detached copy (e.g. `$state.snapshot(...)`) and fills it in
// place. A load failure leaves the copy untouched — the plugin then sees the
// same descriptor-only shape as before, never a rejected call.
export async function hydratePluginCharacterSnapshot<T extends AssetFields>(
    snapshot: T | null | undefined,
): Promise<T | null | undefined> {
    if (!snapshot) return snapshot
    if (Array.isArray(snapshot.additionalAssets) || !snapshot.additionalAssetManifest) return snapshot
    try {
        // Copy: the loader hands back the cached array instance, and a plugin
        // editing it in place must not edit the cache the write-back compares
        // against below.
        const items = await manifestItems(snapshot.additionalAssetManifest)
        rememberHandedOut(snapshot.additionalAssetManifest.id, items)
        markHydrated(snapshot, snapshot.additionalAssetManifest.id)
        snapshot.additionalAssets = items.map((tuple) => [...tuple]) as [string, string, string][]
        delete snapshot.additionalAssetManifest
    } catch (error) {
        console.warn('[plugin] failed to load character assets for plugin snapshot', error)
    }
    return snapshot
}

// Synchronous variant for the V2 API, which cannot await: fills from the
// caches only and otherwise leaves the lazy shape (a later write from that
// shape is then discarded by restorePluginCharacterManifest, not applied).
export function hydratePluginCharacterSnapshotSync<T extends AssetFields>(snapshot: T | null | undefined): T | null | undefined {
    if (!snapshot) return snapshot
    if (Array.isArray(snapshot.additionalAssets) || !snapshot.additionalAssetManifest) return snapshot
    const items = cachedItems(snapshot.additionalAssetManifest.id)
    if (!items) return snapshot
    rememberHandedOut(snapshot.additionalAssetManifest.id, items)
    markHydrated(snapshot, snapshot.additionalAssetManifest.id)
    snapshot.additionalAssets = items.map((tuple) => [...tuple]) as [string, string, string][]
    delete snapshot.additionalAssetManifest
    return snapshot
}

function sameAssetTuples(a: readonly (readonly string[])[], b: readonly (readonly string[])[]) {
    if (a.length !== b.length) return false
    for (let i = 0; i < a.length; i++) {
        const x = a[i], y = b[i]
        if (x.length !== y.length) return false
        for (let j = 0; j < x.length; j++) if (x[j] !== y[j]) return false
    }
    return true
}

// Write-back counterpart. A plugin that only edited other fields hands the
// filled array straight back; keeping the descriptor in that case means the
// write is a no-op for assets, exactly like before lazy manifests. A genuinely
// changed list is left inline and takes the same path as a character import
// (re-canonicalized into a manifest on the next cold load).
//
// An array and a descriptor must never coexist on the stored character: the
// client reads the array while the server persists the descriptor, so the
// plugin's edit would show locally and silently vanish from disk (v1.11.0
// AssetGod report). If a plugin hands both back, the array decides — see
// resolveIncoming for which of the two survives.
//
// `current` may be the very object being written (V2 getDatabase() hands out
// the live DB, and a plugin may have edited it in place before setDatabase*):
// a descriptor next to an array there is the coexistence this resolves, so
// it is not treated as "never manifest-backed".
export function restorePluginCharacterManifest<T extends AssetFields>(incoming: T, current: AssetFields | undefined): T {
    const descriptor = current?.additionalAssetManifest
    if (!incoming || !descriptor) return incoming
    if (!Array.isArray(incoming.additionalAssets)) return incoming
    const resolution = resolveIncoming(descriptor, incoming, incoming.additionalAssets, !!incoming.additionalAssetManifest, 'character')
    if (resolution === 'inline') {
        delete incoming.additionalAssetManifest
    } else {
        delete incoming.additionalAssets
        incoming.additionalAssetManifest = descriptor
    }
    return incoming
}

type ModuleAssetFields = { assets?: [string, string, string][]; assetManifest?: AssetManifestDescriptor }

// Module counterpart: modules (and a persona's embedded module) are only
// reachable through getDatabase(), so their lazy manifests are filled there.
export async function hydratePluginModuleSnapshot<T extends ModuleAssetFields>(
    snapshot: T | null | undefined,
): Promise<T | null | undefined> {
    if (!snapshot) return snapshot
    if (Array.isArray(snapshot.assets) || !snapshot.assetManifest) return snapshot
    try {
        const items = await manifestItems(snapshot.assetManifest)
        rememberHandedOut(snapshot.assetManifest.id, items)
        markHydrated(snapshot, snapshot.assetManifest.id)
        snapshot.assets = items.map((tuple) => [...tuple]) as [string, string, string][]
        delete snapshot.assetManifest
    } catch (error) {
        console.warn('[plugin] failed to load module assets for plugin snapshot', error)
    }
    return snapshot
}

// Fills every asset-carrying entry of a detached getDatabase() subset in
// place. Characters are filled too: plugins that read the database instead
// of getCharacter* (AssetGod does, to dodge structured-clone errors) otherwise
// see every manifest-backed character with no assets at all, and any edit
// they save from that view replaces the real list with just the new items.
export async function hydratePluginDatabaseSnapshot(subset: {
    characters?: AssetFields[]
    modules?: ModuleAssetFields[]
    personas?: { embeddedModule?: ModuleAssetFields }[]
}): Promise<void> {
    const modules = [
        ...(Array.isArray(subset.modules) ? subset.modules : []),
        ...(Array.isArray(subset.personas) ? subset.personas.map((persona) => persona?.embeddedModule) : []),
    ]
    const characters = Array.isArray(subset.characters) ? subset.characters : []
    await Promise.all([
        ...modules.map((module) => hydratePluginModuleSnapshot(module)),
        ...characters.map((character) => hydratePluginCharacterSnapshot(character)),
    ])
}

// Write-back counterpart for module-shaped entries. A plugin that round-trips
// getDatabase() → setDatabase() hands every filled `assets` array straight
// back; matching entries whose list still equals the cached manifest get
// their descriptor back so the write is a no-op for assets.
function restoreModuleManifest<T extends ModuleAssetFields>(incoming: T, current: ModuleAssetFields | undefined): T {
    const descriptor = current?.assetManifest
    if (!incoming || !descriptor) return incoming
    if (!Array.isArray(incoming.assets)) return incoming
    // Same array-vs-descriptor rule as restorePluginCharacterManifest.
    const resolution = resolveIncoming(descriptor, incoming, incoming.assets, !!incoming.assetManifest, 'module')
    if (resolution === 'inline') {
        delete incoming.assetManifest
    } else {
        delete incoming.assets
        incoming.assetManifest = descriptor
    }
    return incoming
}

type PluginDbValue = unknown

// Applies the write-back restore to a top-level DB key a plugin is writing.
// Characters match by chaId only (a positional fallback could pin a stranger's
// manifest onto a new or reordered character), modules by id, personas by id
// falling back to position. Any other key is returned untouched.
export function restorePluginDbKey(key: string, value: PluginDbValue, currentDb: { characters?: any[]; modules?: any[]; personas?: any[] } | undefined): PluginDbValue {
    if (!Array.isArray(value) || !currentDb) return value
    if (key === 'characters') {
        const byId = new Map((currentDb.characters ?? []).map((character) => [character?.chaId, character]))
        for (const character of value) {
            if (!character || character.chaId === undefined) continue
            restorePluginCharacterManifest(character, byId.get(character.chaId))
        }
    } else if (key === 'modules') {
        const byId = new Map((currentDb.modules ?? []).map((module) => [module?.id, module]))
        for (const module of value) {
            if (module) restoreModuleManifest(module, byId.get(module.id))
        }
    } else if (key === 'personas') {
        const byId = new Map((currentDb.personas ?? []).map((persona) => [persona?.id, persona]))
        value.forEach((persona, index) => {
            const current = (persona?.id !== undefined ? byId.get(persona.id) : undefined) ?? currentDb.personas?.[index]
            if (persona?.embeddedModule && current?.embeddedModule) {
                restoreModuleManifest(persona.embeddedModule, current.embeddedModule)
            }
        })
    }
    return value
}

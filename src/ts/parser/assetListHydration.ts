import { loadAssetManifestItems } from '../globalApi.svelte'
import { getModules } from '../process/modules'
import { getCachedFullAssetManifest } from '../storage/assetManifestCache'
import type { AssetManifestDescriptor } from '../storage/nodeStorage'

// CBS list functions ({{assetlist}}, {{chardisplayasset}}, {{moduleassetlist}})
// are synchronous and read the bounded full-manifest cache. Anything that is
// about to run the synchronous parser must first load the manifests those
// tokens need — otherwise the call sees an empty cache and the token is left
// unexpanded (issue #82).
//
// Mirrors the matcher's name normalization (case-insensitive, `[\s_-]`
// stripped) and both `:` / `::` argument separators, so every spelling the
// parser accepts is detected here.
const ASSET_LIST_CBS = /\{\{\s*(?:asset[\s_-]*list|char[\s_-]*display[\s_-]*asset|module[\s_-]*asset[\s_-]*list)\s*(?::|\}\})/i

// Serialize a bundle of prompt sources (strings, lorebooks, templates …) into
// one scannable string. JSON turns a newline/tab inside a token name into a
// two-character escape that `[\s_-]*` would not match, so those escapes are
// folded back to a space; no other escape can hide `{{`.
export function serializeForCbsScan(values: readonly unknown[]): string {
    return JSON.stringify(values).replace(/\\[ntr]/g, ' ')
}

export function mentionsAssetListCbs(texts: readonly (string | null | undefined)[]): boolean {
    return texts.some((text) => typeof text === 'string' && ASSET_LIST_CBS.test(text))
}

// `texts` is everything that can reach the parser in this pass: the message
// itself plus the templates of scripts that may rewrite it (a display script
// can introduce a list token that the original message never contained).
export async function hydrateAssetListsForCbs(
    char: { additionalAssetManifest?: AssetManifestDescriptor } | null | undefined,
    texts: readonly (string | null | undefined)[],
): Promise<void> {
    if (!mentionsAssetListCbs(texts)) return
    const manifests = getModules()
        .map((module) => module?.assetManifest)
        .filter((manifest): manifest is AssetManifestDescriptor => !!manifest)
    if (char?.additionalAssetManifest) manifests.push(char.additionalAssetManifest)
    // Manifest ids are content-addressed, so a cache hit is never stale — skip
    // the round trip for those and only fetch what the cache is missing.
    const missing = manifests.filter((manifest) => !getCachedFullAssetManifest(manifest.id))
    if (missing.length === 0) return
    try {
        await Promise.all(missing.map((manifest) => loadAssetManifestItems(manifest)))
    } catch (error) {
        // Degrade to the unexpanded token rather than failing the whole render.
        console.warn('[cbs] failed to load asset manifests for list functions', error)
    }
}

import { getCachedFullAssetManifest } from './assetManifestCache'
import type { AssetManifestTuple, AssetNameResolution } from './nodeStorage'
import type { ResolveOwners } from './assetNameResolver'

// Client-side mirror of the server's resolveNames (assetManifestStore.cjs).
//
// v1.11 made the first paint of a chat message wait on a
// POST /api/asset-manifests/resolve round trip; over a remote link
// (Tailscale/mobile, the fork's primary usage pattern) that wait is what
// users see as "the message arrived but stays blank". When every referenced
// manifest is already in the full-manifest cache (prefetched at chat entry),
// the same matching runs here in microseconds and the render path touches no
// network at all — the v1.10 behavior.
//
// Because this duplicates server logic, the matching rules below are copied
// verbatim and pinned by tests that replicate the server suite's priority
// scenarios (assetManifestStore.test.ts "resolveNames priority"). If one
// side changes, change the other and both test files.

// Mirrors trimmer() in the parser and trimAssetName() on the server.
const TRIMMED_EXTENSIONS = ['webp', 'png', 'jpg', 'jpeg', 'gif', 'mp4', 'webm', 'avi', 'm4p', 'm4v', 'mp3', 'wav', 'ogg']
export function trimAssetName(str: string): string {
    for (const ext of TRIMMED_EXTENSIONS) {
        if (str.endsWith('.' + ext)) {
            str = str.substring(0, str.length - ext.length - 1)
        }
    }
    // The character class is copied verbatim from the client parser: ` -.` is
    // a range, so separators like "_", " ", "-" and "." all collapse away.
    return str.trim().replace(/[_ -.]/g, '')
}

// Levenshtein, mirroring stringDistance() on the server. Not imported from
// parser.svelte.ts to keep this module dependency-free (the parser imports
// globalApi, which imports this file).
function stringDistance(a: string, b: string): number {
    if (a === b) return 0
    if (!a.length) return b.length
    if (!b.length) return a.length
    let previous = Array.from({ length: b.length + 1 }, (_, i) => i)
    for (let i = 1; i <= a.length; i++) {
        const current = [i]
        for (let j = 1; j <= b.length; j++) {
            current[j] = Math.min(
                current[j - 1] + 1,
                previous[j] + 1,
                previous[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1),
            )
        }
        previous = current
    }
    return previous[b.length]
}

/**
 * Resolve asset names against the cached full manifests, with the server's
 * exact-before-fuzzy owner priority. Returns null when any owner's manifest
 * is not in the cache — the caller must then fall back to the server route
 * (and prefetch, so the next call resolves locally).
 */
export function resolveNamesLocally(
    owners: ResolveOwners,
    names: string[],
    maxDistance: number,
): AssetNameResolution | null {
    const wanted = new Set(names.map((name) => String(name).toLocaleLowerCase()))
    // Asset names are imported data. A null-prototype result keeps names
    // such as "__proto__" and "constructor" as ordinary lookup keys.
    const resolved: Record<string, string> = Object.create(null)
    const fuzzy: string[] = []
    // Like the server: an empty name set resolves to empty before any owner
    // is consulted (so an uncached manifest does not force a fallback).
    if (wanted.size === 0) return { resolved, fuzzy }

    // Known limitation vs the server route: the server falls back to the
    // owner's live descriptor when the requested revision was pruned (edited
    // from another session). This cache serves the revision the client's DB
    // currently references; when that descriptor syncs, its content-addressed
    // id changes and resolution self-heals. Re-validating here would put the
    // round trip back on the render path, defeating this module's purpose.
    const loadedOwners: Array<{ items: AssetManifestTuple[]; fuzzy: boolean }> = []
    for (const owner of owners) {
        const items = getCachedFullAssetManifest(owner.manifestId)
        if (!items) return null
        loadedOwners.push({ items, fuzzy: owner.fuzzy !== false })
    }

    // Exact pass: every owner, in priority order, before any fuzzy fallback.
    for (const loaded of loadedOwners) {
        for (const item of loaded.items) {
            const key = item[0].toLocaleLowerCase()
            if (wanted.has(key) && !Object.hasOwn(resolved, key)) resolved[key] = item[1]
        }
        if (Object.keys(resolved).length >= wanted.size) break
    }

    // Legacy fuzzy fallback, only for exact misses and fuzzy owners.
    const distanceCeiling = Math.max(0, Math.trunc(Number(maxDistance) || 0))
    for (const name of wanted) {
        if (Object.hasOwn(resolved, name)) continue
        const trimmedName = trimAssetName(name)
        let bestDistance = Number.POSITIVE_INFINITY
        let bestPath = ''
        for (const loaded of loadedOwners) {
            if (!loaded.fuzzy) continue
            for (const item of loaded.items) {
                const candidate = trimAssetName(item[0].toLocaleLowerCase())
                // Length difference is a lower bound on edit distance.
                if (Math.abs(candidate.length - trimmedName.length) > distanceCeiling) continue
                const distance = stringDistance(trimmedName, candidate)
                if (distance < bestDistance) {
                    bestDistance = distance
                    bestPath = item[1]
                }
            }
        }
        if (bestPath && bestDistance <= distanceCeiling) {
            resolved[name] = bestPath
            fuzzy.push(name)
        }
    }
    return { resolved, fuzzy }
}

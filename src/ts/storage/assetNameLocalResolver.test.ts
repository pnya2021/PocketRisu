import { describe, it, expect } from 'vitest'
import { resolveNamesLocally, trimAssetName } from './assetNameLocalResolver'
import { cacheFullAssetManifest } from './assetManifestCache'
import type { ResolveOwners } from './assetNameResolver'
import type { AssetManifestTuple } from './nodeStorage'

// This resolver mirrors the server's resolveNames (assetManifestStore.cjs)
// so chat renders can match names without a round trip. The scenarios below
// replicate the server suite's "resolveNames priority" cases — if these two
// files ever disagree, the client and server have drifted apart.

let nextId = 0
function seedManifest(items: AssetManifestTuple[]): string {
    const id = `manifest-${nextId++}`
    cacheFullAssetManifest(id, items)
    return id
}

const CHAR_ITEMS: AssetManifestTuple[] = [
    ['bg-01', 'assets/char-bg-01', 'png'],
    ['평온', 'assets/char-calm', 'png'],
]
const MODULE_ITEMS: AssetManifestTuple[] = [
    ['bg-fog', 'assets/mod-bg-fog', 'webp'],
    ['평정', 'assets/mod-composure', 'png'],
]

function seededOwners(): ResolveOwners {
    return [
        { manifestId: seedManifest(CHAR_ITEMS), fuzzy: true },
        { manifestId: seedManifest(MODULE_ITEMS), fuzzy: false },
    ]
}

describe('resolveNamesLocally priority (mirror of the server suite)', () => {
    it('an exact module asset is not shadowed by a fuzzy near-miss on the character', () => {
        const owners = seededOwners()
        // Both names are within edit distance 4 of a character asset, but
        // the module holds them exactly: exact wins across every owner.
        expect(resolveNamesLocally(owners, ['bg-fog', '평정'], 4)).toEqual({
            resolved: { 'bg-fog': 'assets/mod-bg-fog', '평정': 'assets/mod-composure' },
            fuzzy: [],
        })
    })

    it('a name nobody holds falls back to the character fuzzy match and is reported as fuzzy', () => {
        const owners = seededOwners()
        const result = resolveNamesLocally(owners, ['bg-02', 'bg-fog'], 4)!
        expect(result.resolved).toEqual({
            'bg-02': 'assets/char-bg-01',
            'bg-fog': 'assets/mod-bg-fog',
        })
        expect(result.fuzzy).toEqual(['bg-02'])
    })

    it('respects the fuzzy distance ceiling', () => {
        const owners = seededOwners()
        expect(resolveNamesLocally(owners, ['completely-different'], 4)!.resolved).toEqual({})
        expect(resolveNamesLocally(owners, ['bg-02'], 0)!.resolved).toEqual({})
    })

    it('trims extensions and separators before scoring, like the parser trimmer', () => {
        expect(trimAssetName('bg_01 v2.png')).toBe('bg01v2')
        const owners: ResolveOwners = [{ manifestId: seedManifest([['bg-01.png', 'assets/a', 'png']]), fuzzy: true }]
        // 'bg01' vs trimmed 'bg01' → distance 0.
        expect(resolveNamesLocally(owners, ['bg 01'], 0)!.resolved).toEqual({ 'bg 01': 'assets/a' })
    })

    it('keeps dangerous names as plain lookup keys', () => {
        const owners: ResolveOwners = [{ manifestId: seedManifest([['__proto__', 'assets/p', 'png']]), fuzzy: true }]
        const result = resolveNamesLocally(owners, ['__proto__'], 0)!
        expect(result.resolved['__proto__']).toBe('assets/p')
        expect(Object.getPrototypeOf(result.resolved)).toBeNull()
    })

    it('returns null when any owner manifest is not cached — caller must use the server', () => {
        const owners: ResolveOwners = [
            { manifestId: seedManifest(CHAR_ITEMS), fuzzy: true },
            { manifestId: 'never-cached', fuzzy: false },
        ]
        expect(resolveNamesLocally(owners, ['bg-01'], 4)).toBeNull()
    })

    it('empty name set resolves to empty without touching manifests', () => {
        const owners = seededOwners()
        expect(resolveNamesLocally(owners, [], 4)).toEqual({ resolved: {}, fuzzy: [] })
        // Like the server, even an uncached owner is never consulted for an
        // empty set — no fallback is forced.
        expect(resolveNamesLocally([{ manifestId: 'never-cached', fuzzy: true }], [], 4)).toEqual({ resolved: {}, fuzzy: [] })
    })
})

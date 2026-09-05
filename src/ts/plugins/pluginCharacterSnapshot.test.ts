import { describe, test, expect, vi, beforeEach } from 'vitest'

// Issue #80: plugin reads of manifest-backed characters must return the
// pre-manifest shape (plain `additionalAssets`, no descriptor) for the one
// character requested, and must never reject on a load failure.
const loadAssetManifestItems = vi.fn()
vi.mock('../globalApi.svelte', () => ({
    loadAssetManifestItems: (...args: any[]) => loadAssetManifestItems(...args),
}))

const cacheMod = await import('../storage/assetManifestCache')
const { hydratePluginCharacterSnapshot, hydratePluginCharacterSnapshotSync, restorePluginCharacterManifest, hydratePluginDatabaseSnapshot, hydratePluginModuleSnapshot, restorePluginDbKey } = await import('./pluginCharacterSnapshot')

const descriptor = { id: 'm1', ownerKind: 'character', ownerId: 'c1', count: 2 } as any
const items: [string, string, string][] = [['smile', 'key-a', 'png'], ['angry', 'key-b', 'png']]

beforeEach(() => {
    loadAssetManifestItems.mockReset()
    loadAssetManifestItems.mockResolvedValue(items)
})

describe('hydratePluginCharacterSnapshot', () => {
    test('fills additionalAssets from the manifest and drops the descriptor', async () => {
        const snap: any = { name: 'a', additionalAssetManifest: descriptor }
        const out: any = await hydratePluginCharacterSnapshot(snap)
        expect(out).toBe(snap)
        expect(out.additionalAssets).toEqual(items)
        expect(out.additionalAssetManifest).toBeUndefined()
        expect(loadAssetManifestItems).toHaveBeenCalledWith(descriptor)
    })

    test('leaves a character that already carries additionalAssets untouched', async () => {
        const inline: [string, string, string][] = [['x', 'k', 'png']]
        const snap: any = { additionalAssets: inline, additionalAssetManifest: descriptor }
        const out: any = await hydratePluginCharacterSnapshot(snap)
        expect(out.additionalAssets).toBe(inline)
        expect(out.additionalAssetManifest).toBe(descriptor)
        expect(loadAssetManifestItems).not.toHaveBeenCalled()
    })

    test('does nothing for a character without a manifest', async () => {
        const snap: any = { name: 'plain' }
        expect(await hydratePluginCharacterSnapshot(snap)).toEqual({ name: 'plain' })
        expect(loadAssetManifestItems).not.toHaveBeenCalled()
    })

    test('passes null and undefined through', async () => {
        expect(await hydratePluginCharacterSnapshot(null)).toBeNull()
        expect(await hydratePluginCharacterSnapshot(undefined)).toBeUndefined()
    })

    test('keeps the descriptor-only shape instead of rejecting when the load fails', async () => {
        loadAssetManifestItems.mockRejectedValue(new Error('offline'))
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
        // A fresh id: lists handed out earlier stay in the plugin item cache.
        const uncached = { ...descriptor, id: 'load-fails' }
        const snap: any = { additionalAssetManifest: uncached }
        const out: any = await hydratePluginCharacterSnapshot(snap)
        expect(out.additionalAssets).toBeUndefined()
        expect(out.additionalAssetManifest).toBe(uncached)
        expect(warn).toHaveBeenCalled()
        warn.mockRestore()
    })
})

describe('restorePluginCharacterManifest', () => {
    const current = { additionalAssetManifest: descriptor } as any

    test('restores the descriptor when the written array matches the cached manifest', () => {
        cacheMod.cacheFullAssetManifest(descriptor.id, items.map((t) => [...t] as [string, string, string]))
        const incoming: any = { name: 'renamed', additionalAssets: items.map((t) => [...t]) }
        const out = restorePluginCharacterManifest(incoming, current)
        expect(out.additionalAssets).toBeUndefined()
        expect(out.additionalAssetManifest).toBe(descriptor)
        expect(out.name).toBe('renamed')
    })

    test('keeps a changed array inline once the list was handed out', async () => {
        await hydratePluginCharacterSnapshot({ additionalAssetManifest: descriptor } as any)
        const changed = [...items, ['new', 'key-c', 'png']]
        const out: any = restorePluginCharacterManifest({ additionalAssets: changed } as any, current)
        expect(out.additionalAssets).toBe(changed)
        expect(out.additionalAssetManifest).toBeUndefined()
    })

    test('a write for a manifest that was never handed out keeps the manifest', () => {
        cacheMod.cacheFullAssetManifest('other', [])
        const evicted = { ...descriptor, id: 'evicted' }
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
        const out: any = restorePluginCharacterManifest({ additionalAssets: items } as any, { additionalAssetManifest: evicted } as any)
        expect(out.additionalAssets).toBeUndefined()
        expect(out.additionalAssetManifest).toBe(evicted)
        warn.mockRestore()
    })

    test('does not touch writes for characters that were never manifest-backed', () => {
        const incoming: any = { additionalAssets: items }
        expect(restorePluginCharacterManifest(incoming, { additionalAssets: items } as any)).toBe(incoming)
        expect(incoming.additionalAssetManifest).toBeUndefined()
        expect(restorePluginCharacterManifest(incoming, undefined)).toBe(incoming)
    })

    test('a write carrying both the descriptor and the untouched array keeps only the descriptor', () => {
        cacheMod.cacheFullAssetManifest(descriptor.id, items)
        const incoming: any = { additionalAssetManifest: descriptor, additionalAssets: items.map((t) => [...t]) }
        expect(restorePluginCharacterManifest(incoming, current)).toBe(incoming)
        expect(incoming.additionalAssets).toBeUndefined()
        expect(incoming.additionalAssetManifest).toBe(descriptor)
    })

    test('an in-place edit of the hydrated snapshot wins (AssetGod v1.11.0 report)', async () => {
        const snap: any = await hydratePluginCharacterSnapshot({ additionalAssetManifest: descriptor } as any)
        snap.additionalAssets = [['new', 'key-c', 'png']]
        expect(restorePluginCharacterManifest(snap, current)).toBe(snap)
        expect(snap.additionalAssets).toEqual([['new', 'key-c', 'png']])
        expect(snap.additionalAssetManifest).toBeUndefined()
    })

    test('a JSON clone of the hydrated snapshot (no descriptor) is still honoured', async () => {
        const snap: any = await hydratePluginCharacterSnapshot({ additionalAssetManifest: descriptor } as any)
        const clone = JSON.parse(JSON.stringify(snap))
        clone.additionalAssets.push(['new', 'key-c', 'png'])
        restorePluginCharacterManifest(clone, current)
        expect(clone.additionalAssets).toHaveLength(items.length + 1)
        expect(clone.additionalAssetManifest).toBeUndefined()
    })

    test("another plugin's lazy write (descriptor still present) is discarded even after a hydrate elsewhere", async () => {
        // Plugin A hydrated the list; plugin B's sync read missed the cache,
        // kept the descriptor and started from []. B's write must not replace
        // the list just because A had it handed out.
        await hydratePluginCharacterSnapshot({ additionalAssetManifest: descriptor } as any)
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
        const lazyWrite: any = { additionalAssetManifest: descriptor, additionalAssets: [['only', 'key-z', 'png']] }
        restorePluginCharacterManifest(lazyWrite, current)
        expect(lazyWrite.additionalAssets).toBeUndefined()
        expect(lazyWrite.additionalAssetManifest).toBe(descriptor)
        expect(warn).toHaveBeenCalled()
        warn.mockRestore()
    })

    test('an edit built from a never-hydrated (lazy) read is discarded, keeping the manifest', () => {
        // A sync V2 read on a cache miss sees no assets; a write from that
        // shape must not replace the whole list with the plugin's few items.
        const lazy = { ...descriptor, id: 'never-handed-out' }
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
        const incoming: any = { additionalAssetManifest: lazy, additionalAssets: [['only', 'key-z', 'png']] }
        restorePluginCharacterManifest(incoming, { additionalAssetManifest: lazy } as any)
        expect(incoming.additionalAssets).toBeUndefined()
        expect(incoming.additionalAssetManifest).toBe(lazy)
        expect(warn).toHaveBeenCalled()
        warn.mockRestore()
    })

    test('the sync hydrate fills from cache and otherwise leaves the lazy shape', async () => {
        const miss = { ...descriptor, id: 'sync-miss' }
        const lazy: any = hydratePluginCharacterSnapshotSync({ additionalAssetManifest: miss } as any)
        expect(lazy.additionalAssets).toBeUndefined()
        expect(lazy.additionalAssetManifest).toBe(miss)

        await hydratePluginCharacterSnapshot({ additionalAssetManifest: miss } as any)
        const hit: any = hydratePluginCharacterSnapshotSync({ additionalAssetManifest: miss } as any)
        expect(hit.additionalAssets).toEqual(items)
        expect(hit.additionalAssetManifest).toBeUndefined()
        // Handed out by the sync read → a later edit from it is honoured.
        const out: any = restorePluginCharacterManifest({ additionalAssets: [['x', 'k', 'png']] } as any, { additionalAssetManifest: miss } as any)
        expect(out.additionalAssetManifest).toBeUndefined()
    })

    test('a stale hydrated object (older manifest) does not overwrite the current list', async () => {
        const older = { ...descriptor, id: 'rev-1' }
        const newer = { ...descriptor, id: 'rev-2' }
        const stale: any = await hydratePluginCharacterSnapshot({ additionalAssetManifest: older } as any)
        await hydratePluginCharacterSnapshot({ additionalAssetManifest: newer } as any) // someone else read rev-2
        stale.additionalAssets.push(['late', 'key-l', 'png'])
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
        restorePluginCharacterManifest(stale, { additionalAssetManifest: newer } as any)
        expect(stale.additionalAssets).toBeUndefined()
        expect(stale.additionalAssetManifest).toBe(newer)
        warn.mockRestore()
    })

    test('an in-place lazy edit of the live object (V2 getDatabase proxy) is resolved when written back', () => {
        const live: any = { chaId: 'c1', additionalAssetManifest: descriptor }
        live.additionalAssets ??= []
        live.additionalAssets.push(['only', 'key-z', 'png'])
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
        restorePluginDbKey('characters', [live], { characters: [live] })
        expect(live.additionalAssets).toBeUndefined()
        expect(live.additionalAssetManifest).toBe(descriptor)
        warn.mockRestore()
    })

    test('leaves a write that already carries a descriptor alone', () => {
        const incoming: any = { additionalAssetManifest: descriptor }
        expect(restorePluginCharacterManifest(incoming, current)).toBe(incoming)
        expect(incoming.additionalAssets).toBeUndefined()
    })
})

describe('read-modify-write round trip', () => {
    test('an in-place edit of the returned array is treated as a change, not masked by cache aliasing', async () => {
        const shared = items.map((t) => [...t] as [string, string, string])
        loadAssetManifestItems.mockImplementation(async () => {
            cacheMod.cacheFullAssetManifest(descriptor.id, shared)
            return shared
        })
        const snap: any = await hydratePluginCharacterSnapshot({ additionalAssetManifest: descriptor } as any)
        expect(snap.additionalAssets).not.toBe(shared)

        snap.additionalAssets.push(['new', 'key-c', 'png'])
        snap.additionalAssets[0][0] = 'renamed'
        const out: any = restorePluginCharacterManifest(snap, { additionalAssetManifest: descriptor } as any)
        expect(out.additionalAssetManifest).toBeUndefined()
        expect(out.additionalAssets).toHaveLength(3)
        expect(cacheMod.getCachedFullAssetManifest(descriptor.id)).toEqual(items)
    })

    test('an untouched round trip restores the descriptor', async () => {
        loadAssetManifestItems.mockImplementation(async () => {
            cacheMod.cacheFullAssetManifest(descriptor.id, items)
            return items
        })
        const snap: any = await hydratePluginCharacterSnapshot({ name: 'x', additionalAssetManifest: descriptor } as any)
        snap.name = 'y'
        const out: any = restorePluginCharacterManifest(snap, { additionalAssetManifest: descriptor } as any)
        expect(out.additionalAssetManifest).toBe(descriptor)
        expect(out.additionalAssets).toBeUndefined()
    })
})

describe('hydratePluginDatabaseSnapshot', () => {
    const moduleManifest = { id: 'mod-1', ownerKind: 'module', ownerId: 'm1' } as any

    test('fills module, persona embedded-module and character assets', async () => {
        const subset: any = {
            modules: [{ name: 'm', assetManifest: moduleManifest }, { name: 'inline', assets: [['x', 'k', 'png']] }],
            personas: [{ name: 'p', embeddedModule: { assetManifest: moduleManifest } }, { name: 'plain' }],
            characters: [{ additionalAssetManifest: descriptor }],
        }
        await hydratePluginDatabaseSnapshot(subset)
        expect(subset.modules[0].assets).toEqual(items)
        expect(subset.modules[0].assetManifest).toBeUndefined()
        expect(subset.modules[1].assets).toEqual([['x', 'k', 'png']])
        expect(subset.personas[0].embeddedModule.assets).toEqual(items)
        expect(subset.personas[0].embeddedModule.assetManifest).toBeUndefined()
        expect(subset.characters[0].additionalAssets).toEqual(items)
        expect(subset.characters[0].additionalAssetManifest).toBeUndefined()
        // The character manifest may already sit in the shared full-manifest
        // cache from earlier tests; the module manifest is loaded twice here.
        expect(loadAssetManifestItems).toHaveBeenCalledWith(moduleManifest)
    })

    test('tolerates subsets without modules or personas', async () => {
        await expect(hydratePluginDatabaseSnapshot({})).resolves.toBeUndefined()
        await expect(hydratePluginDatabaseSnapshot({ modules: undefined, personas: [{}] } as any)).resolves.toBeUndefined()
        expect(loadAssetManifestItems).not.toHaveBeenCalled()
    })

    test('a failed module load keeps the descriptor and hands back a copy of the tuples otherwise', async () => {
        loadAssetManifestItems.mockRejectedValueOnce(new Error('offline'))
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
        const uncached = { ...moduleManifest, id: 'mod-load-fails' }
        const failed: any = await hydratePluginModuleSnapshot({ assetManifest: uncached } as any)
        expect(failed.assets).toBeUndefined()
        expect(failed.assetManifest).toBe(uncached)
        warn.mockRestore()

        const ok: any = await hydratePluginModuleSnapshot({ assetManifest: uncached } as any)
        expect(ok.assets).toEqual(items)
        expect(ok.assets).not.toBe(items)
    })
})

describe('cache-first manifest lookup', () => {
    test('a cached manifest is served without a server round trip, as a copy', async () => {
        const cachedDescriptor = { ...descriptor, id: 'cached-char' }
        const cachedItems: [string, string, string][] = [['c', 'k', 'png']]
        cacheMod.cacheFullAssetManifest(cachedDescriptor.id, cachedItems)
        const snap: any = await hydratePluginCharacterSnapshot({ additionalAssetManifest: cachedDescriptor } as any)
        expect(snap.additionalAssets).toEqual(cachedItems)
        expect(snap.additionalAssets).not.toBe(cachedItems)
        expect(loadAssetManifestItems).not.toHaveBeenCalled()

        const mod: any = await hydratePluginModuleSnapshot({ assetManifest: { ...cachedDescriptor, ownerKind: 'module' } } as any)
        expect(mod.assets).toEqual(cachedItems)
        expect(loadAssetManifestItems).not.toHaveBeenCalled()
    })
})

describe('restorePluginDbKey', () => {
    const moduleManifest = { id: 'mod-rt', ownerKind: 'module', ownerId: 'm1' } as any
    const current = {
        characters: [{ chaId: 'c1', additionalAssetManifest: descriptor }, { chaId: 'c2', additionalAssets: [['x', 'k', 'png']] }],
        modules: [{ id: 'm1', assetManifest: moduleManifest }, { id: 'm2', assets: [['x', 'k', 'png']] }],
        personas: [{ id: 'p1', embeddedModule: { assetManifest: moduleManifest } }],
    }

    test('a characters round trip through setDatabase() restores manifests by chaId', () => {
        cacheMod.cacheFullAssetManifest(descriptor.id, items)
        const characters: any = [
            { chaId: 'c2', additionalAssets: [['x', 'k', 'png']] },
            { chaId: 'c1', additionalAssets: items.map((t) => [...t]) },
            { chaId: 'new', additionalAssets: [['n', 'k', 'png']] },
        ]
        restorePluginDbKey('characters', characters, current)
        expect(characters[1].additionalAssetManifest).toBe(descriptor)
        expect(characters[1].additionalAssets).toBeUndefined()
        expect(characters[0].additionalAssets).toEqual([['x', 'k', 'png']])
        expect(characters[2].additionalAssets).toEqual([['n', 'k', 'png']])
    })

    test('an untouched getDatabase() → setDatabase() round trip keeps module and persona manifests', () => {
        cacheMod.cacheFullAssetManifest(moduleManifest.id, items)
        const modules: any = [{ id: 'm1', assets: items.map((t) => [...t]) }, { id: 'm2', assets: [['x', 'k', 'png']] }, { id: 'new', assets: [['n', 'k', 'png']] }]
        const out: any = restorePluginDbKey('modules', modules, current)
        expect(out[0].assetManifest).toBe(moduleManifest)
        expect(out[0].assets).toBeUndefined()
        expect(out[1].assets).toEqual([['x', 'k', 'png']])
        expect(out[2].assets).toEqual([['n', 'k', 'png']])

        const personas: any = [{ id: 'p1', embeddedModule: { assets: items.map((t) => [...t]) } }]
        restorePluginDbKey('personas', personas, current)
        expect(personas[0].embeddedModule.assetManifest).toBe(moduleManifest)
        expect(personas[0].embeddedModule.assets).toBeUndefined()
    })

    test('a changed module asset list stays inline once the list was handed out', async () => {
        await hydratePluginModuleSnapshot({ assetManifest: moduleManifest } as any)
        const modules: any = [{ id: 'm1', assets: [...items, ['extra', 'k', 'png']] }]
        restorePluginDbKey('modules', modules, current)
        expect(modules[0].assetManifest).toBeUndefined()
        expect(modules[0].assets).toHaveLength(3)
    })

    test('personas without an id match by position; other keys pass through', () => {
        cacheMod.cacheFullAssetManifest(moduleManifest.id, items)
        const personas: any = [{ embeddedModule: { assets: items.map((t) => [...t]) } }]
        restorePluginDbKey('personas', personas, current)
        expect(personas[0].embeddedModule.assetManifest).toBe(moduleManifest)
        const chars = [{ additionalAssets: items }]
        expect(restorePluginDbKey('characters', chars, current)).toBe(chars)
        expect(restorePluginDbKey('modules', 'not-an-array', current)).toBe('not-an-array')
    })
})

describe('write-back survives full-manifest cache eviction', () => {
    test('a list handed out through getDatabase() is restored even after the LRU dropped it', async () => {
        const manifests = Array.from({ length: 70 }, (_, i) => ({ id: `evict-${i}`, ownerKind: 'module', ownerId: `m${i}` } as any))
        loadAssetManifestItems.mockImplementation(async (m: any) => {
            const list: [string, string, string][] = [[`a${m.id}`, 'k', 'png']]
            cacheMod.cacheFullAssetManifest(m.id, list)
            return list
        })
        const subset: any = { modules: manifests.map((assetManifest, i) => ({ id: `m${i}`, assetManifest })) }
        await hydratePluginDatabaseSnapshot(subset)
        // The first manifest is gone from the 64-entry LRU by now.
        expect(cacheMod.getCachedFullAssetManifest('evict-0')).toBeUndefined()

        const current = { modules: manifests.map((assetManifest, i) => ({ id: `m${i}`, assetManifest })) }
        restorePluginDbKey('modules', subset.modules, current)
        for (let i = 0; i < 70; i++) {
            expect(subset.modules[i].assetManifest).toBe(manifests[i])
            expect(subset.modules[i].assets).toBeUndefined()
        }
    })

    test('an edited list is still detected as a change without the cache', async () => {
        const manifest = { id: 'evict-edit', ownerKind: 'character', ownerId: 'c' } as any
        loadAssetManifestItems.mockResolvedValue([['a', 'k', 'png']])
        const snap: any = await hydratePluginCharacterSnapshot({ additionalAssetManifest: manifest } as any)
        for (let i = 0; i < 64; i++) cacheMod.cacheFullAssetManifest(`filler-${i}`, [])
        snap.additionalAssets[0][0] = 'renamed'
        const out: any = restorePluginCharacterManifest(snap, { additionalAssetManifest: manifest } as any)
        expect(out.additionalAssetManifest).toBeUndefined()
        expect(out.additionalAssets[0][0]).toBe('renamed')
    })
})

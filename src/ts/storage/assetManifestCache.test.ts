import { describe, expect, test, vi } from 'vitest'
import { createManifestItemsLoader, getCachedFullAssetManifest } from './assetManifestCache'

const tuples = (n: number) => Array.from({ length: n }, (_, i) => [`a${i}`, `assets/${i}.png`, 'png'] as [string, string, string])

describe('createManifestItemsLoader', () => {
    test('downloads a manifest once, then serves the cache', async () => {
        const fetchItems = vi.fn(async () => tuples(3))
        const load = createManifestItemsLoader(fetchItems)
        const manifest = { id: 'loader-m1' } as any
        const [a, b] = await Promise.all([load(manifest), load(manifest)])
        expect(fetchItems).toHaveBeenCalledTimes(1)
        expect(a).toEqual(tuples(3))
        expect(b).toEqual(tuples(3))
        expect(await load(manifest)).toEqual(tuples(3))
        expect(fetchItems).toHaveBeenCalledTimes(1)
    })

    test('callers get copies, so editing a result cannot corrupt the cache', async () => {
        const load = createManifestItemsLoader(async () => tuples(2))
        const manifest = { id: 'loader-m2' } as any
        const first = await load(manifest)
        first.push(['x', 'assets/x.png', 'png'])
        first[0][0] = 'renamed'
        expect(getCachedFullAssetManifest('loader-m2')).toEqual(tuples(2))
        expect(await load(manifest)).toEqual(tuples(2))
    })

    test('a failed download is not cached and can be retried', async () => {
        let fail = true
        const fetchItems = vi.fn(async () => { if (fail) throw new Error('offline'); return tuples(1) })
        const load = createManifestItemsLoader(fetchItems)
        const manifest = { id: 'loader-m3' } as any
        await expect(load(manifest)).rejects.toThrow('offline')
        fail = false
        expect(await load(manifest)).toEqual(tuples(1))
        expect(fetchItems).toHaveBeenCalledTimes(2)
    })

    test('no descriptor, no download', async () => {
        const fetchItems = vi.fn(async () => tuples(1))
        expect(await createManifestItemsLoader(fetchItems)(undefined)).toEqual([])
        expect(fetchItems).not.toHaveBeenCalled()
    })
})

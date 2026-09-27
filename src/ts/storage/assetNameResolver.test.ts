import { describe, test, expect, vi } from 'vitest'
import { createAssetNameResolver, createBatchedResolve, RESOLVE_BATCH_MAX_NAMES } from './assetNameResolver'

const char = { id: 'c-1', ownerKind: 'character', ownerId: 'chara' } as any
const mod = { id: 'm-1', ownerKind: 'module', ownerId: 'risuco' } as any
type Res = { resolved: Record<string, string>; fuzzy: string[] }

describe('createAssetNameResolver', () => {
    test('asks once with the character first (fuzzy) and modules exact, then serves repeats from memory', async () => {
        const resolve = vi.fn(async (_owners: any, names: string[], _d: number): Promise<Res> => ({
            resolved: Object.fromEntries(names.filter((n) => n !== 'missing').map((n) => [n, `assets/${n}`])),
            fuzzy: names.filter((n) => n === 'near'),
        }))
        const resolveNames = createAssetNameResolver(resolve)

        const first = await resolveNames(char, [mod], ['BG-fog', 'missing', 'near'], true, 4)
        expect(first).toEqual({ 'bg-fog': { path: 'assets/bg-fog', fuzzy: false }, near: { path: 'assets/near', fuzzy: true } })
        expect(resolve).toHaveBeenCalledTimes(1)
        expect(resolve.mock.calls[0][0]).toEqual([
            { manifestId: 'c-1', kind: 'character', ownerId: 'chara', fuzzy: true },
            { manifestId: 'm-1', kind: 'module', ownerId: 'risuco', fuzzy: false },
        ])
        expect(resolve.mock.calls[0][1]).toEqual(['bg-fog', 'missing', 'near'])
        expect(resolve.mock.calls[0][2]).toBe(4)

        // Same manifests, same names (hit and miss alike): no round trip.
        const again = await resolveNames(char, [mod], ['bg-fog', 'missing', 'near'], true, 4)
        expect(again).toEqual(first)
        expect(resolve).toHaveBeenCalledTimes(1)

        // Only the new name goes to the server.
        await resolveNames(char, [mod], ['bg-fog', 'de-panel-1'], true, 4)
        expect(resolve).toHaveBeenCalledTimes(2)
        expect(resolve.mock.calls[1][1]).toEqual(['de-panel-1'])
    })

    test('a different manifest set, fuzzy setting or distance is a different cache', async () => {
        const resolve = vi.fn(async (_owners: any, _names: string[], _d: number): Promise<Res> => ({ resolved: {}, fuzzy: [] }))
        const resolveNames = createAssetNameResolver(resolve)
        await resolveNames(char, [mod], ['x'], true, 4)
        await resolveNames(char, [mod], ['x'], false, 4)
        await resolveNames(char, [mod], ['x'], true, 2)
        await resolveNames(char, [{ ...mod, id: 'm-2' }], ['x'], true, 4)
        await resolveNames(undefined, [mod], ['x'], true, 4)
        expect(resolve).toHaveBeenCalledTimes(5)
        expect((resolve.mock.calls[1] as any)[0][0].fuzzy).toBe(false)
    })

    test('nothing to ask without manifests or names', async () => {
        const resolve = vi.fn(async (_owners: any, _names: string[], _d: number): Promise<Res> => ({ resolved: {}, fuzzy: [] }))
        const resolveNames = createAssetNameResolver(resolve)
        expect(await resolveNames(undefined, [], ['x'], true, 4)).toEqual({})
        expect(await resolveNames(char, [], [], true, 4)).toEqual({})
        expect(resolve).not.toHaveBeenCalled()
    })
})

describe('in-flight sharing and batching', () => {
    test('overlapping concurrent lookups ask for each name once', async () => {
        let release!: () => void
        const gate = new Promise<void>((r) => { release = r })
        const resolve = vi.fn(async (_owners: any, names: string[], _d: number): Promise<Res> => {
            await gate
            return { resolved: Object.fromEntries(names.map((n) => [n, `assets/${n}`])), fuzzy: [] }
        })
        const resolveNames = createAssetNameResolver(resolve)
        const a = resolveNames(char, [], ['bg', 'hero'], true, 4)
        const b = resolveNames(char, [], ['hero', 'villain'], true, 4)
        release()
        expect(await a).toEqual({ bg: { path: 'assets/bg', fuzzy: false }, hero: { path: 'assets/hero', fuzzy: false } })
        expect(await b).toEqual({ hero: { path: 'assets/hero', fuzzy: false }, villain: { path: 'assets/villain', fuzzy: false } })
        expect(resolve).toHaveBeenCalledTimes(2)
        expect(resolve.mock.calls[0][1]).toEqual(['bg', 'hero'])
        expect(resolve.mock.calls[1][1]).toEqual(['villain'])
    })

    test('a failed lookup rejects every waiter and is retried later', async () => {
        let fail = true
        const resolve = vi.fn(async (_owners: any, names: string[], _d: number): Promise<Res> => {
            if (fail) throw new Error('offline')
            return { resolved: Object.fromEntries(names.map((n) => [n, `assets/${n}`])), fuzzy: [] }
        })
        const resolveNames = createAssetNameResolver(resolve)
        const a = resolveNames(char, [], ['bg'], true, 4)
        const b = resolveNames(char, [], ['bg'], true, 4)
        await expect(a).rejects.toThrow('offline')
        await expect(b).rejects.toThrow('offline')
        fail = false
        expect(await resolveNames(char, [], ['bg'], true, 4)).toEqual({ bg: { path: 'assets/bg', fuzzy: false } })
    })

    test('calls in the same task share one request; later ones start a new batch', async () => {
        const send = vi.fn(async (_owners: any, names: string[], _d: number): Promise<Res> => ({
            resolved: Object.fromEntries(names.map((n) => [n, `assets/${n}`])), fuzzy: [],
        }))
        const batched = createBatchedResolve(send)
        const owners = [{ manifestId: 'c-1', fuzzy: true }]
        const p1 = batched(owners, ['a', 'b'], 4)
        const p2 = batched(owners, ['b', 'c'], 4)
        const other = batched([{ manifestId: 'c-2', fuzzy: true }], ['a'], 4)
        const [r1, r2] = await Promise.all([p1, p2, other])
        expect(send).toHaveBeenCalledTimes(2)
        expect(send.mock.calls[0][1]).toEqual(['a', 'b', 'c'])
        expect(r1).toBe(r2)
        await batched(owners, ['d'], 4)
        expect(send).toHaveBeenCalledTimes(3)
        expect(send.mock.calls[2][1]).toEqual(['d'])
    })

    test('a batch closes before the server name limit', async () => {
        const send = vi.fn(async (_owners: any, _names: string[], _d: number): Promise<Res> => ({ resolved: {}, fuzzy: [] }))
        const batched = createBatchedResolve(send)
        const owners = [{ manifestId: 'c-1', fuzzy: true }]
        const first = Array.from({ length: RESOLVE_BATCH_MAX_NAMES - 10 }, (_, i) => `n${i}`)
        await Promise.all([batched(owners, first, 4), batched(owners, Array.from({ length: 20 }, (_, i) => `m${i}`), 4)])
        expect(send).toHaveBeenCalledTimes(2)
        expect(send.mock.calls.every((call) => call[1].length <= RESOLVE_BATCH_MAX_NAMES)).toBe(true)
    })
})

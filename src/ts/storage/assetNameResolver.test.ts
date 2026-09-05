import { describe, test, expect, vi } from 'vitest'
import { createAssetNameResolver } from './assetNameResolver'

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

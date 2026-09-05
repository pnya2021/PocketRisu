import { describe, expect, it } from 'vitest'
import { groupByFolder } from './folders'

const folders = [{ id: 'a', name: 'A' }, { id: 'b', name: 'B' }]

describe('groupByFolder', () => {
    it('groups indexes by folder in folder order, uncategorized last', () => {
        const groups = groupByFolder(['b', undefined, 'a', 'b'], folders)
        expect(groups.map(g => [g.folder?.id ?? null, g.indexes])).toEqual([
            ['a', [2]],
            ['b', [0, 3]],
            [null, [1]],
        ])
    })

    it('treats items pointing at a missing folder as uncategorized', () => {
        const groups = groupByFolder(['gone', 'a'], folders)
        expect(groups.find(g => g.folder === null)?.indexes).toEqual([0])
    })

    it('always yields an uncategorized group even with no folders', () => {
        const groups = groupByFolder([undefined, undefined], [])
        expect(groups).toEqual([{ folder: null, indexes: [0, 1] }])
    })
})

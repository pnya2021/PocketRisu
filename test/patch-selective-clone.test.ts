import { describe, expect, it } from 'vitest'
import selectiveClonePkg from '../server/node/patch-selective-clone.cjs'
import jsonPatchPkg from 'fast-json-patch'

const { clonePatchSnapshot, collectPatchTopLevelKeys } = selectiveClonePkg as {
    clonePatchSnapshot: (database: any, patch: any[]) => any
    collectPatchTopLevelKeys: (patch: any[]) => { keys: Set<string>, touchesRoot: boolean }
}
const { applyPatch } = jsonPatchPkg

function apply(base: any, patch: any[]) {
    const snapshot = clonePatchSnapshot(base, patch)
    applyPatch(snapshot, patch, true)
    return snapshot
}

describe('selective patch snapshot', () => {
    it('clones only the touched top-level branch for a nested replace', () => {
        const untouched = { items: Array.from({ length: 200 }, (_, i) => ({ i, text: `v-${i}` })) }
        const db = { untouched, touched: { nested: { n: 1 } }, other: { ok: true } }
        const patch = [{ op: 'replace', path: '/touched/nested/n', value: 2 }]
        const snapshot = clonePatchSnapshot(db, patch)

        expect(snapshot).not.toBe(db)
        expect(snapshot.touched).not.toBe(db.touched)
        expect(snapshot.untouched).toBe(untouched)
        expect(snapshot.other).toBe(db.other)

        applyPatch(snapshot, patch, true)
        expect(snapshot.touched.nested.n).toBe(2)
        expect(db.touched.nested.n).toBe(1)
    })

    it('keeps top-level add/remove operations isolated with only a shallow root copy', () => {
        const db = { keep: { value: 1 }, removeMe: { value: 2 } }
        const patch = [
            { op: 'remove', path: '/removeMe' },
            { op: 'add', path: '/added', value: { value: 3 } },
        ]
        const snapshot = apply(db, patch)

        expect(snapshot.removeMe).toBeUndefined()
        expect(snapshot.added).toEqual({ value: 3 })
        expect(db.removeMe).toEqual({ value: 2 })
        expect((db as any).added).toBeUndefined()
        expect(snapshot.keep).toBe(db.keep)
    })

    it('clones both source and destination roots for move/copy patches', () => {
        const db = {
            left: { moved: { n: 1 }, copied: { n: 2 } },
            right: { existing: true },
            untouched: { stable: true },
        }
        const patch = [
            { op: 'move', from: '/left/moved', path: '/right/moved' },
            { op: 'copy', from: '/left/copied', path: '/right/copied' },
        ]
        const snapshot = clonePatchSnapshot(db, patch)

        expect(snapshot.left).not.toBe(db.left)
        expect(snapshot.right).not.toBe(db.right)
        expect(snapshot.untouched).toBe(db.untouched)

        applyPatch(snapshot, patch, true)
        expect(snapshot.left.moved).toBeUndefined()
        expect(snapshot.right.moved).toEqual({ n: 1 })
        expect(snapshot.right.copied).toEqual({ n: 2 })
        expect(db.left.moved).toEqual({ n: 1 })
        expect((db.right as any).moved).toBeUndefined()

        // copy must deep-copy: a by-reference copy would alias the destination
        // into the live cache's source branch.
        expect(snapshot.right.copied).not.toBe(db.left.copied)
        snapshot.right.copied.n = 99
        expect(db.left.copied).toEqual({ n: 2 })
        expect(snapshot.left.copied).toEqual({ n: 2 })
    })

    it('preserves the live database when a later patch operation throws', () => {
        const db = { touched: { n: 1 }, untouched: { value: 9 } }
        const before = structuredClone(db)
        const patch = [
            { op: 'replace', path: '/touched/n', value: 2 },
            { op: 'remove', path: '/touched/missing' },
        ]
        const snapshot = clonePatchSnapshot(db, patch)

        expect(() => applyPatch(snapshot, patch, true)).toThrow()
        expect(db).toEqual(before)
    })

    it('falls back to a full clone for a document-root operation', () => {
        const db = { a: { n: 1 }, b: { n: 2 } }
        const snapshot = clonePatchSnapshot(db, [{ op: 'replace', path: '', value: { c: 3 } }])

        expect(snapshot).not.toBe(db)
        expect(snapshot.a).not.toBe(db.a)
        expect(snapshot.b).not.toBe(db.b)
    })

    it('falls back to a full clone for an array document root', () => {
        const db = [{ n: 1 }, { n: 2 }]
        const snapshot = clonePatchSnapshot(db, [{ op: 'replace', path: '/0/n', value: 3 }])

        expect(snapshot).not.toBe(db)
        expect(snapshot[0]).not.toBe(db[0])
        expect(snapshot[1]).not.toBe(db[1])
    })

    it('decodes escaped JSON pointer root keys and treats invalid pointers conservatively', () => {
        const decoded = collectPatchTopLevelKeys([
            { op: 'replace', path: '/a~1b/n', value: 2 },
            { op: 'move', from: '/x~0y/n', path: '/plain/n' },
        ])
        expect(decoded.touchesRoot).toBe(false)
        expect([...decoded.keys].sort()).toEqual(['a/b', 'plain', 'x~y'].sort())

        const invalid = collectPatchTopLevelKeys([{ op: 'replace', path: 'not-a-pointer', value: 1 }])
        expect(invalid.touchesRoot).toBe(true)
    })
})

import { describe, expect, it } from 'vitest'
import Database from 'better-sqlite3'
import pkg from './assetManifestStore.cjs'

const { createAssetManifestStore } = pkg as {
    createAssetManifestStore: (db: any, options?: { maxCacheBytes?: number }) => any
}

function freshStore(options?: { maxCacheBytes?: number }) {
    const db = new Database(':memory:')
    db.pragma('foreign_keys = ON')
    return { db, store: createAssetManifestStore(db, options) }
}

describe('asset manifest store', () => {
    it('preserves tuple order, tuple length, unicode and exact strings', () => {
        const { store } = freshStore()
        const items = [
            ['표정 01.png', 'assets/ABC.png', 'png'],
            ['legacy-no-ext', 'assets/legacy.webp'],
            ['CaseSensitive', 'assets/Mixed.Path', ''],
        ]

        const descriptor = store.putManifest('module', 'module-a', items)
        expect(descriptor.count).toBe(3)
        expect(descriptor.sha256).toMatch(/^[a-f0-9]{64}$/)
        expect(store.loadItems(descriptor.id)).toEqual(items)
        expect(store.verifyManifest(descriptor.id)).toMatchObject({ ok: true, count: 3 })
    })

    it('is content-addressed and prunes superseded revisions on activation', () => {
        const { db, store } = freshStore()
        const v1 = store.putManifest('module', 'module-a', [['a', 'assets/a.png', 'png']])
        const duplicate = store.putManifest('module', 'module-a', [['a', 'assets/a.png', 'png']])
        const v2 = store.putManifest('module', 'module-a', [
            ['a', 'assets/a.png', 'png'],
            ['b', 'assets/b.png', 'png'],
        ])

        expect(duplicate.id).toBe(v1.id)
        expect(v2.id).not.toBe(v1.id)
        expect(store.getLiveDescriptor('module', 'module-a')).toEqual(v2)
        expect(store.loadItems(v1.id)).toBeNull()
        expect(db.prepare('SELECT COUNT(*) AS count FROM asset_manifests').get().count).toBe(1)
        expect(store.stats()).toMatchObject({ manifests: 1, liveManifests: 1, items: 2, cacheEntries: 1 })
    })

    it('keeps owners independent even when their content is identical', () => {
        const { store } = freshStore()
        const items = [['same', 'assets/same.png', 'png']]
        const moduleManifest = store.putManifest('module', 'same-id', items)
        const characterManifest = store.putManifest('character', 'same-id', items)

        expect(moduleManifest.id).not.toBe(characterManifest.id)
        expect(store.getItemsByOwner('module', 'same-id')).toEqual(items)
        expect(store.getItemsByOwner('character', 'same-id')).toEqual(items)
    })

    it('pages, searches and resolves names without returning the whole manifest', () => {
        const { store } = freshStore()
        const descriptor = store.putManifest('module', 'module-a', [
            ['Alpha.PNG', 'assets/a.png', 'png'],
            ['beta.webp', 'assets/b.webp', 'webp'],
            ['alphabet.gif', 'assets/c.gif', 'gif'],
        ])

        expect(store.getPage(descriptor.id, { offset: 1, limit: 1 })).toEqual({
            total: 3,
            offset: 1,
            limit: 1,
            items: [['beta.webp', 'assets/b.webp', 'webp']],
        })
        expect(store.getPage(descriptor.id, { search: 'ALPHA', limit: 100 })).toMatchObject({
            total: 2,
            items: [
                ['Alpha.PNG', 'assets/a.png', 'png'],
                ['alphabet.gif', 'assets/c.gif', 'gif'],
            ],
        })
        expect(store.resolveNames(
            [{ kind: 'module', ownerId: 'module-a' }],
            ['alpha.png', 'bet.webp', 'missing'],
        )).toEqual({
            'alpha.png': 'assets/a.png',
            'bet.webp': 'assets/b.webp',
        })
    })

    it('treats prototype-like asset names as ordinary resolver keys', () => {
        const { store } = freshStore()
        store.putManifest('module', 'module-a', [
            ['__proto__', 'assets/proto'],
            ['constructor', 'assets/constructor'],
        ])

        const result = store.resolveNames(
            [{ kind: 'module', ownerId: 'module-a' }],
            ['__proto__', 'constructor'],
        )
        expect({ ...result }).toEqual({
            ['__proto__']: 'assets/proto',
            constructor: 'assets/constructor',
        })
    })

    it('detects corrupted payloads before exposing items', () => {
        const { db, store } = freshStore({ maxCacheBytes: 0 })
        const descriptor = store.putManifest('module', 'module-a', [['a', 'assets/a.png', 'png']])
        db.prepare('UPDATE asset_manifests SET payload = ? WHERE manifest_id = ?')
            .run(Buffer.from('not-deflate'), descriptor.id)

        expect(store.verifyManifest(descriptor.id)).toMatchObject({ ok: false, manifestId: descriptor.id })
        expect(() => store.loadItems(descriptor.id)).toThrow()
    })

    it('bypasses a warm cache when verifying persisted bytes', () => {
        const { db, store } = freshStore()
        const descriptor = store.putManifest('module', 'module-a', [['a', 'assets/a.png', 'png']])
        expect(store.loadItems(descriptor.id)).toHaveLength(1)

        db.prepare('UPDATE asset_manifests SET payload = ? WHERE manifest_id = ?')
            .run(Buffer.from('not-deflate'), descriptor.id)

        expect(store.verifyManifest(descriptor.id)).toMatchObject({ ok: false, manifestId: descriptor.id })
    })

    it('never re-activates a corrupt content-addressed row hidden by a warm cache', () => {
        const { db, store } = freshStore()
        const items = [['current', 'assets/current.png', 'png']]
        const current = store.putManifest('module', 'module-a', items)
        db.prepare('UPDATE asset_manifests SET payload = ? WHERE manifest_id = ?')
            .run(Buffer.from('not-deflate'), current.id)

        expect(() => store.putManifest('module', 'module-a', items)).toThrow()
    })

    it('never activates a corrupt inactive row and leaves the live pointer unchanged', () => {
        const { db, store } = freshStore()
        const current = store.putManifest('module', 'module-a', [['current', 'assets/current.png', 'png']])
        const pendingItems = [['pending', 'assets/pending.png', 'png']]
        const pending = store.putManifest('module', 'module-a', pendingItems, { activate: false })
        db.prepare('UPDATE asset_manifests SET payload = ? WHERE manifest_id = ?')
            .run(Buffer.from('not-deflate'), pending.id)

        expect(() => store.putManifest('module', 'module-a', pendingItems)).toThrow()
        expect(store.getLiveDescriptor('module', 'module-a')).toEqual(current)
    })

    it('records resumable per-owner migration state', () => {
        const { store } = freshStore()
        store.putManifest('module', 'good', [['a', 'assets/a.png', 'png']])
        store.recordMigrationFailure('character', 'bad', new Error('broken tuple'))

        expect(store.listMigrationState()).toEqual([
            expect.objectContaining({ owner_kind: 'character', owner_id: 'bad', status: 'failed' }),
            expect.objectContaining({ owner_kind: 'module', owner_id: 'good', status: 'verified', item_count: 1 }),
        ])
    })

    it('applies bounded copy-on-write edits and rejects stale revisions', () => {
        const { store } = freshStore()
        const v1 = store.putManifest('module', 'editable', [
            ['a', 'assets/a.png', 'png'],
            ['b', 'assets/b.png', 'png'],
        ])
        const v2 = store.applyOperations('module', 'editable', v1.id, [
            { type: 'rename', index: 0, name: 'renamed' },
            { type: 'remove', index: 1 },
            { type: 'append', item: ['c', 'assets/c.webp', 'webp'] },
        ])

        expect(store.loadItems(v1.id)).toBeNull()
        expect(store.loadItems(v2.id)).toEqual([
            ['renamed', 'assets/a.png', 'png'],
            ['c', 'assets/c.webp', 'webp'],
        ])
        expect(() => store.applyOperations('module', 'editable', v1.id, [
            { type: 'remove', index: 0 },
        ])).toThrow(/revision conflict/)
    })

    it('returns defensive copies so caller mutation cannot poison the cache', () => {
        const { store } = freshStore()
        const descriptor = store.putManifest('module', 'module-a', [['a', 'assets/a.png', 'png']])

        const first = store.loadItems(descriptor.id)
        first.push(['injected', 'assets/evil', 'png'])
        first[0][0] = 'mutated'
        expect(store.loadItems(descriptor.id)).toEqual([['a', 'assets/a.png', 'png']])

        const page = store.getPage(descriptor.id)
        page.items[0][1] = 'assets/other'
        expect(store.getPage(descriptor.id).items).toEqual([['a', 'assets/a.png', 'png']])
    })

    it('honors the caller-provided fuzzy distance ceiling and trims extensions like the parser', () => {
        const { store } = freshStore()
        store.putManifest('module', 'module-a', [['smile.png', 'assets/smile', 'png']])
        const owners = [{ kind: 'module', ownerId: 'module-a' }]

        expect(store.resolveNames(owners, ['smiles.png'])).toEqual({ 'smiles.png': 'assets/smile' })
        expect(store.resolveNames(owners, ['smiles.png'], { maxDistance: 0 })).toEqual({})
        expect(store.resolveNames(owners, ['sm.png'], { maxDistance: 3 })).toEqual({ 'sm.png': 'assets/smile' })
        expect(store.resolveNames(owners, ['smile.webp'], { maxDistance: 0 })).toEqual({ 'smile.webp': 'assets/smile' })
        expect(store.resolveNames([{ ...owners[0], fuzzy: false }], ['smiles.png'])).toEqual({})
        expect(store.resolveNames([{ ...owners[0], fuzzy: false }], ['smile.png'])).toEqual({ 'smile.png': 'assets/smile' })
    })

    it('falls back to the live owner when a supplied manifest revision was pruned', () => {
        const { store } = freshStore()
        const stale = store.putManifest('module', 'module-a', [['old', 'assets/old.png', 'png']])
        const live = store.putManifest('module', 'module-a', [['new', 'assets/new.png', 'png']])

        expect(store.loadItems(stale.id)).toBeNull()
        expect(store.resolveNames(
            [{ manifestId: stale.id, kind: 'module', ownerId: 'module-a' }],
            ['new'],
        )).toEqual({ new: 'assets/new.png' })
        expect(store.listLiveDescriptors()).toEqual([
            { ...live, ownerKind: 'module', ownerId: 'module-a' },
        ])
    })
})

describe('resolveNames priority (v1.11.1 regression)', () => {
    it('an exact module asset is not shadowed by a fuzzy near-miss on the character', () => {
        const { store } = freshStore()
        store.putManifest('character', 'chara', [['bg-01', 'assets/char-bg-01', 'png'], ['평온', 'assets/char-calm', 'png']])
        store.putManifest('module', 'risuco', [['bg-fog', 'assets/mod-bg-fog', 'webp'], ['평정', 'assets/mod-composure', 'png']])
        const owners = [
            { kind: 'character', ownerId: 'chara', fuzzy: true },
            { kind: 'module', ownerId: 'risuco', fuzzy: false },
        ]
        // Both names are within edit distance 4 of a character asset, but
        // the module holds them exactly: exact wins across every owner.
        expect(store.resolveNames(owners, ['bg-fog', '평정'], { maxDistance: 4 })).toEqual({
            'bg-fog': 'assets/mod-bg-fog',
            '평정': 'assets/mod-composure',
        })
        // A name nobody holds still falls back to the character's fuzzy match,
        // and the caller is told which names were fuzzy.
        const fuzzy = new Set<string>()
        expect(store.resolveNames(owners, ['bg-02', 'bg-fog'], { maxDistance: 4, fuzzyNamesOut: fuzzy })).toEqual({
            'bg-02': 'assets/char-bg-01',
            'bg-fog': 'assets/mod-bg-fog',
        })
        expect([...fuzzy]).toEqual(['bg-02'])
    })
})

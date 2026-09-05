import { describe, expect, it } from 'vitest'
import Database from 'better-sqlite3'
import storePkg from './assetManifestStore.cjs'
import migrationPkg from './assetManifestMigration.cjs'

const { createAssetManifestStore } = storePkg as any
const { stripAssetManifests, hydrateAssetManifests, assetManifestSummary } = migrationPkg as any

function freshStore() {
    return createAssetManifestStore(new Database(':memory:'))
}

describe('asset manifest migration compatibility layer', () => {
    it('strips module, character and embedded persona arrays without mutating source', () => {
        const store = freshStore()
        const source = {
            modules: [{ id: 'm1', name: 'Pack', assets: [['m', 'assets/m.png', 'png']] }],
            characters: [{ chaId: 'c1', name: 'Char', additionalAssets: [['c', 'assets/c.png', 'png']] }],
            personas: [{ id: 'p1', embeddedModule: { id: 'embedded', assets: [['p', 'assets/p.png', 'png']] } }],
        }

        const result = stripAssetManifests(source, store)
        expect(source.modules[0].assets).toHaveLength(1)
        expect(source.characters[0].additionalAssets).toHaveLength(1)
        expect(source.personas[0].embeddedModule.assets).toHaveLength(1)

        expect(result.db.modules[0].assets).toBeUndefined()
        expect(result.db.modules[0].assetManifest).toMatchObject({ ownerKind: 'module', ownerId: 'm1', count: 1 })
        expect(result.db.characters[0].additionalAssets).toBeUndefined()
        expect(result.db.characters[0].additionalAssetManifest).toMatchObject({ ownerKind: 'character', ownerId: 'c1' })
        expect(result.db.personas[0].embeddedModule.assets).toBeUndefined()
        expect(result.migrated).toHaveLength(3)
        expect(assetManifestSummary(result.db)).toMatchObject({ manifests: 3, items: 3 })
    })

    it('hydrates a byte-for-byte JSON-equivalent legacy shape for persistence/export', () => {
        const store = freshStore()
        const source = {
            untouched: { value: true },
            modules: [{ id: 'm1', name: 'Pack', assets: [['A', 'assets/A.PNG', 'PNG'], ['legacy', 'assets/x']] }],
            characters: [{ chaId: 'c1', additionalAssets: [['표정', 'assets/c.webp', 'webp']] }],
            personas: [],
        }

        const stripped = stripAssetManifests(source, store).db
        const hydrated = hydrateAssetManifests(stripped, store)
        expect(hydrated).toEqual(source)
        expect(stripped.modules[0].assetManifest).toBeDefined()
    })

    it('does not externalize empty arrays', () => {
        const store = freshStore()
        const source = {
            modules: [{ id: 'm1', assets: [] }],
            characters: [{ chaId: 'c1', additionalAssets: [] }],
            personas: [],
        }
        const result = stripAssetManifests(source, store)
        expect(result.db).toEqual(source)
        expect(result.migrated).toHaveLength(0)
    })

    it('refuses hydration after manifest corruption instead of dropping assets', () => {
        const db = new Database(':memory:')
        const store = createAssetManifestStore(db, { maxCacheBytes: 0 })
        const source = { modules: [{ id: 'm1', assets: [['a', 'assets/a.png', 'png']] }] }
        const stripped = stripAssetManifests(source, store).db
        db.prepare('UPDATE asset_manifests SET content_hash = ?').run('0'.repeat(64))
        expect(() => hydrateAssetManifests(stripped, store)).toThrow(/unavailable or corrupt/)
    })

    it('treats a descriptor as authoritative over an accidental inline empty array', () => {
        const store = freshStore()
        const source = { modules: [{ id: 'm1', assets: [['safe', 'assets/safe.png', 'png']] }] }
        const stripped = stripAssetManifests(source, store).db
        stripped.modules[0].assets = []
        expect(hydrateAssetManifests(stripped, store)).toEqual(source)
    })

    it('hydrates independent arrays so consumer mutation cannot corrupt later hydrations', () => {
        const store = freshStore()
        const source = { modules: [{ id: 'm1', assets: [['a', 'assets/a.png', 'png']] }] }
        const stripped = stripAssetManifests(source, store).db

        const first = hydrateAssetManifests(stripped, store)
        first.modules[0].assets.push(['injected', 'assets/evil', 'png'])
        first.modules[0].assets[0][0] = 'mutated'

        expect(hydrateAssetManifests(stripped, store)).toEqual(source)
    })

    it('rejects descriptor owner or version tampering', () => {
        const store = freshStore()
        const source = { modules: [{ id: 'm1', assets: [['safe', 'assets/safe.png', 'png']] }] }
        const stripped = stripAssetManifests(source, store).db

        stripped.modules[0].assetManifest.ownerId = 'another-module'
        expect(() => hydrateAssetManifests(stripped, store)).toThrow(/owner id mismatch/)

        stripped.modules[0].assetManifest.ownerId = 'm1'
        stripped.modules[0].assetManifest.version = 999
        expect(() => hydrateAssetManifests(stripped, store)).toThrow(/version mismatch/)
    })
})

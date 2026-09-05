import { describe, test, expect, beforeAll, afterAll } from 'vitest'
import { spawnServer, type ServerHandle } from './helpers/spawnServer.js'
import { createClient, type RisuClient } from './helpers/client.js'
import { encodeBackup } from './helpers/encode.js'

const utils = require('../../server/node/utils.cjs') as any
const DB_KEY_HEX = Buffer.from('database/database.bin').toString('hex')

let srv: ServerHandle
let client: RisuClient
let seedBin: Buffer

beforeAll(async () => {
    srv = await spawnServer()
    client = await createClient(srv.port, srv.password)
    const db = {
        apiType: 'openai',
        characters: [{ chaId: 'c1', name: 'Char', chats: [], additionalAssets: [['x.png', 'assets/x', 'png']] }],
        personas: [{ id: 'p', name: 'p', personaPrompt: '', icon: '' }],
        modules: [{ id: 'm1', name: 'Pack', assets: [['a.png', 'assets/a', 'png']] }],
    }
    seedBin = encodeBackup([{
        name: 'database.risudat',
        data: Buffer.from(utils.encodeRisuSaveLegacy(db)),
    }])
    expect((await client.importBackup(seedBin)).ok).toBe(true)
})

afterAll(async () => {
    await srv?.cleanup()
})

async function readDb() {
    const res = await client.fetch('/api/read', { headers: { 'file-path': DB_KEY_HEX } })
    return utils.normalizeJSON(await utils.decodeRisuSave(Buffer.from(await res.arrayBuffer()))) as any
}

async function patch(ops: any[]) {
    const db = await readDb()
    const expectedHash = utils.calculateHash(db).toString(16)
    return client.fetch('/api/patch', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'file-path': DB_KEY_HEX },
        body: JSON.stringify({ patch: ops, expectedHash }),
    })
}

describe('lazy asset manifest guard', () => {
    test('client view carries descriptors, not inline arrays', async () => {
        const db = await readDb()
        expect(db.modules[0].assetManifest).toBeTruthy()
        expect(db.modules[0].assets).toBeUndefined()
        expect(db.characters[0].additionalAssetManifest).toBeTruthy()
    })

    test('removing a descriptor without an inline list is rejected with 409', async () => {
        const res = await patch([{ op: 'remove', path: '/modules/0/assetManifest' }])
        expect(res.status).toBe(409)
        const body = await res.json()
        expect(body.code).toBe('ASSET_MANIFEST_GUARD_REJECTED')
        const db = await readDb()
        expect(db.modules[0].assetManifest).toBeTruthy()
    })

    test('replacing a character rebuilt without its descriptor is rejected', async () => {
        const db = await readDb()
        const { additionalAssetManifest, ...stripped } = db.characters[0]
        const res = await patch([{ op: 'replace', path: '/characters/0', value: stripped }])
        expect(res.status).toBe(409)
        expect((await readDb()).characters[0].additionalAssetManifest).toBeTruthy()
    })

    test('replacing the descriptor with an inline array is allowed', async () => {
        const db = await readDb()
        const { assetManifest, ...rest } = db.modules[0]
        const res = await patch([{ op: 'replace', path: '/modules/0', value: { ...rest, assets: [] } }])
        expect(res.status).toBe(200)
    })

    test('a full write that drops a descriptor is aborted', async () => {
        const db = await readDb()
        const { additionalAssetManifest, ...stripped } = db.characters[0]
        const broken = { ...db, characters: [stripped] }
        const res = await client.fetch('/api/write', {
            method: 'POST',
            headers: { 'content-type': 'application/octet-stream', 'file-path': DB_KEY_HEX },
            body: Buffer.from(utils.encodeRisuSaveLegacy(broken)),
        })
        expect(res.status).toBe(500)
        expect((await readDb()).characters[0].additionalAssetManifest).toBeTruthy()
    })

    test('an upper-case hex file-path header cannot dodge the patch guard', async () => {
        const db = await readDb()
        const expectedHash = utils.calculateHash(db).toString(16)
        const res = await client.fetch('/api/patch', {
            method: 'POST',
            headers: { 'content-type': 'application/json', 'file-path': DB_KEY_HEX.toUpperCase() },
            body: JSON.stringify({ patch: [{ op: 'remove', path: '/characters/0/additionalAssetManifest' }], expectedHash }),
        })
        expect(res.status).toBe(409)
        expect((await res.json()).code).toBe('ASSET_MANIFEST_GUARD_REJECTED')
        expect((await readDb()).characters[0].additionalAssetManifest).toBeTruthy()
    })

    test('a manifest edit bumps the db etag so a pre-edit full write conflicts', async () => {
        const before = await client.fetch('/api/read', { headers: { 'file-path': DB_KEY_HEX } })
        const staleEtag = before.headers.get('x-db-etag')
        expect(staleEtag).toBeTruthy()
        const db = utils.normalizeJSON(await utils.decodeRisuSave(Buffer.from(await before.arrayBuffer()))) as any
        const edit = await client.fetch('/api/asset-manifests/owner/character/c1', {
            method: 'PATCH',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({
                expectedManifestId: db.characters[0].additionalAssetManifest.id,
                operations: [{ type: 'append', item: ['y.png', 'assets/y', 'png'] }],
            }),
        })
        expect(edit.status).toBe(200)
        const res = await client.fetch('/api/write', {
            method: 'POST',
            headers: { 'content-type': 'application/octet-stream', 'file-path': DB_KEY_HEX, 'x-if-match': staleEtag! },
            body: Buffer.from(utils.encodeRisuSaveLegacy(db)),
        })
        expect(res.status).toBe(409)
    })

    test('a stale etag still conflicts right after the cache was invalidated', async () => {
        const before = await client.fetch('/api/read', { headers: { 'file-path': DB_KEY_HEX } })
        const db = utils.normalizeJSON(await utils.decodeRisuSave(Buffer.from(await before.arrayBuffer()))) as any
        expect((await client.importBackup(seedBin)).ok).toBe(true) // dbEtag is null now
        const res = await client.fetch('/api/write', {
            method: 'POST',
            headers: { 'content-type': 'application/octet-stream', 'file-path': DB_KEY_HEX, 'x-if-match': 'stale' },
            body: Buffer.from(utils.encodeRisuSaveLegacy(db)),
        })
        expect(res.status).toBe(409)
    })

    test('the full-write guard also holds on a cold cache', async () => {
        const db = await readDb()
        const { additionalAssetManifest, ...stripped } = db.characters[0]
        const broken = { ...db, characters: [stripped] }
        // Import invalidates dbCache, so the next write arrives with no
        // warm client view and the guard must load it from disk.
        expect((await client.importBackup(seedBin)).ok).toBe(true)
        const res = await client.fetch('/api/write', {
            method: 'POST',
            headers: { 'content-type': 'application/octet-stream', 'file-path': DB_KEY_HEX },
            body: Buffer.from(utils.encodeRisuSaveLegacy(broken)),
        })
        expect(res.status).toBe(500)
        expect((await readDb()).characters[0].additionalAssetManifest).toBeTruthy()
    })
})

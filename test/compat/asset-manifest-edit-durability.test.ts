import { describe, test, expect, beforeAll, afterAll } from 'vitest'
import { spawnServer, type ServerHandle } from './helpers/spawnServer.js'
import { createClient, type RisuClient } from './helpers/client.js'
import { encodeBackup } from './helpers/encode.js'

const utils = require('../../server/node/utils.cjs') as any
const DB_KEY_HEX = Buffer.from('database/database.bin').toString('hex')

let srv: ServerHandle
let client: RisuClient

beforeAll(async () => {
    srv = await spawnServer()
    client = await createClient(srv.port, srv.password)
    const db = {
        apiType: 'openai',
        characters: [],
        personas: [{ id: 'p', name: 'p', personaPrompt: '', icon: '' }],
        modules: [{ id: 'm1', name: 'Pack', assets: [['a.png', 'assets/a', 'png']] }],
    }
    const bin = encodeBackup([{
        name: 'database.risudat',
        data: Buffer.from(utils.encodeRisuSaveLegacy(db)),
    }])
    expect((await client.importBackup(bin)).ok).toBe(true)
})

afterAll(async () => {
    await srv?.cleanup()
})

async function readDb() {
    const res = await client.fetch('/api/read', { headers: { 'file-path': DB_KEY_HEX } })
    return utils.normalizeJSON(await utils.decodeRisuSave(Buffer.from(await res.arrayBuffer()))) as any
}

test('an accepted manifest edit survives a reload before the descriptor autosave lands', async () => {
    const db1 = await readDb()
    const desc = db1.modules[0].assetManifest
    const oldHash = utils.calculateHash(db1).toString(16)
    const edit = await client.fetch('/api/asset-manifests/owner/module/m1', {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
            expectedManifestId: desc.id,
            operations: [{ type: 'append', item: ['b.png', 'assets/b', 'png'] }],
        }),
    })
    expect(edit.status).toBe(200)

    const stalePatch = await client.fetch('/api/patch', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'file-path': DB_KEY_HEX },
        body: JSON.stringify({ patch: [], expectedHash: oldHash }),
    })
    expect(stalePatch.status).toBe(409)

    // Simulate a reload before the client's debounced descriptor patch lands.
    const db2 = await readDb()
    const live = await (await client.fetch('/api/asset-manifests/owner/module/m1')).json()
    expect(db2.modules[0].assetManifest.count).toBe(2)
    expect(live.count).toBe(2)

    const rebasedPatch = await client.fetch('/api/patch', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'file-path': DB_KEY_HEX },
        body: JSON.stringify({ patch: [], expectedHash: utils.calculateHash(db2).toString(16) }),
    })
    expect(rebasedPatch.status).toBe(200)
})

test('manifest validation failures return 400 without advancing the live revision', async () => {
    const desc = (await readDb()).modules[0].assetManifest
    const invalid = await client.fetch('/api/asset-manifests/owner/module/m1', {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
            expectedManifestId: desc.id,
            operations: [{ type: 'rename', index: -1, name: 'bad' }],
        }),
    })
    expect(invalid.status).toBe(400)
    const live = await (await client.fetch('/api/asset-manifests/owner/module/m1')).json()
    expect(live.id).toBe(desc.id)
})

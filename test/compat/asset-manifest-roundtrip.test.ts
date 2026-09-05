import { describe, expect, test } from 'vitest'
import Database from 'better-sqlite3'
import { decodeBackup } from './helpers/decode.js'
import { encodeBackup } from './helpers/encode.js'

const utils = require('../../server/node/utils.cjs') as typeof import('../../server/node/utils.cjs')
const storePkg = require('../../server/node/assetManifestStore.cjs') as any
const migrationPkg = require('../../server/node/assetManifestMigration.cjs') as any

const { createAssetManifestStore } = storePkg
const { stripAssetManifests, hydrateAssetManifests } = migrationPkg

function databaseEntry(backup: Buffer) {
    const entry = decodeBackup(backup).find((candidate) => candidate.name === 'database.risudat')
    if (!entry) throw new Error('database.risudat is missing')
    return entry
}

describe('asset manifest RisuAI compatibility', () => {
    test('imports an upstream backup and exports the exact legacy asset-array shape', async () => {
        const source = {
            apiType: 'openai',
            modules: [{
                id: 'module-1',
                name: 'Asset pack',
                assets: [
                    ['표정.png', 'assets/module-image', 'png'],
                    ['legacy-no-extension', 'assets/module-legacy'],
                ],
            }],
            characters: [{
                chaId: 'character-1',
                name: 'Character',
                chats: [],
                additionalAssets: [['pose.webp', 'assets/character-pose', 'webp']],
            }],
            personas: [{
                id: 'persona-1',
                name: 'Persona',
                embeddedModule: {
                    assets: [['persona.gif', 'assets/persona-image', 'gif']],
                },
            }],
        }
        const assetBytes = Buffer.from('binary-asset-must-stay-untouched')
        const upstreamBackup = encodeBackup([
            { name: 'database.risudat', data: Buffer.from(utils.encodeRisuSaveLegacy(source)) },
            { name: Buffer.from('module-image').toString('hex'), data: assetBytes },
        ])

        const imported = await utils.decodeRisuSave(databaseEntry(upstreamBackup).data)
        const sqlite = new Database(':memory:')
        const store = createAssetManifestStore(sqlite)
        const stripped = stripAssetManifests(imported, store).db

        expect(stripped.modules[0].assets).toBeUndefined()
        expect(stripped.characters[0].additionalAssets).toBeUndefined()
        expect(stripped.personas[0].embeddedModule.assets).toBeUndefined()

        const legacy = hydrateAssetManifests(stripped, store)
        const exportedBackup = encodeBackup([
            { name: 'database.risudat', data: Buffer.from(utils.encodeRisuSaveLegacy(legacy)) },
            { name: Buffer.from('module-image').toString('hex'), data: assetBytes },
        ])
        const reimportedByRisuAI = await utils.decodeRisuSave(databaseEntry(exportedBackup).data)

        expect(reimportedByRisuAI).toEqual(source)
        expect(decodeBackup(exportedBackup).find((entry) => entry.name !== 'database.risudat')?.data)
            .toEqual(assetBytes)
        sqlite.close()
    })
})

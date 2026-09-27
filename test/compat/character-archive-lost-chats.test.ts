/**
 * Deactivating a character that still lists a chat whose body the server no
 * longer has (a bodiless `_stub`, lost by an older build). The server refuses
 * by default and names the chats; with `acceptLostChats` it archives them as
 * the empty chats they already are, so the round trip back to active leaves a
 * well-formed character that persists normally.
 */
import { describe, test, expect, beforeAll, afterAll } from 'vitest'
import { Packr } from 'msgpackr'
import { spawnServer, type ServerHandle } from './helpers/spawnServer.js'
import { createClient, type RisuClient } from './helpers/client.js'
import { encodeBackup } from './helpers/encode.js'
import { decodeBackup } from './helpers/decode.js'
import { decodeRisuDat } from './helpers/normalize.js'

const utils = require('../../server/node/utils.cjs') as typeof import('../../server/node/utils.cjs')

const MAGIC_RAW = Buffer.from([0, 82, 73, 83, 85, 83, 65, 86, 69, 0, 7])
const packr = new Packr({ useRecords: false })
const encodeDb = (data: unknown) => Buffer.concat([MAGIC_RAW, packr.encode(data)])
const hex = (s: string) => Buffer.from(s, 'utf-8').toString('hex')
const DB_KEY_HEX = hex('database/database.bin')

const CHA = 'lost-a'

function buildBackup(): Buffer {
  const database = {
    characters: [{
      chaId: CHA, type: 'character', name: 'Has Lost Chat', desc: '', firstMessage: 'hi', image: '',
      chats: [
        { id: 'kept', name: 'Kept chat', lastDate: 1, localLore: [], note: 'n', message: [{ role: 'user', data: 'hello' }] },
        { id: 'lost', name: 'Lost chat', lastDate: 2, _stub: true },
      ],
      chatPage: 0,
    }],
    characterOrder: [CHA],
    apiType: 'openai', mainPrompt: '', jailbreak: '', globalNote: '',
    temperature: 80, maxContext: 4000, maxResponse: 300, frequencyPenalty: 70, PresensePenalty: 70,
    personas: [{ name: 'Default', icon: '', personaPrompt: '' }],
    botPresets: [], botPresetsId: 0, moduleIntergration: [], selectedCharacter: 0,
  }
  return encodeBackup([{ name: 'database.risudat', data: encodeDb(database) }])
}

let srv: ServerHandle
let client: RisuClient

beforeAll(async () => {
  srv = await spawnServer()
  client = await createClient(srv.port, srv.password)
  expect((await client.importBackup(buildBackup())).ok).toBe(true)
})
afterAll(async () => { await srv?.cleanup() })

async function readDb() {
  const res = await client.fetch('/api/read', { headers: { 'file-path': DB_KEY_HEX } })
  expect(res.status).toBe(200)
  const db = utils.normalizeJSON(await utils.decodeRisuSave(Buffer.from(await res.arrayBuffer()))) as any
  return { db, hash: utils.calculateHash(db).toString(16) }
}

function sendPatch(patch: unknown[], expectedHash: string) {
  return client.fetch('/api/patch', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'file-path': DB_KEY_HEX },
    body: JSON.stringify({ patch, expectedHash }),
  })
}

function archive(body?: unknown) {
  return client.fetch(`/api/characters/${CHA}/archive`, {
    method: 'POST',
    ...(body === undefined ? {} : { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }),
  })
}

async function exportDb() {
  const entries = decodeBackup(await client.exportBackup())
  return decodeRisuDat(entries.find((e) => e.name === 'database.risudat')!.data) as any
}

describe('deactivating a character with lost chat bodies', () => {
  test('is refused by default, naming the lost chats', async () => {
    for (const body of [undefined, {}, { acceptLostChats: 'yes' }]) {
      const res = await archive(body)
      expect(res.status).toBe(409)
      const json = await res.json() as any
      expect(json.code).toBe('ARCHIVE_CHATS_UNAVAILABLE')
      expect(json.chats).toEqual(['Lost chat'])
    }
  })

  let stub: any
  test('with acceptLostChats the lost chat is archived as an empty chat', async () => {
    const res = await archive({ acceptLostChats: true })
    expect(res.status).toBe(200)
    stub = (await res.json() as any).stub
    expect(stub.chatIds).toEqual(['kept', 'lost'])

    const before = await readDb()
    const idx = before.db.characters.findIndex((c: any) => c.chaId === CHA)
    const moved = await sendPatch([
      { op: 'remove', path: `/characters/${idx}` },
      { op: 'add', path: '/nodeOnlyArchivedCharacters', value: [stub] },
    ], before.hash)
    expect(moved.status).toBe(200)

    const inlined = (await exportDb()).characters.find((c: any) => c.chaId === CHA)
    expect(inlined.chats[0].message).toEqual([{ role: 'user', data: 'hello' }])
    expect(inlined.chats[1]).toMatchObject({ id: 'lost', name: 'Lost chat', lastDate: 2, message: [], note: '', localLore: [] })
    expect(inlined.chats[1]._stub).toBeUndefined()
  })

  test('the reactivated character persists normally', async () => {
    const res = await client.fetch(`/api/characters/${CHA}/activate`, { method: 'POST' })
    expect(res.status).toBe(200)
    const character = (await res.json() as any).character
    expect(character.chats.map((c: any) => c.id)).toEqual(['kept', 'lost'])

    const before = await readDb()
    const patched = await sendPatch([
      { op: 'add', path: '/characters/-', value: character },
      { op: 'replace', path: '/nodeOnlyArchivedCharacters', value: [] },
    ], before.hash)
    expect(patched.status).toBe(200)

    // Export forces a persist; an activated character still carrying a
    // bodiless `_stub` would abort it (findUnmergedArchivedChats).
    const db = await exportDb()
    const back = db.characters.find((c: any) => c.chaId === CHA)
    expect(back.chats.map((c: any) => c.message.length)).toEqual([1, 0])
    expect(back.chats.some((c: any) => c._stub)).toBe(false)
  })
})

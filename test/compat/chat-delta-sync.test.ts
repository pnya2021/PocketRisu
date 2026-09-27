/**
 * Chat delta sync over the real server: GET returns only the messages after a
 * verified prefix, POST splices a verified tail, anything unverified falls
 * back (full GET / 409 for the client to save in full), and gzip uploads work.
 */
import { describe, test, expect, beforeAll, afterAll } from 'vitest'
import { gzipSync } from 'node:zlib'
import { Packr } from 'msgpackr'
import { spawnServer, type ServerHandle } from './helpers/spawnServer.js'
import { createClient, type RisuClient } from './helpers/client.js'
import { createSeedBackup } from './helpers/seed.js'
import { normalizeBackup } from './helpers/normalize.js'

const utils = require('../../server/node/utils.cjs') as typeof import('../../server/node/utils.cjs')
const fp = require('../../server/node/chatFingerprint.cjs') as typeof import('../../server/node/chatFingerprint.cjs')

const MAGIC_RAW = Buffer.from([0, 82, 73, 83, 85, 83, 65, 86, 69, 0, 7])
const packr = new Packr({ useRecords: false })
const encode = (data: unknown) => new Uint8Array(Buffer.concat([MAGIC_RAW, packr.encode(data)]))

const CHA = 'test-char-0'
const CHAT = 'chat-0-0'
const URL_ = `/api/chat-content/${CHA}/0`

let srv: ServerHandle
let client: RisuClient

const base = (messages: any[], count: number) => ({
  'x-chat-base-count': String(count),
  'x-chat-base-fp': fp.prefixFingerprint(fp.messageFingerprints(messages.slice(0, count)), count),
})

async function get(headers: Record<string, string> = {}) {
  const res = await client.fetch(URL_, { headers: { 'x-chat-id': CHAT, ...headers } })
  expect(res.status).toBe(200)
  const chat = await utils.decodeRisuSave(Buffer.from(await res.arrayBuffer())) as any
  return { chat, delta: res.headers.get('x-chat-delta-base') }
}

async function post(chat: any, headers: Record<string, string> = {}, gzip = false) {
  const body = gzip ? new Uint8Array(gzipSync(encode(chat))) : encode(chat)
  return client.fetch(URL_, {
    method: 'POST',
    headers: { 'content-type': 'application/octet-stream', 'x-chat-id': CHAT, ...(gzip ? { 'content-encoding': 'gzip' } : {}), ...headers },
    body,
  })
}

beforeAll(async () => {
  srv = await spawnServer()
  client = await createClient(srv.port, srv.password)
  const result = await client.importBackup(createSeedBackup({ characterCount: 1, messagesPerChat: 50 }))
  expect(result.ok).toBe(true)
})
afterAll(async () => { await srv?.cleanup() })

describe('chat delta sync', () => {
  test('a GET without a base is the full chat, unchanged from before', async () => {
    const { chat, delta } = await get()
    expect(chat.message).toHaveLength(50)
    expect(delta).toBeNull()
  })

  test('a GET with a verified base returns only the messages after it', async () => {
    const { chat: full } = await get()
    const { chat, delta } = await get(base(full.message, 40))
    expect(delta).toBe('40')
    expect(chat.message).toEqual(full.message.slice(40))
    expect(chat.note).toEqual(full.note)
  })

  test('a GET with a wrong or too long base falls back to the full chat', async () => {
    const { chat: full } = await get()
    const edited = full.message.map((m: any, i: number) => (i === 5 ? { ...m, data: 'not what the server has' } : m))
    const wrong = await get(base(edited, 40))
    expect(wrong.delta).toBeNull()
    expect(wrong.chat.message).toHaveLength(50)
    const tooLong = await get({ 'x-chat-base-count': '999', 'x-chat-base-fp': 'x' })
    expect(tooLong.delta).toBeNull()
    expect(tooLong.chat.message).toHaveLength(50)
  })

  test('a delta POST appends to the verified prefix', async () => {
    const { chat: full } = await get()
    const next = { ...full, message: [...full.message, { role: 'user', data: '새 메시지 51' }, { role: 'char', data: '응답 52' }] }
    const res = await post({ ...next, message: next.message.slice(50) }, base(next.message, 50))
    expect(res.status).toBe(200)
    const { chat } = await get()
    expect(chat.message).toHaveLength(52)
    expect(chat.message.slice(0, 50)).toEqual(full.message)
    expect(chat.message.at(-1).data).toBe('응답 52')
  })

  test('a reroll delta replaces only the last message', async () => {
    const { chat: full } = await get()
    const next = { ...full, message: [...full.message.slice(0, 51), { role: 'char', data: '다시 뽑은 응답' }] }
    const res = await post({ ...next, message: next.message.slice(51) }, base(next.message, 51))
    expect(res.status).toBe(200)
    const { chat } = await get()
    expect(chat.message).toHaveLength(52)
    expect(chat.message.at(-1).data).toBe('다시 뽑은 응답')
    expect(chat.message.slice(0, 51)).toEqual(full.message.slice(0, 51))
  })

  test('a delta POST whose prefix does not verify is refused with 409 and changes nothing', async () => {
    const { chat: before } = await get()
    const stale = before.message.map((m: any, i: number) => (i === 0 ? { ...m, data: 'stale copy' } : m))
    const res = await post({ ...before, message: [{ role: 'user', data: 'should not land' }] }, base(stale, 52))
    expect(res.status).toBe(409)
    expect((await res.json() as any).code).toBe('CHAT_DELTA_BASE_MISMATCH')
    const { chat } = await get()
    expect(chat).toEqual(before)
  })

  test('a gzip-encoded full save is accepted', async () => {
    const { chat: full } = await get()
    const next = { ...full, message: [...full.message, { role: 'user', data: '압축 업로드 '.repeat(2000) }] }
    const res = await post(next, {}, true)
    expect(res.status).toBe(200)
    const { chat } = await get()
    expect(chat.message).toHaveLength(53)
    expect(chat.message.at(-1).data).toBe('압축 업로드 '.repeat(2000))
  })

  test('a gzip-encoded delta save is accepted and reaches the backup on disk', async () => {
    const { chat: full } = await get()
    const next = { ...full, message: [...full.message, { role: 'char', data: '마지막 '.repeat(3000) }] }
    const res = await post({ ...next, message: next.message.slice(53) }, base(next.message, 53), true)
    expect(res.status).toBe(200)
    const { raw } = normalizeBackup(await client.exportBackup())
    const saved = (raw.characters as any[]).find((c) => c.chaId === CHA).chats[0]
    expect(saved.message).toHaveLength(54)
    expect(saved.message.at(-1).data).toBe('마지막 '.repeat(3000))
    expect(saved.message.slice(0, 50).map((m: any) => m.data)).toEqual(full.message.slice(0, 50).map((m: any) => m.data))
  })
})

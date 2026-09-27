/**
 * Inlay thumbnails are built once and cached on disk under `inlays/.thumbs/`,
 * named after the source version; replacing or deleting the source removes
 * its thumbnail, and the cache never shows up as an inlay itself.
 */
import { describe, test, expect, beforeAll, afterAll } from 'vitest'
import { readdir, stat } from 'node:fs/promises'
import path from 'node:path'
import { spawnServer, type ServerHandle } from './helpers/spawnServer.js'
import { createClient, type RisuClient } from './helpers/client.js'
import { decodeBackup } from './helpers/decode.js'

const hex = (s: string) => Buffer.from(s, 'utf-8').toString('hex')
const PNG_1PX = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg=='
const IDS = ['thumb-a', 'thumb-b', 'thumb-c']

let srv: ServerHandle
let client: RisuClient
let sessionCookie = ''
const thumbDir = () => path.join(srv.cwd, 'save', 'inlays', '.thumbs')
async function thumbFiles(id: string) {
  return (await readdir(thumbDir())).filter((n) => n.startsWith(`${id}.`))
}

function writeInlay(id: string) {
  return client.fetch('/api/write', {
    method: 'POST',
    headers: { 'content-type': 'application/octet-stream', 'file-path': hex(`inlay/${id}`) },
    body: Buffer.from(JSON.stringify({ data: PNG_1PX, ext: 'png', type: 'image', name: id })),
  })
}

// /api/asset authenticates by the session cookie, like an <img> request.
function getThumb(id: string) {
  return client.fetch(`/api/asset/${hex(`inlay_thumb/${id}`)}`, { headers: { cookie: sessionCookie } })
}

beforeAll(async () => {
  srv = await spawnServer()
  client = await createClient(srv.port, srv.password)
  const session = await client.fetch('/api/session', { method: 'POST' })
  sessionCookie = session.headers.get('set-cookie')!.split(';')[0]
  for (const id of IDS) expect((await writeInlay(id)).status).toBe(200)
})
afterAll(async () => { await srv?.cleanup() })

describe('inlay thumbnails', () => {
  test('concurrent first requests all succeed and leave one cached file each', async () => {
    const responses = await Promise.all([...IDS, ...IDS].map(getThumb))
    for (const res of responses) {
      expect(res.status).toBe(200)
      expect(res.headers.get('content-type')).toBe('image/webp')
      expect((await res.arrayBuffer()).byteLength).toBeGreaterThan(0)
    }
    for (const id of IDS) expect(await thumbFiles(id)).toHaveLength(1)
  })

  test('a repeat request is served from the cache', async () => {
    const [name] = await thumbFiles('thumb-a')
    const before = (await stat(path.join(thumbDir(), name))).mtimeMs
    expect((await getThumb('thumb-a')).status).toBe(200)
    expect(await thumbFiles('thumb-a')).toEqual([name])
    expect((await stat(path.join(thumbDir(), name))).mtimeMs).toBe(before)
  })

  test('replacing the source drops its thumbnail and builds one for the new version', async () => {
    const [old] = await thumbFiles('thumb-b')
    await new Promise((r) => setTimeout(r, 20))
    expect((await writeInlay('thumb-b')).status).toBe(200)
    expect(await thumbFiles('thumb-b')).toEqual([])
    expect((await getThumb('thumb-b')).status).toBe(200)
    const now = await thumbFiles('thumb-b')
    expect(now).toHaveLength(1)
    expect(now[0]).not.toBe(old)
  })

  test('deleting the inlay removes its thumbnail', async () => {
    const res = await client.fetch('/api/remove', { headers: { 'file-path': hex('inlay/thumb-c') } })
    expect(res.status).toBe(200)
    expect(await thumbFiles('thumb-c')).toEqual([])
    expect((await getThumb('thumb-c')).status).toBe(404)
  })

  test('the cache is not exported as inlays', async () => {
    const names = decodeBackup(await client.exportBackup()).map((e) => e.name)
    expect(names.some((n) => n.includes('.thumbs') || n.endsWith('.webp'))).toBe(false)
    expect(names.filter((n) => n.startsWith('inlay/')).sort()).toEqual(['inlay/thumb-a.png', 'inlay/thumb-b.png'])
  })
})

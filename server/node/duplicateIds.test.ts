import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import crypto from 'node:crypto'
import fs from 'node:fs'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import Database from 'better-sqlite3'
import { Packr } from 'msgpackr'
import { createRequire } from 'node:module'
import zlib from 'node:zlib'

const packr = new Packr({ useRecords: false })
const magicHeader = new Uint8Array([0, 82, 73, 83, 85, 83, 65, 86, 69, 0, 7])

function encodeRisuSaveLegacy(data: Record<string, unknown>) {
    const encoded = packr.encode(data)
    const result = new Uint8Array(encoded.length + magicHeader.length)
    result.set(magicHeader, 0)
    result.set(encoded, magicHeader.length)
    return result
}

const HERE = path.dirname(fileURLToPath(import.meta.url))
const SERVER_PATH = path.join(HERE, 'server.cjs')
const DAY = 24 * 60 * 60 * 1000

let tmpDir: string
let port: number
let base: string
let child: ChildProcessWithoutNullStreams
let token: string
let stdout = ''
let stderr = ''

function hexKey(key: string) {
    return Buffer.from(key, 'utf-8').toString('hex')
}

function jwt(secret: string) {
    const now = Math.floor(Date.now() / 1000)
    const header = Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url')
    const payload = Buffer.from(JSON.stringify({ iat: now, exp: now + 300 })).toString('base64url')
    const sig = crypto.createHmac('sha256', secret)
        .update(`${header}.${payload}`)
        .digest('base64url')
    return `${header}.${payload}.${sig}`
}

function reservePort(): Promise<number> {
    return new Promise((resolve, reject) => {
        const server = net.createServer()
        server.once('error', reject)
        server.listen(0, '127.0.0.1', () => {
            const nextPort = (server.address() as net.AddressInfo).port
            server.close(() => resolve(nextPort))
        })
    })
}

async function waitForServer() {
    const deadline = Date.now() + 10_000
    while (Date.now() < deadline) {
        if (child.exitCode !== null) {
            throw new Error(`server exited early\nstdout:\n${stdout}\nstderr:\n${stderr}`)
        }
        try {
            const res = await fetch(`${base}/api/test_auth`)
            if (res.ok) return
        } catch {
            // not listening yet
        }
        await new Promise((resolve) => setTimeout(resolve, 100))
    }
    throw new Error(`server did not start\nstdout:\n${stdout}\nstderr:\n${stderr}`)
}

async function stopServer() {
    if (!child || child.exitCode !== null) return
    const exited = new Promise<void>((resolve) => child.once('exit', () => resolve()))
    child.kill('SIGTERM')
    await Promise.race([
        exited,
        new Promise<void>((resolve) => setTimeout(resolve, 3000)),
    ])
    if (child.exitCode === null) child.kill('SIGKILL')
}

function authHeaders(): Record<string, string> {
    return {
        'risu-auth': token,
        'x-session-id': 'duplicate-ids-test-session',
    }
}

async function writeKey(key: string, value: Uint8Array | Buffer | string) {
    const body = typeof value === 'string' ? Buffer.from(value) : Buffer.from(value)
    const res = await fetch(`${base}/api/write`, {
        method: 'POST',
        headers: {
            ...authHeaders(),
            'file-path': hexKey(key),
            'content-type': 'application/octet-stream',
        },
        body: body as any,
    })
    expect(res.status).toBe(200)
}

async function readKey(key: string) {
    const res = await fetch(`${base}/api/read`, {
        method: 'GET',
        headers: {
            ...authHeaders(),
            'file-path': hexKey(key),
        },
    })
    expect(res.status).toBe(200)
    return new Uint8Array(await res.arrayBuffer())
}

async function removeKey(key: string) {
    return fetch(`${base}/api/remove`, {
        method: 'GET',
        headers: {
            ...authHeaders(),
            'file-path': hexKey(key),
        },
    })
}

async function autoSweep(assets: boolean) {
    return fetch(`${base}/api/db/assets/auto-sweep`, {
        method: 'POST',
        headers: {
            ...authHeaders(),
            'content-type': 'application/json',
        },
        body: JSON.stringify({ assets }),
    })
}

function withDb<T>(fn: (db: any) => T): T {
    const db = new Database(path.join(tmpDir, 'save', 'risuai.db'))
    db.pragma('busy_timeout = 5000')
    try {
        return fn(db)
    } finally {
        db.close()
    }
}

function setUpdatedAt(key: string, updatedAt: number) {
    withDb((db) => {
        db.prepare('UPDATE kv SET updated_at = ? WHERE key = ?').run(updatedAt, key)
    })
}

function hasKey(key: string) {
    return withDb((db) => {
        const row = db.prepare('SELECT 1 AS ok FROM kv WHERE key = ?').get(key)
        return Boolean(row)
    })
}

async function seedDb(db: Record<string, unknown>) {
    await writeKey('database/database.bin', encodeRisuSaveLegacy(db))
}

async function seedReferencedDb() {
    await seedDb({
        characters: [{ chaId: 'keep', image: 'assets/live.png', chats: [] }],
    })
}

async function startServer() {
    port = await reservePort()
    base = `http://127.0.0.1:${port}`
    stdout = ''
    stderr = ''
    child = spawn(process.execPath, [SERVER_PATH], {
        cwd: tmpDir,
        env: {
            ...process.env,
            PORT: String(port),
            RISU_TUNNEL_DISABLED: 'true',
            RISU_UPDATE_CHECK: 'false',
            POCKETRISU_BACKUP_INTERVAL_MS: String(60 * 60 * 1000),
        },
    })
    child.stdout.on('data', (chunk) => { stdout += String(chunk) })
    child.stderr.on('data', (chunk) => { stderr += String(chunk) })
    await waitForServer()
    const secret = fs.readFileSync(path.join(tmpDir, 'save', '__jwt_secret'), 'utf-8').trim()
    token = jwt(secret)
}

async function restartServer() {
    await stopServer()
    await startServer()
}

beforeEach(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'duplicate-ids-test-'))
    await startServer()
})

afterEach(async () => {
    await stopServer()
    fs.rmSync(tmpDir, { recursive: true, force: true })
})


const utils = createRequire(import.meta.url)('./utils.cjs')

async function diskDb(): Promise<any> {
    const raw = withDb((db) => db.prepare('SELECT value FROM kv WHERE key = ?').get('database/database.bin'))
    return utils.normalizeJSON(await utils.decodeRisuSave(Buffer.from(raw.value)))
}

async function clientView(): Promise<any> {
    return utils.normalizeJSON(await utils.decodeRisuSave(Buffer.from(await readKey('database/database.bin'))))
}

async function openChat(chaId: string, index: number, chatId: string) {
    const res = await fetch(`${base}/api/chat-content/${encodeURIComponent(chaId)}/${index}`, { headers: { ...authHeaders(), 'x-chat-id': chatId } })
    expect(res.status).toBe(200)
    return utils.normalizeJSON(await utils.decodeRisuSave(Buffer.from(await res.arrayBuffer())))
}

// The browser's assignIds (src/ts/bootstrap.ts), copied: what it would rename.
function browserRenames(db: any): string[] {
    const seen = new Set<string>()
    const renames: string[] = []
    for (const cha of db.characters) {
        if (!cha.chaId || seen.has(cha.chaId)) renames.push(`character ${cha.chaId}`)
        seen.add(cha.chaId)
        for (const chat of cha.chats) {
            if (!chat.id || seen.has(chat.id)) renames.push(`chat ${cha.chaId}/${chat.id}`)
            seen.add(chat.id)
        }
    }
    return renames
}

const m = (data: string) => [{ role: 'user', data }]
const chat = (id: string, text: string) => ({ id, name: text, localLore: [], note: '', message: m(text) })
const char = (chaId: string, name: string, chats: unknown[]) => ({ chaId, name, type: 'character', image: '', chats, chatPage: 0 })

// Duplicate ids arrive from "all chats" imports (which kept the export's ids)
// and older data. The browser renamed the second copy on load while the
// server kept its body under the old id: the chat opened empty and the next
// save dropped the body. The server now renames on load, bodies attached.
describe('duplicate character and chat ids on disk', () => {
    it('are renamed on load with every chat keeping its own content', async () => {
        await seedDb({
            characters: [
                char('a', 'A', [chat('x', 'A original')]),
                char('b', 'B', [chat('x', 'B imported copy'), chat('y', 'B first'), chat('y', 'B second, same id')]),
            ],
            characterOrder: ['a', 'b'],
        })
        await restartServer()

        const view = await clientView()
        expect(browserRenames(view)).toEqual([])
        const [a, b] = view.characters
        expect(a.chats[0].id).toBe('x')
        expect(b.chats.map((c: any) => c.id)).not.toContain('x')
        expect(new Set(b.chats.map((c: any) => c.id)).size).toBe(3)

        expect((await openChat('a', 0, 'x')).message).toEqual(m('A original'))
        expect((await openChat('b', 0, b.chats[0].id)).message).toEqual(m('B imported copy'))
        expect((await openChat('b', 1, b.chats[1].id)).message).toEqual(m('B first'))
        expect((await openChat('b', 2, b.chats[2].id)).message).toEqual(m('B second, same id'))

        // Persisted, so the next load has nothing left to rename.
        const disk = await diskDb()
        expect(browserRenames(disk)).toEqual([])
        expect(disk.characters[1].chats.map((c: any) => c.message[0].data))
            .toEqual(['B imported copy', 'B first', 'B second, same id'])
        // Downstream repairs within-character duplicates before chat indexing;
        // the upstream load pass then repairs collisions across characters.
        const repairCounts = [...(stdout + stderr).matchAll(
            /(?:Repaired (\d+) missing or duplicate chat ID\(s\)|Renamed (\d+) duplicate character\/chat id\(s\))/g,
        )].map((match) => Number(match[1] ?? match[2]))
        expect(repairCounts.reduce((total, count) => total + count, 0)).toBe(2)
    }, 20_000)

    it('a duplicated character id moves with the character and its chats', async () => {
        await seedDb({
            characters: [
                char('same', 'First', [chat('f1', 'first bot')]),
                char('same', 'Second', [chat('s1', 'second bot')]),
            ],
            characterOrder: ['same'],
        })
        await restartServer()

        const view = await clientView()
        expect(browserRenames(view)).toEqual([])
        const second = view.characters[1]
        expect(second.name).toBe('Second')
        expect(second.chaId).not.toBe('same')
        expect((await openChat(second.chaId, 0, 's1')).message).toEqual(m('second bot'))
        expect((await openChat('same', 0, 'f1')).message).toEqual(m('first bot'))
    }, 20_000)

    it('leaves a database without duplicates untouched', async () => {
        await seedDb({ characters: [char('a', 'A', [chat('x', 'one')]), char('b', 'B', [chat('y', 'two')])], characterOrder: ['a', 'b'] })
        await restartServer()
        const view = await clientView()
        expect(view.characters.map((c: any) => [c.chaId, c.chats[0].id])).toEqual([['a', 'x'], ['b', 'y']])
        expect(stdout + stderr).not.toContain('duplicate character/chat id')
    }, 20_000)

    // A character deactivated before another chat took its chat id: coming
    // back, its chat must not keep the taken id (the browser would rename it
    // away from its body on the next load).
    it('an activated character whose chat id is taken gets a new id with its content', async () => {
        await seedDb({
            characters: [char('a', 'A', [chat('x', 'A live')])],
            characterOrder: ['a', 'b'],
            nodeOnlyArchivedCharacters: [{ chaId: 'b', name: 'B', image: '', archivedAt: 1000, chatCount: 1, chatIds: ['x'] }],
        })
        await writeKey('archive/b/1000', encodeRisuSaveLegacy({ v: 1, chaId: 'b', archivedAt: 1000, character: char('b', 'B', [chat('x', 'B archived')]) }))
        await readKey('database/database.bin')

        const res = await fetch(`${base}/api/characters/b/activate`, {
            method: 'POST', headers: { ...authHeaders(), 'content-type': 'application/json' }, body: JSON.stringify({ archivedAt: 1000 }),
        })
        expect(res.status).toBe(200)
        const back = (await res.json() as any).character
        const id = back.chats[0].id
        expect(id).not.toBe('x')
        expect(browserRenames({ characters: [{ chaId: 'a', chats: [{ id: 'x' }] }, back] })).toEqual([])
        expect((await openChat('b', 0, id)).message).toEqual(m('B archived'))
        expect((await openChat('a', 0, 'x')).message).toEqual(m('A live'))
    }, 20_000)

    // An upstream save folder copied in as-is: its first load restores a
    // cold-storage character (chats replaced wholesale) and hands the result
    // straight to the browser, so ids must be made unique after the restore.
    it('a cold-storage character restored on first load cannot bring a duplicate chat id', async () => {
        const coldKey = '3f6c1a2e-9b7d-4c1e-8f2a-5d6e7f8a9b0c'
        // Runtime cold storage rows are gzipped JSON.
        await writeKey(`coldstorage/${coldKey}`, zlib.gzipSync(JSON.stringify({
            character: char('cold', 'Cold', [chat('x', 'COLD BODY')]),
        })))
        await seedDb({
            characters: [
                char('a', 'A', [chat('x', 'A live')]),
                { name: 'Cold', chaId: 'cold', type: 'character', image: '', chatPage: 0, coldstorage: coldKey,
                  chats: [{ message: [{ role: 'char', data: '' }], note: '', name: '', localLore: [] }] },
            ],
            characterOrder: ['a', 'cold'],
        })
        await restartServer()

        const view = await clientView()
        expect(browserRenames(view)).toEqual([])
        const cold = view.characters.find((c: any) => c.chaId === 'cold')
        expect(cold.chats[0].id).not.toBe('x')
        expect((await openChat('cold', 0, cold.chats[0].id)).message).toEqual(m('COLD BODY'))
        expect((await openChat('a', 0, 'x')).message).toEqual(m('A live'))
    }, 20_000)
})

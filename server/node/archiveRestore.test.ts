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
        'x-session-id': 'archive-restore-test-session',
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
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'archive-restore-test-'))
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

function archiveRow(chaId: string, archivedAt: number, chats: unknown[]) {
    return encodeRisuSaveLegacy({
        v: 1, chaId, archivedAt,
        character: { chaId, name: 'Came back', type: 'character', image: '', firstMessage: '', desc: '', chats, chatPage: 0 },
    })
}

// A character that came back from the archive while the server holds no body
// for its chats (restart in between, or data written that way by an older
// build). The rows still hold the bodies; saves used to refuse the whole
// database ("persist aborted ... re-activate them") on every action.
function liveWithStubs(stubs: unknown[]) {
    return {
        characters: [
            { chaId: 'back', name: 'Came back', type: 'character', image: '', chats: stubs, chatPage: 0 },
            { chaId: 'other', name: 'Other', type: 'character', image: '', chats: [{ id: 'o1', name: 'o', message: [{ role: 'user', data: 'other' }] }], chatPage: 0 },
        ],
        characterOrder: ['back', 'other'],
    }
}

describe('reactivated characters whose chat bodies only the archive rows hold', () => {
    it('a full write restores the bodies from the newest row that has them', async () => {
        const stubs = [
            { id: 'c1', name: 'Renamed later', _stub: true, lastDate: 5 },
            { id: 'c2', name: 'Two', _stub: true },
        ]
        // Already in the database when the rows exist (a character that is
        // new to the database is refused by the insert guard instead).
        await seedDb(liveWithStubs(stubs))
        await writeKey('archive/back/1000', archiveRow('back', 1000, [
            { id: 'c1', name: 'Old', message: [{ role: 'user', data: 'older row' }] },
            { id: 'c2', name: 'Only here', message: [{ role: 'user', data: 'only in the old row' }] },
        ]))
        await writeKey('archive/back/2000', archiveRow('back', 2000, [
            { id: 'c1', name: 'New', message: [{ role: 'user', data: 'newer row' }] },
        ]))
        await seedDb(liveWithStubs([
            { id: 'c1', name: 'Renamed later', _stub: true, lastDate: 5 },
            { id: 'c2', name: 'Two', _stub: true },
        ]))

        const back = (await diskDb()).characters.find((c: any) => c.chaId === 'back')
        expect(back.chats[0]).toMatchObject({ id: 'c1', name: 'Renamed later', lastDate: 5, message: [{ role: 'user', data: 'newer row' }] })
        expect(back.chats[0]._stub).toBeUndefined()
        expect(back.chats[1]).toMatchObject({ id: 'c2', name: 'Two', message: [{ role: 'user', data: 'only in the old row' }] })
    })

    it('a chat no row holds does not block the save and stays as it was', async () => {
        const stubs = [
            { id: 'c1', name: 'One', _stub: true },
            { id: 'ghost', name: 'Nowhere', _stub: true },
        ]
        await seedDb(liveWithStubs(stubs))
        await writeKey('archive/back/1000', archiveRow('back', 1000, [
            { id: 'c1', name: 'One', message: [{ role: 'user', data: 'kept' }] },
        ]))
        await seedDb(liveWithStubs(stubs))

        const db = await diskDb()
        const back = db.characters.find((c: any) => c.chaId === 'back')
        expect(back.chats[0].message).toEqual([{ role: 'user', data: 'kept' }])
        expect(back.chats[1]).toMatchObject({ id: 'ghost', _stub: true })
        expect(db.characters.find((c: any) => c.chaId === 'other').chats[0].message).toEqual([{ role: 'user', data: 'other' }])
    })

    it('the debounced persist after a chat save restores them too, instead of aborting', async () => {
        // Disk first holds the stub with no row yet, as an older build left it.
        await seedDb(liveWithStubs([{ id: 'c1', name: 'One', _stub: true }]))
        await writeKey('archive/back/1000', archiveRow('back', 1000, [
            { id: 'c1', name: 'One', message: [{ role: 'user', data: 'from the row' }] },
        ]))
        await readKey('database/database.bin') // warm dbCache: the persist path below

        const res = await fetch(`${base}/api/chat-content/other/0`, {
            method: 'POST',
            headers: { ...authHeaders(), 'content-type': 'application/json', 'x-chat-id': 'o1' },
            body: JSON.stringify({ id: 'o1', name: 'o', message: [{ role: 'user', data: 'other, edited' }] }),
        })
        expect(res.status).toBe(200)
        await new Promise((resolve) => setTimeout(resolve, 6500))

        expect(stdout + stderr).not.toContain('persist aborted')
        const db = await diskDb()
        expect(db.characters.find((c: any) => c.chaId === 'back').chats[0].message).toEqual([{ role: 'user', data: 'from the row' }])
        expect(db.characters.find((c: any) => c.chaId === 'other').chats[0].message).toEqual([{ role: 'user', data: 'other, edited' }])
    }, 15_000)

    // Restart with such a character on disk, then open the chat before any
    // save: it must come back with its history, not as an empty chat the
    // next edit would make permanent.
    it('after a restart the chat opens with the history the archive row holds', async () => {
        await seedDb(liveWithStubs([{ id: 'c1', name: 'One', _stub: true }]))
        await writeKey('archive/back/1000', archiveRow('back', 1000, [
            { id: 'c1', name: 'One', message: [{ role: 'user', data: 'from the row' }] },
        ]))
        await restartServer()

        const opened = await fetch(`${base}/api/chat-content/back/0`, { headers: { ...authHeaders(), 'x-chat-id': 'c1' } })
        expect(opened.status).toBe(200)
        const chat = utils.normalizeJSON(await utils.decodeRisuSave(Buffer.from(await opened.arrayBuffer())))
        expect(chat.message).toEqual([{ role: 'user', data: 'from the row' }])
        expect(chat._stub).toBeUndefined()

        // The edit the user makes next keeps the history in front of it.
        const saved = await fetch(`${base}/api/chat-content/back/0`, {
            method: 'POST',
            headers: { ...authHeaders(), 'content-type': 'application/json', 'x-chat-id': 'c1' },
            body: JSON.stringify({ ...chat, message: [...chat.message, { role: 'char', data: 'reply' }] }),
        })
        expect(saved.status).toBe(200)
        await new Promise((resolve) => setTimeout(resolve, 6500))
        const back = (await diskDb()).characters.find((c: any) => c.chaId === 'back')
        expect(back.chats[0].message).toEqual([{ role: 'user', data: 'from the row' }, { role: 'char', data: 'reply' }])
    }, 20_000)

    // A legacy hybrid chat (`_stub: true` with its messages still inline)
    // already has its body, possibly newer than the row: loading only drops
    // the flag, and must never swap the body for the archived one.
    it('leaves a hybrid chat that carries its own messages untouched on load', async () => {
        await seedDb(liveWithStubs([{ id: 'c1', name: 'One', _stub: true }]))
        await writeKey('archive/back/1000', archiveRow('back', 1000, [
            { id: 'c1', name: 'One', message: [{ role: 'user', data: 'older, in the row' }] },
        ]))
        await stopServer()
        withDb((db) => {
            const hybrid = encodeRisuSaveLegacy(liveWithStubs([
                { id: 'c1', name: 'One', _stub: true, message: [{ role: 'user', data: 'newer, on disk' }] },
            ]))
            db.prepare('UPDATE kv SET value = ? WHERE key = ?').run(Buffer.from(hybrid), 'database/database.bin')
        })
        await startServer()

        const opened = await fetch(`${base}/api/chat-content/back/0`, { headers: { ...authHeaders(), 'x-chat-id': 'c1' } })
        expect(opened.status).toBe(200)
        const chat = utils.normalizeJSON(await utils.decodeRisuSave(Buffer.from(await opened.arrayBuffer())))
        expect(chat.message).toEqual([{ role: 'user', data: 'newer, on disk' }])
    }, 20_000)
})

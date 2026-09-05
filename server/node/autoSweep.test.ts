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
        'x-session-id': 'auto-sweep-test-session',
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

beforeEach(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'auto-sweep-test-'))
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
})

afterEach(async () => {
    await stopServer()
    fs.rmSync(tmpDir, { recursive: true, force: true })
})

describe('/api/db/assets/auto-sweep', () => {
    it('deletes orphan assets older than 7 days and preserves recent candidates', async () => {
        await seedReferencedDb()
        await writeKey('assets/live.png', 'live')
        await writeKey('assets/old.png', 'old')
        await writeKey('assets/recent.png', 'recent')
        setUpdatedAt('assets/live.png', Date.now() - 8 * DAY)
        setUpdatedAt('assets/old.png', Date.now() - 8 * DAY)
        setUpdatedAt('assets/recent.png', Date.now() - DAY)

        const res = await autoSweep(true)
        expect(res.status).toBe(200)
        const body = await res.json()
        expect(body).toMatchObject({ ok: true, assetsDeleted: 1 })
        expect(hasKey('assets/live.png')).toBe(true)
        expect(hasKey('assets/old.png')).toBe(false)
        expect(hasKey('assets/recent.png')).toBe(true)
    })

    it('leaves assets untouched when assets=false and still sweeps remotes', async () => {
        await seedReferencedDb()
        await writeKey('assets/old.png', 'old')
        await writeKey('remotes/orphan.local.bin', 'remote')
        await writeKey('remotes/orphan.local.bin.meta', JSON.stringify({ lastUsed: Date.now() - 8 * DAY }))
        setUpdatedAt('assets/old.png', Date.now() - 8 * DAY)
        setUpdatedAt('remotes/orphan.local.bin', Date.now() - 8 * DAY)

        const res = await autoSweep(false)
        expect(res.status).toBe(200)
        const body = await res.json()
        expect(body.assetsDeleted).toBe(0)
        expect(body.remotesDeleted).toBe(2)
        expect(hasKey('assets/old.png')).toBe(true)
        expect(hasKey('remotes/orphan.local.bin')).toBe(false)
        expect(hasKey('remotes/orphan.local.bin.meta')).toBe(false)
    })

    it('refuses to purge when the reference scan returns no references', async () => {
        await seedDb({ characters: [] })
        await writeKey('assets/old.png', 'old')
        setUpdatedAt('assets/old.png', Date.now() - 8 * DAY)

        const res = await autoSweep(true)
        expect(res.status).toBe(400)
        const body = await res.json()
        expect(body.error).toContain('Reference scan produced no references')
        expect(hasKey('assets/old.png')).toBe(true)
    })

    it('preserves paths referenced only by a live asset manifest', async () => {
        await seedDb({
            characters: [{ chaId: 'keep', image: 'assets/avatar.png', chats: [] }],
            modules: [{ id: 'module-a', name: 'pack', assets: [['only-manifest', 'assets/manifest.png', 'png']] }],
        })
        // Reading the database builds the lazy client view and activates the
        // module manifest. Then emulate a future slim on-disk blob containing
        // only its descriptor so the sweep must consult the manifest table.
        await readKey('database/database.bin')
        const descriptor = withDb((db) => db.prepare(`
            SELECT m.manifest_id AS id, m.item_count AS count, m.content_hash AS sha256
            FROM asset_manifest_live l
            JOIN asset_manifests m ON m.manifest_id = l.manifest_id
            WHERE m.owner_kind = 'module' AND m.owner_id = 'module-a'
        `).get())
        expect(descriptor?.id).toBeTruthy()
        withDb((db) => {
            const stripped = encodeRisuSaveLegacy({
                characters: [{ chaId: 'keep', image: 'assets/avatar.png', chats: [] }],
                modules: [{
                    id: 'module-a',
                    name: 'pack',
                    assetManifest: {
                        ...descriptor,
                        version: 1,
                        ownerKind: 'module',
                        ownerId: 'module-a',
                    },
                }],
            })
            db.prepare('UPDATE kv SET value = ?, updated_at = ? WHERE key = ?')
                .run(Buffer.from(stripped), Date.now(), 'database/database.bin')
        })
        await writeKey('assets/avatar.png', 'avatar')
        await writeKey('assets/manifest.png', 'manifest')
        await writeKey('assets/orphan.png', 'orphan')
        for (const key of ['assets/avatar.png', 'assets/manifest.png', 'assets/orphan.png']) {
            setUpdatedAt(key, Date.now() - 8 * DAY)
        }

        const res = await autoSweep(true)
        expect(res.status).toBe(200)
        expect(hasKey('assets/avatar.png')).toBe(true)
        expect(hasKey('assets/manifest.png')).toBe(true)
        expect(hasKey('assets/orphan.png')).toBe(false)
    })

    it('fails closed without deleting assets when a live manifest is corrupt', async () => {
        await seedDb({
            characters: [{ chaId: 'keep', image: 'assets/avatar.png', chats: [] }],
            modules: [{ id: 'module-a', name: 'pack', assets: [['live', 'assets/live.png', 'png']] }],
        })
        await readKey('database/database.bin')
        withDb((db) => {
            db.prepare(`
                UPDATE asset_manifests SET payload = ?
                WHERE manifest_id = (
                    SELECT manifest_id FROM asset_manifest_live
                    WHERE owner_kind = 'module' AND owner_id = 'module-a'
                )
            `).run(Buffer.from('corrupt'))
        })
        await writeKey('assets/avatar.png', 'avatar')
        await writeKey('assets/live.png', 'live')
        await writeKey('assets/would-be-orphan.png', 'orphan')
        for (const key of ['assets/avatar.png', 'assets/live.png', 'assets/would-be-orphan.png']) {
            setUpdatedAt(key, Date.now() - 8 * DAY)
        }

        const res = await autoSweep(true)
        expect(res.status).toBe(400)
        expect(hasKey('assets/avatar.png')).toBe(true)
        expect(hasKey('assets/live.png')).toBe(true)
        expect(hasKey('assets/would-be-orphan.png')).toBe(true)
    })

    it('sweeps stale remote caches, preserves recent ones, creates missing meta, and removes orphan meta', async () => {
        await seedReferencedDb()
        await writeKey('remotes/keep.local.bin', 'remote-live')
        await writeKey('remotes/keep.local.bin.meta', JSON.stringify({ lastUsed: Date.now() - 8 * DAY }))
        await writeKey('remotes/old.local.bin', 'remote-old')
        await writeKey('remotes/old.local.bin.meta', JSON.stringify({ lastUsed: Date.now() - 8 * DAY }))
        await writeKey('remotes/recent.local.bin', 'remote-recent')
        await writeKey('remotes/recent.local.bin.meta', JSON.stringify({ lastUsed: Date.now() - DAY }))
        await writeKey('remotes/no-meta.local.bin', 'remote-no-meta')
        await writeKey('remotes/orphan.local.bin.meta', JSON.stringify({ lastUsed: Date.now() - 8 * DAY }))
        for (const key of [
            'remotes/keep.local.bin',
            'remotes/old.local.bin',
            'remotes/recent.local.bin',
            'remotes/no-meta.local.bin',
        ]) {
            setUpdatedAt(key, Date.now() - 8 * DAY)
        }

        const res = await autoSweep(false)
        expect(res.status).toBe(200)
        const body = await res.json()
        expect(body.remotesDeleted).toBe(3)
        expect(hasKey('remotes/keep.local.bin')).toBe(true)
        expect(hasKey('remotes/old.local.bin')).toBe(false)
        expect(hasKey('remotes/old.local.bin.meta')).toBe(false)
        expect(hasKey('remotes/recent.local.bin')).toBe(true)
        expect(hasKey('remotes/recent.local.bin.meta')).toBe(true)
        expect(hasKey('remotes/no-meta.local.bin')).toBe(true)
        expect(hasKey('remotes/no-meta.local.bin.meta')).toBe(true)
        expect(hasKey('remotes/orphan.local.bin.meta')).toBe(false)
    })
})

describe('/api/remove asset guard', () => {
    it('blocks direct assets/remotes removal and leaves other prefixes removable', async () => {
        await seedReferencedDb()
        await writeKey('assets/blocked.png', 'asset')
        await writeKey('remotes/blocked.local.bin.meta', '{}')
        await writeKey('database/dbbackup-123.bin', 'backup')

        const assetRes = await removeKey('assets/blocked.png')
        expect(assetRes.status).toBe(409)
        expect(await assetRes.json()).toEqual({
            error: 'asset removal must go through server-side cleanup',
        })
        const remoteMetaRes = await removeKey('remotes/blocked.local.bin.meta')
        expect(remoteMetaRes.status).toBe(409)

        const backupRes = await removeKey('database/dbbackup-123.bin')
        expect(backupRes.status).toBe(200)
        expect(await backupRes.json()).toEqual({ success: true })
        expect(hasKey('assets/blocked.png')).toBe(true)
        expect(hasKey('remotes/blocked.local.bin.meta')).toBe(true)
        expect(hasKey('database/dbbackup-123.bin')).toBe(false)
    })
})

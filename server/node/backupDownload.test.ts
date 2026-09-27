import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import crypto from 'node:crypto'
import fs from 'node:fs'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

// Backup GETs are opened as plain browser downloads (<a download>): they must
// accept the session cookie as well as the risu-auth header, and nothing else.

const HERE = path.dirname(fileURLToPath(import.meta.url))
const SERVER_PATH = path.join(HERE, 'server.cjs')

let tmpDir: string
let base: string
let child: ChildProcessWithoutNullStreams
let token: string
let stdout = ''
let stderr = ''

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

async function sessionCookie() {
    // Same call the client makes before a download: no x-session-id.
    const res = await fetch(`${base}/api/session`, { method: 'POST', headers: { 'risu-auth': token } })
    expect(res.status).toBe(200)
    const cookie = res.headers.get('set-cookie') ?? ''
    expect(cookie).toContain('HttpOnly')
    expect(cookie).toContain('SameSite=Strict')
    return cookie.split(';')[0]
}

beforeEach(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'backup-download-test-'))
    const port = await reservePort()
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

describe('backup downloads', () => {
    it('serves a server backup file to the session cookie alone', async () => {
        const name = 'risu-backup-1700000000000.bin'
        fs.mkdirSync(path.join(tmpDir, 'backups'), { recursive: true })
        fs.writeFileSync(path.join(tmpDir, 'backups', name), 'backup-bytes')

        const res = await fetch(`${base}/api/backup/server/download/${name}`, {
            headers: { cookie: await sessionCookie() },
        })
        expect(res.status).toBe(200)
        expect(res.headers.get('content-disposition')).toContain(name)
        expect(await res.text()).toBe('backup-bytes')
    })

    it('starts a backup export on the session cookie alone', async () => {
        const res = await fetch(`${base}/api/backup/export`, {
            headers: { cookie: await sessionCookie() },
        })
        expect(res.status).not.toBe(400)
        expect(res.status).not.toBe(401)
        await res.body?.cancel()
    })

    it('still accepts the risu-auth header', async () => {
        const name = 'risu-backup-1700000000001.bin'
        fs.mkdirSync(path.join(tmpDir, 'backups'), { recursive: true })
        fs.writeFileSync(path.join(tmpDir, 'backups', name), 'header-bytes')

        const res = await fetch(`${base}/api/backup/server/download/${name}`, {
            headers: { 'risu-auth': token },
        })
        expect(res.status).toBe(200)
        expect(await res.text()).toBe('header-bytes')
    })

    it('refuses requests with neither a valid cookie nor the header', async () => {
        const name = 'risu-backup-1700000000002.bin'
        fs.mkdirSync(path.join(tmpDir, 'backups'), { recursive: true })
        fs.writeFileSync(path.join(tmpDir, 'backups', name), 'secret')

        for (const headers of [{}, { cookie: 'risu-session=not-a-session' }] as Record<string, string>[]) {
            const download = await fetch(`${base}/api/backup/server/download/${name}`, { headers })
            expect(download.status).toBe(400)
            const exported = await fetch(`${base}/api/backup/export`, { headers })
            expect(exported.status).toBe(400)
        }
    })
})

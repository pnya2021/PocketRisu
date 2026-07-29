import { createHash } from 'node:crypto'
import { EventEmitter } from 'node:events'
import * as fs from 'node:fs/promises'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { PassThrough } from 'node:stream'
import { afterEach, describe, expect, it, vi } from 'vitest'

const require = createRequire(import.meta.url)
const PROFILE_ID = 'tiny-pixai-test'
const PRINCIPAL_A = '11111111-1111-4111-8111-111111111111'
const PRINCIPAL_B = '22222222-2222-4222-8222-222222222222'
const TINY_BYTES = Buffer.from('tiny-pocket-pixai-download')
const TINY_DIGEST = 'a707fe5aebb9cd1d8d02234afffb1d94d3c0118068709075853d03a5c5d42826'
const INITIAL_URL = 'https://huggingface.co/deepghs/pixai-tagger-v0.9-onnx/resolve/d8cf666911a2c3d10d586d7823259192313c7eb7/model.onnx'
const CDN_URL = 'https://us.aws.cdn.hf.co/xet-bridge-us/object?X-Amz-Date=20260727T000000Z&X-Amz-Signature=signed'

type Artifact = {
    profileId: string
    revision: string
    name: string
    url: string
    bytes: number
    sha256: string
}

type Profile = {
    id: string
    revision: string
    totalBytes: number
    artifacts: readonly Artifact[]
}

type ResponseScript = {
    status?: number
    headers?: Array<[string, string]>
    chunks?: readonly Uint8Array[]
    start?: (response: PassThrough) => void
}

const roots = new Set<string>()
const tempBase = path.resolve(tmpdir())
const tempPrefix = `${tempBase}${path.sep}`

function profile(overrides: Partial<Artifact> = {}): Profile {
    const artifact = Object.freeze({
        profileId: PROFILE_ID,
        revision: 'tiny-r1',
        name: 'tiny.bin',
        url: INITIAL_URL,
        bytes: TINY_BYTES.byteLength,
        sha256: TINY_DIGEST,
        ...overrides,
    })
    return Object.freeze({
        id: PROFILE_ID,
        revision: artifact.revision,
        totalBytes: artifact.bytes,
        artifacts: Object.freeze([artifact]),
    })
}

function registry(value = profile()) {
    return Object.freeze({
        getProfile(profileId: unknown) {
            if (typeof profileId !== 'string' || profileId !== value.id) {
                throw new Error('Unknown model profile')
            }
            return value
        },
    })
}

async function makeRoot(): Promise<string> {
    const root = path.resolve(await fs.mkdtemp(path.join(tempBase, 'pocket-pixai-p2-')))
    if (!root.startsWith(tempPrefix)) throw new Error('temporary root escaped temp directory')
    roots.add(root)
    return root
}

afterEach(async () => {
    for (const root of roots) {
        const resolved = path.resolve(root)
        if (!resolved.startsWith(tempPrefix)) throw new Error('refusing non-temp cleanup')
        await fs.rm(resolved, { recursive: true, force: true })
    }
    roots.clear()
})

function publicLookup(addresses: Array<{ address: string; family: 4 | 6 }> = [
    { address: '93.184.216.34', family: 4 },
]) {
    return vi.fn(async () => addresses)
}

function scriptedNetwork(inputScripts: ResponseScript[]) {
    const scripts = [...inputScripts]
    const calls: any[] = []
    const requests: any[] = []
    const request = (options: any, onResponse: (response: PassThrough) => void) => {
        const outgoing = new EventEmitter() as any
        let response: PassThrough | undefined
        outgoing.destroyed = false
        outgoing.setTimeout = () => outgoing
        outgoing.end = () => {
            queueMicrotask(() => {
                if (outgoing.destroyed) return
                const script = scripts.shift()
                if (!script) {
                    outgoing.emit('error', new Error('unexpected HTTPS request'))
                    return
                }
                response = new PassThrough()
                response.on('error', () => undefined)
                const headerEntries = script.headers ?? []
                const headers: Record<string, string | string[]> = {}
                for (const [name, value] of headerEntries) {
                    const key = name.toLowerCase()
                    const current = headers[key]
                    headers[key] = current === undefined
                        ? value
                        : Array.isArray(current) ? [...current, value] : [current, value]
                }
                Object.assign(response, {
                    statusCode: script.status ?? 200,
                    headers,
                    rawHeaders: headerEntries.flat(),
                })
                onResponse(response)
                if (script.start) {
                    script.start(response)
                    return
                }
                queueMicrotask(() => {
                    for (const chunk of script.chunks ?? []) response?.write(Buffer.from(chunk))
                    response?.end()
                })
            })
        }
        outgoing.destroy = (error?: Error) => {
            if (outgoing.destroyed) return outgoing
            outgoing.destroyed = true
            if (response) response.destroy(error)
            else if (error) queueMicrotask(() => outgoing.emit('error', error))
            return outgoing
        }
        calls.push(options)
        requests.push(outgoing)
        return outgoing
    }
    return { request, calls, requests, remaining: () => scripts.length }
}

async function makeStore(value = profile()) {
    const root = await makeRoot()
    const { createPluginModelStore } = require('./pluginModelStore.cjs')
    const store = createPluginModelStore({
        root,
        manifest: {
            revision: value.revision,
            artifacts: value.artifacts.map((artifact) => ({
                name: artifact.name,
                bytes: artifact.bytes,
                sha256: artifact.sha256,
            })),
        },
    })
    return { root, store }
}

async function harness(options: {
    value?: Profile
    scripts?: ResponseScript[]
    addresses?: Array<{ address: string; family: 4 | 6 }>
    lookup?: (...args: any[]) => Promise<unknown>
    lookupTimeoutMs?: number
    store?: any
    sessions?: any
} = {}) {
    const value = options.value ?? profile()
    const stored = options.store ? { root: '', store: options.store } : await makeStore(value)
    const network = scriptedNetwork(options.scripts ?? [])
    const lookup = options.lookup ?? publicLookup(options.addresses)
    const { createPluginModelDownloadService } = require('./pluginModelDownload.cjs')
    const service = createPluginModelDownloadService({
        store: stored.store,
        registry: registry(value),
        lookup,
        lookupTimeoutMs: options.lookupTimeoutMs,
        request: network.request,
        ...(options.sessions ? { sessions: options.sessions } : {}),
    })
    return { ...stored, service, network, lookup, value }
}

async function expectCode(promise: Promise<unknown>, code: string) {
    await expect(promise).rejects.toMatchObject({ code })
}

describe('Pocket PixAI secure download service', () => {
    it('defers removal through the active-session barrier without touching artifacts', async () => {
        const sessions = {
            isRemovalPending: vi.fn(() => false),
            removeWithBarrier: vi.fn(async () => ({ purgedBytes: 0, pending: true })),
        }
        const h = await harness({ sessions })

        await expect(h.service.remove(PROFILE_ID)).resolves.toEqual({ purgedBytes: 0, pending: true })
        expect(sessions.removeWithBarrier).toHaveBeenCalledWith(PROFILE_ID, expect.any(Function))
    })

    it('rejects an unknown or hostile profile before storage, DNS, or HTTPS work', async () => {
        const stat = vi.fn()
        const lookup = vi.fn()
        const request = vi.fn()
        const { createPluginModelDownloadService } = require('./pluginModelDownload.cjs')
        const service = createPluginModelDownloadService({
            store: { stat },
            lookup,
            request,
        })
        let accessed = false
        const hostile = Object.defineProperty({}, 'id', {
            enumerable: true,
            get() {
                accessed = true
                throw new Error('getter must not run')
            },
        })

        await expect(service.status('other-profile')).rejects.toThrow(/profile/i)
        await expect(service.status(hostile)).rejects.toThrow(/profile/i)
        expect(accessed).toBe(false)
        expect(stat).not.toHaveBeenCalled()
        expect(lookup).not.toHaveBeenCalled()
        expect(request).not.toHaveBeenCalled()
    })

    it('downloads exact bytes through a DNS-pinned TLS request and reports verified status', async () => {
        const h = await harness({
            scripts: [{
                headers: [['Content-Length', '26'], ['ETag', '"tiny"']],
                chunks: [TINY_BYTES.subarray(0, 9), TINY_BYTES.subarray(9)],
            }],
        })

        const started = h.service.download(PROFILE_ID, PRINCIPAL_A)
        await expect(started.promise).resolves.toEqual({ state: 'verified', bytes: 26 })
        expect(started.joined).toBe(false)
        expect(await h.service.status(PROFILE_ID)).toMatchObject({
            state: 'verified',
            storedBytes: 26,
            totalBytes: 26,
            artifacts: [{ name: 'tiny.bin', state: 'verified', storedBytes: 26 }],
            storage: { kind: 'node', persistent: true, resumable: true },
        })

        expect(h.network.calls).toHaveLength(1)
        const request = h.network.calls[0]
        expect(request).toMatchObject({
            protocol: 'https:',
            hostname: 'huggingface.co',
            port: 443,
            method: 'GET',
            servername: 'huggingface.co',
            rejectUnauthorized: true,
            agent: false,
            headers: {
                Host: 'huggingface.co',
                'Accept-Encoding': 'identity',
            },
        })
        expect(typeof request.lookup).toBe('function')
        await expect(new Promise((resolve, reject) => request.lookup(
            'huggingface.co',
            { all: true },
            (error: Error | null, addresses: unknown) => error ? reject(error) : resolve(addresses),
        ))).resolves.toEqual([{ address: '93.184.216.34', family: 4 }])
    })

    it('follows exactly one reviewed Xet redirect and revalidates DNS on the new hop', async () => {
        const h = await harness({
            scripts: [
                { status: 302, headers: [['Location', CDN_URL]] },
                { headers: [['Content-Length', '26']], chunks: [TINY_BYTES] },
            ],
        })

        await expect(h.service.download(PROFILE_ID, PRINCIPAL_A).promise)
            .resolves.toMatchObject({ state: 'verified' })
        expect(h.lookup).toHaveBeenCalledTimes(2)
        expect(h.network.calls.map((call) => call.hostname)).toEqual([
            'huggingface.co',
            'us.aws.cdn.hf.co',
        ])
    })

    it.each([
        ['evil origin', 'https://evil.example/xet-bridge-us/object'],
        ['wrong path', 'https://us.aws.cdn.hf.co/not-xet/object'],
        ['unknown query', 'https://us.aws.cdn.hf.co/xet-bridge-us/object?redirect=evil'],
        ['explicit port', 'https://us.aws.cdn.hf.co:443/xet-bridge-us/object'],
        ['credentials', 'https://user:pass@us.aws.cdn.hf.co/xet-bridge-us/object'],
        ['traversal', 'https://us.aws.cdn.hf.co/xet-bridge-us/%252e%252e%252fsecret'],
    ])('rejects a redirect with %s before a second request', async (_label, location) => {
        const h = await harness({ scripts: [{ status: 302, headers: [['Location', location]] }] })

        await expectCode(h.service.download(PROFILE_ID, PRINCIPAL_A).promise, 'NETWORK_ERROR')
        expect(h.network.calls).toHaveLength(1)
    })

    it('rejects a second redirect', async () => {
        const h = await harness({
            scripts: [
                { status: 302, headers: [['Location', CDN_URL]] },
                { status: 307, headers: [['Location', CDN_URL]] },
            ],
        })

        await expectCode(h.service.download(PROFILE_ID, PRINCIPAL_A).promise, 'NETWORK_ERROR')
        expect(h.network.calls).toHaveLength(2)
    })

    it.each([
        ['empty', []],
        ['mixed private', [
            { address: '93.184.216.34', family: 4 as const },
            { address: '127.0.0.1', family: 4 as const },
        ]],
        ['CGNAT', [{ address: '100.64.0.1', family: 4 as const }]],
        ['documentation', [{ address: '203.0.113.10', family: 4 as const }]],
        ['mapped IPv6', [{ address: '::ffff:5db8:d822', family: 6 as const }]],
        ['link-local IPv6', [{ address: 'fe80::1', family: 6 as const }]],
        ['multicast IPv6', [{ address: 'ff02::1', family: 6 as const }]],
    ])('rejects %s DNS answers before HTTPS', async (_label, addresses) => {
        const h = await harness({ scripts: [{ chunks: [TINY_BYTES] }], addresses: [...addresses] })

        await expectCode(h.service.download(PROFILE_ID, PRINCIPAL_A).promise, 'NETWORK_ERROR')
        expect(h.network.calls).toHaveLength(0)
    })

    it.each([
        ['declared one-over', [['Content-Length', '27']] as Array<[string, string]>, [TINY_BYTES]],
        ['streamed one-over', [] as Array<[string, string]>, [TINY_BYTES, Buffer.of(1)]],
        ['short body', [['Content-Length', '25']] as Array<[string, string]>, [TINY_BYTES.subarray(0, 25)]],
    ])('rejects a %s response without promoting it', async (_label, headers, chunks) => {
        const h = await harness({ scripts: [{ headers, chunks }] })

        await expectCode(h.service.download(PROFILE_ID, PRINCIPAL_A).promise, 'INTEGRITY_ERROR')
        expect((await h.store.stat('tiny.bin')).state).not.toBe('verified')
    })

    it('rejects a wrong SHA-256 and discards the untrusted bytes', async () => {
        const wrong = profile({ sha256: '0'.repeat(64) })
        const h = await harness({ value: wrong, scripts: [{ chunks: [TINY_BYTES] }] })

        await expectCode(h.service.download(PROFILE_ID, PRINCIPAL_A).promise, 'INTEGRITY_ERROR')
        expect(await h.store.stat('tiny.bin')).toEqual({ state: 'absent', bytes: 0 })
    })

    it('classifies a response-stream failure as network and preserves an ETag partial', async () => {
        const h = await harness({
            scripts: [{
                headers: [['ETag', '"tiny"']],
                start(response) {
                    setTimeout(() => {
                        response.write(TINY_BYTES.subarray(0, 8))
                        setImmediate(() => response.destroy(new Error('injected socket reset')))
                    }, 20)
                },
            }],
        })

        await expectCode(h.service.download(PROFILE_ID, PRINCIPAL_A).promise, 'NETWORK_ERROR')
        await vi.waitFor(async () => {
            expect(await h.store.stat('tiny.bin')).toMatchObject({
                state: 'partial',
                bytes: 8,
                etag: '"tiny"',
            })
        }, { timeout: 5_000 })
    })

    it('discards an existing partial when DNS policy fails', async () => {
        const h = await harness({ addresses: [{ address: '127.0.0.1', family: 4 }] })
        const writer = await h.store.beginWrite('tiny.bin', { etag: '"tiny"' })
        await writer.write(TINY_BYTES.subarray(0, 8))
        await writer.abort({ keepPartial: true })

        await expectCode(h.service.download(PROFILE_ID, PRINCIPAL_A).promise, 'NETWORK_ERROR')
        expect(await h.store.stat('tiny.bin')).toEqual({ state: 'absent', bytes: 0 })
    })

    it('preserves an ETag partial after a transient DNS resolver error', async () => {
        const lookup = vi.fn(async () => { throw new Error('temporary resolver failure') })
        const h = await harness({ lookup })
        const writer = await h.store.beginWrite('tiny.bin', { etag: '"tiny"' })
        await writer.write(TINY_BYTES.subarray(0, 8))
        await writer.abort({ keepPartial: true })

        await expectCode(h.service.download(PROFILE_ID, PRINCIPAL_A).promise, 'NETWORK_ERROR')
        expect(await h.store.stat('tiny.bin')).toMatchObject({
            state: 'partial',
            bytes: 8,
            etag: '"tiny"',
        })
    })

    it('bounds a hung DNS lookup and preserves an ETag partial on timeout', async () => {
        const lookup = vi.fn(() => new Promise(() => undefined))
        const h = await harness({ lookup, lookupTimeoutMs: 20 })
        const writer = await h.store.beginWrite('tiny.bin', { etag: '"tiny"' })
        await writer.write(TINY_BYTES.subarray(0, 8))
        await writer.abort({ keepPartial: true })
        const started = h.service.download(PROFILE_ID, PRINCIPAL_A)

        const outcome = await Promise.race([
            started.promise.then(
                () => 'resolved',
                (error: any) => error?.code,
            ),
            new Promise((resolve) => setTimeout(() => resolve('hung'), 250)),
        ])
        expect(outcome).toBe('NETWORK_ERROR')
        expect(await h.store.stat('tiny.bin')).toMatchObject({ state: 'partial', bytes: 8 })
        expect(h.network.calls).toHaveLength(0)
    })

    it('never forwards a hostile persisted ETag and restarts from zero', async () => {
        const h = await harness({
            scripts: [{ headers: [['Content-Length', '26']], chunks: [TINY_BYTES] }],
        })
        const writer = await h.store.beginWrite('tiny.bin', { etag: '"tiny"' })
        await writer.write(TINY_BYTES.subarray(0, 8))
        await writer.abort({ keepPartial: true })
        await fs.writeFile(path.join(h.root, `${TINY_DIGEST}.json`), JSON.stringify({
            version: 1,
            digest: TINY_DIGEST,
            expectedBytes: 26,
            revision: 'tiny-r1',
            state: 'partial',
            etag: 'bad\r\netag',
        }))

        await expect(h.service.download(PROFILE_ID, PRINCIPAL_A).promise)
            .resolves.toMatchObject({ state: 'verified' })
        expect(h.network.calls[0].headers.Range).toBeUndefined()
        expect(h.network.calls[0].headers['If-Range']).toBeUndefined()
    })

    it('splits a large network chunk into P1-bounded writes', async () => {
        const size = 1_048_579
        const bytes = Buffer.alloc(size, 7)
        const value = profile({
            bytes: size,
            sha256: createHash('sha256').update(bytes).digest('hex'),
        })
        const h = await harness({ value, scripts: [{ chunks: [bytes] }] })

        await expect(h.service.download(PROFILE_ID, PRINCIPAL_A).promise)
            .resolves.toEqual({ state: 'verified', bytes: size })
    })

    it('rehashes and resumes a real P1 partial with exact Range, If-Range, and Content-Range', async () => {
        const h = await harness({
            scripts: [{
                status: 206,
                headers: [
                    ['ETag', '"tiny"'],
                    ['Content-Length', '17'],
                    ['Content-Range', 'bytes 9-25/26'],
                ],
                chunks: [TINY_BYTES.subarray(9)],
            }],
        })
        const writer = await h.store.beginWrite('tiny.bin', { etag: '"tiny"' })
        await writer.write(TINY_BYTES.subarray(0, 9))
        await writer.abort({ keepPartial: true })

        await expect(h.service.download(PROFILE_ID, PRINCIPAL_A).promise)
            .resolves.toEqual({ state: 'verified', bytes: 26 })
        expect(h.network.calls[0].headers).toMatchObject({
            Range: 'bytes=9-',
            'If-Range': '"tiny"',
        })
    })

    it('discards an invalid resume response and performs exactly one fresh retry', async () => {
        const h = await harness({
            scripts: [
                {
                    status: 206,
                    headers: [
                        ['ETag', '"changed"'],
                        ['Content-Length', '17'],
                        ['Content-Range', 'bytes 9-25/26'],
                    ],
                    chunks: [TINY_BYTES.subarray(9)],
                },
                { headers: [['ETag', '"fresh"'], ['Content-Length', '26']], chunks: [TINY_BYTES] },
            ],
        })
        const writer = await h.store.beginWrite('tiny.bin', { etag: '"tiny"' })
        await writer.write(TINY_BYTES.subarray(0, 9))
        await writer.abort({ keepPartial: true })

        await expect(h.service.download(PROFILE_ID, PRINCIPAL_A).promise)
            .resolves.toMatchObject({ state: 'verified' })
        expect(h.network.calls).toHaveLength(2)
        expect(h.network.calls[0].headers.Range).toBe('bytes=9-')
        expect(h.network.calls[1].headers.Range).toBeUndefined()
    })

    it('commits a complete valid partial without network access', async () => {
        const h = await harness()
        const writer = await h.store.beginWrite('tiny.bin', { etag: '"tiny"' })
        await writer.write(TINY_BYTES)
        await writer.abort({ keepPartial: true })

        await expect(h.service.download(PROFILE_ID, PRINCIPAL_A).promise)
            .resolves.toEqual({ state: 'verified', bytes: 26 })
        expect(h.network.calls).toHaveLength(0)
    })

    it('preserves a partial when removal excludes partial bytes', async () => {
        const h = await harness()
        const writer = await h.store.beginWrite('tiny.bin', { etag: '"tiny"' })
        await writer.write(TINY_BYTES.subarray(0, 8))
        await writer.abort({ keepPartial: true })

        await expect(h.service.remove(PROFILE_ID, false)).resolves.toEqual({ purgedBytes: 0 })
        expect(await h.store.stat('tiny.bin')).toMatchObject({ state: 'partial', bytes: 8 })

        await expect(h.service.remove(PROFILE_ID, true)).resolves.toEqual({ purgedBytes: 8 })
        expect(await h.store.stat('tiny.bin')).toEqual({ state: 'absent', bytes: 0 })
    })

    it('joins principals onto one transfer and cancels only the selected principal lease', async () => {
        let opened!: PassThrough
        const h = await harness({
            scripts: [{
                headers: [['ETag', '"tiny"']],
                start(response) {
                    opened = response
                    response.write(TINY_BYTES.subarray(0, 8))
                },
            }],
        })
        const a = h.service.download(PROFILE_ID, PRINCIPAL_A)
        const same = h.service.download(PROFILE_ID, PRINCIPAL_A)
        const b = h.service.download(PROFILE_ID, PRINCIPAL_B)
        expect(a.joined).toBe(false)
        expect(same.joined).toBe(true)
        expect(b.joined).toBe(true)
        await vi.waitFor(() => expect(opened).toBeDefined())

        expect(h.service.cancel(PROFILE_ID, PRINCIPAL_A)).toBe(true)
        await expectCode(a.promise, 'ABORTED')
        await expectCode(same.promise, 'ABORTED')
        expect(h.network.requests[0].destroyed).toBe(false)
        opened.end(TINY_BYTES.subarray(8))
        await expect(b.promise).resolves.toMatchObject({ state: 'verified' })
        expect(h.network.calls).toHaveLength(1)

        const already = h.service.download(PROFILE_ID, PRINCIPAL_A)
        expect(already.joined).toBe(false)
        await expect(already.promise).resolves.toMatchObject({ state: 'verified' })
    })

    it('settles a last-lease cancellation during hung DNS and ignores its late answer', async () => {
        let resolveFirst!: (value: Array<{ address: string; family: 4 }>) => void
        const lookup = vi.fn()
            .mockImplementationOnce(() => new Promise((resolve) => { resolveFirst = resolve }))
            .mockResolvedValue([{ address: '93.184.216.34', family: 4 }])
        const h = await harness({
            lookup,
            scripts: [{ headers: [['Content-Length', '26']], chunks: [TINY_BYTES] }],
        })
        const first = h.service.download(PROFILE_ID, PRINCIPAL_A)
        await vi.waitFor(() => expect(lookup).toHaveBeenCalledTimes(1))

        expect(h.service.cancel(PROFILE_ID, PRINCIPAL_A)).toBe(true)
        await expectCode(first.promise, 'ABORTED')
        await new Promise((resolve) => setImmediate(resolve))
        await expect(h.service.remove(PROFILE_ID)).resolves.toEqual({ purgedBytes: 0 })

        const second = h.service.download(PROFILE_ID, PRINCIPAL_B)
        resolveFirst([{ address: '93.184.216.34', family: 4 }])
        await expect(second.promise).resolves.toEqual({ state: 'verified', bytes: 26 })
        expect(lookup).toHaveBeenCalledTimes(2)
        expect(h.network.calls).toHaveLength(1)
    })

    it('rejects a 65th observer without creating a ghost principal lease', async () => {
        const h = await harness({
            scripts: [{
                headers: [['ETag', '"tiny"']],
                start() { /* keep the transfer open */ },
            }],
        })
        const principals = Array.from({ length: 64 }, (_, index) => (
            `aaaaaaaa-aaaa-4aaa-8aaa-${index.toString(16).padStart(12, '0')}`
        ))
        const handles = principals.map((principal) => (
            h.service.download(PROFILE_ID, principal, () => undefined)
        ))
        const outcomes = handles.map((handle: any) => handle.promise.catch((error: unknown) => error))
        await vi.waitFor(() => expect(h.network.requests).toHaveLength(1))

        const rejectedPrincipal = 'aaaaaaaa-aaaa-4aaa-8aaa-000000000040'
        expect(() => h.service.download(PROFILE_ID, rejectedPrincipal, () => undefined))
            .toThrowError(expect.objectContaining({ code: 'ACTIVE_DOWNLOAD' }))
        const rejectedCancel = h.service.cancel(PROFILE_ID, rejectedPrincipal)
        for (const principal of principals) expect(h.service.cancel(PROFILE_ID, principal)).toBe(true)
        const errors = await Promise.all(outcomes)

        expect(rejectedCancel).toBe(false)
        expect(errors.every((error: any) => error?.code === 'ABORTED')).toBe(true)
        await vi.waitFor(() => expect(h.network.requests[0].destroyed).toBe(true))
        await vi.waitFor(async () => {
            await expect(h.service.remove(PROFILE_ID)).resolves.toHaveProperty('purgedBytes')
        })
    })

    it('aborts the request for the last cancelled lease and preserves an ETag partial', async () => {
        let opened!: PassThrough
        const h = await harness({
            scripts: [{
                headers: [['ETag', '"tiny"']],
                start(response) {
                    opened = response
                    response.write(TINY_BYTES.subarray(0, 8))
                },
            }],
        })
        const active = h.service.download(PROFILE_ID, PRINCIPAL_A)
        await vi.waitFor(() => expect(opened).toBeDefined())

        expect(h.service.cancel(PROFILE_ID, PRINCIPAL_A)).toBe(true)
        await expectCode(active.promise, 'ABORTED')
        await vi.waitFor(() => expect(h.network.requests[0].destroyed).toBe(true))
        await vi.waitFor(async () => {
            expect(await h.store.stat('tiny.bin')).toMatchObject({ state: 'partial', bytes: 8, etag: '"tiny"' })
        }, { timeout: 5_000 })
    })

    it('keeps the primary failure when partial cleanup also fails', async () => {
        const primaryStore = {
            estimate: async () => ({ persistent: true }),
            stat: async () => ({ state: 'absent', bytes: 0 }),
            beginWrite: async () => ({
                offset: 0,
                write: async () => undefined,
                commit: async () => undefined,
                abort: async () => { throw new Error('cleanup failed') },
            }),
            remove: async () => { throw new Error('remove failed') },
            readPartial: async function *() {},
        }
        const h = await harness({
            store: primaryStore,
            scripts: [{ chunks: [TINY_BYTES.subarray(0, 25)] }],
        })

        await expectCode(h.service.download(PROFILE_ID, PRINCIPAL_A).promise, 'INTEGRITY_ERROR')
    })
})

type Handler = (req: any, res: any, next: (error?: unknown) => void) => unknown

function routeHarness(service: any, auth = true, active = true) {
    const routes = new Map<string, Handler>()
    const app = {
        get: (route: string, handler: Handler) => routes.set(`GET ${route}`, handler),
        post: (route: string, handler: Handler) => routes.set(`POST ${route}`, handler),
        delete: (route: string, handler: Handler) => routes.set(`DELETE ${route}`, handler),
    }
    const order: string[] = []
    const { registerPluginModelRoutes } = require('./pluginModelDownload.cjs')
    registerPluginModelRoutes({
        app,
        service,
        checkAuth: async () => { order.push('auth'); return auth },
        checkActiveSession: (_req: unknown, res: any) => {
            order.push('session')
            if (!active) res.status(423).json({ error: 'Session deactivated' })
            return active
        },
    })
    return { routes, order }
}

function responseHarness() {
    const output = new EventEmitter() as any
    output.statusCode = 200
    output.headers = {} as Record<string, string>
    output.body = ''
    output.jsonValue = undefined
    output.status = (code: number) => { output.statusCode = code; return output }
    output.setHeader = (name: string, value: string) => { output.headers[name.toLowerCase()] = value }
    output.writeHead = (code: number, headers: Record<string, string>) => {
        output.statusCode = code
        for (const [name, value] of Object.entries(headers)) output.setHeader(name, value)
    }
    output.write = (value: string) => { output.body += value; return true }
    output.end = (value?: string) => { if (value) output.body += value; output.ended = true }
    output.json = (value: unknown) => { output.jsonValue = value; output.ended = true; return output }
    output.send = output.json
    return output
}

describe('Pocket PixAI authenticated routes', () => {
    it('authenticates before profile, principal, storage, or network work', async () => {
        const service = {
            status: vi.fn(() => { throw new Error('must not run') }),
            download: vi.fn(() => { throw new Error('must not run') }),
        }
        const h = routeHarness(service, false)
        const status = h.routes.get('GET /api/plugin-models/:profileId/status')!
        const download = h.routes.get('POST /api/plugin-models/:profileId/download')!
        const hostileParams = Object.defineProperty({}, 'profileId', {
            enumerable: true,
            get() { throw new Error('profile getter must not run') },
        })

        await status({ params: hostileParams, headers: {} }, responseHarness(), vi.fn())
        await download({ params: hostileParams, headers: {} }, responseHarness(), vi.fn())
        expect(service.status).not.toHaveBeenCalled()
        expect(service.download).not.toHaveBeenCalled()
        expect(h.order).toEqual(['auth', 'auth'])
    })

    it('checks the active session before validating a mutating-route principal', async () => {
        const service = { download: vi.fn() }
        const h = routeHarness(service, true, false)
        const download = h.routes.get('POST /api/plugin-models/:profileId/download')!
        const hostileHeaders = Object.defineProperty({}, 'x-risu-plugin-principal-id', {
            enumerable: true,
            get() { throw new Error('principal getter must not run') },
        })

        const res = responseHarness()
        await download({ params: { profileId: PROFILE_ID }, headers: hostileHeaders }, res, vi.fn())
        expect(h.order).toEqual(['auth', 'session'])
        expect(res.statusCode).toBe(423)
        expect(service.download).not.toHaveBeenCalled()
    })

    it('rejects invalid UUIDs and request bodies before starting a download', async () => {
        const service = { download: vi.fn() }
        const h = routeHarness(service)
        const download = h.routes.get('POST /api/plugin-models/:profileId/download')!

        const invalid = responseHarness()
        await download({
            params: { profileId: PROFILE_ID },
            headers: { 'x-risu-plugin-principal-id': 'not-a-uuid' },
        }, invalid, vi.fn())
        expect(invalid.statusCode).toBe(400)

        const body = responseHarness()
        await download({
            params: { profileId: PROFILE_ID },
            headers: {
                'x-risu-plugin-principal-id': PRINCIPAL_A,
                'content-length': '2',
            },
        }, body, vi.fn())
        expect(body.statusCode).toBe(400)
        expect(service.download).not.toHaveBeenCalled()
    })

    it('streams bounded NDJSON and disconnect removes only its observer', async () => {
        const unsubscribe = vi.fn()
        const service = {
            download: (_profileId: string, _principalId: string, observer: (value: unknown) => void) => {
                observer({ phase: 'downloading', artifact: 'tiny.bin', loadedBytes: 4, totalBytes: 26 })
                return {
                    joined: false,
                    promise: Promise.resolve({ state: 'verified', bytes: 26 }),
                    unsubscribe,
                }
            },
        }
        const h = routeHarness(service)
        const download = h.routes.get('POST /api/plugin-models/:profileId/download')!
        const res = responseHarness()
        await download({
            params: { profileId: PROFILE_ID },
            headers: { 'x-risu-plugin-principal-id': PRINCIPAL_A },
        }, res, vi.fn())

        expect(res.statusCode).toBe(200)
        expect(res.headers['content-type']).toBe('application/x-ndjson')
        expect(res.headers['cache-control']).toBe('no-store')
        const records = res.body.trim().split('\n').map((line: string) => JSON.parse(line))
        expect(records.map((record: any) => record.type)).toEqual(['accepted', 'progress', 'done'])
        expect(records.every((record: unknown) => Buffer.byteLength(JSON.stringify(record)) < 4096)).toBe(true)
        res.emit('close')
        expect(unsubscribe).toHaveBeenCalledTimes(1)
    })

    it('exposes status, cancellation, active-removal conflict, and idempotent removal', async () => {
        const service = {
            status: vi.fn(async () => ({ profileId: PROFILE_ID, state: 'absent' })),
            cancel: vi.fn(() => true),
            remove: vi.fn(async () => ({ purgedBytes: 0 })),
        }
        const h = routeHarness(service)
        const status = responseHarness()
        await h.routes.get('GET /api/plugin-models/:profileId/status')!(
            { params: { profileId: PROFILE_ID }, headers: {} }, status, vi.fn(),
        )
        expect(status.jsonValue).toEqual({ profileId: PROFILE_ID, state: 'absent' })

        const cancel = responseHarness()
        await h.routes.get('DELETE /api/plugin-models/:profileId/download')!(
            { params: { profileId: PROFILE_ID }, headers: { 'x-risu-plugin-principal-id': PRINCIPAL_A } },
            cancel,
            vi.fn(),
        )
        expect(cancel.jsonValue).toEqual({ cancelled: true })

        service.remove.mockRejectedValueOnce(Object.assign(new Error('active'), { code: 'ACTIVE_DOWNLOAD' }))
        const conflict = responseHarness()
        await h.routes.get('DELETE /api/plugin-models/:profileId')!(
            { params: { profileId: PROFILE_ID }, headers: { 'x-risu-plugin-principal-id': PRINCIPAL_A } },
            conflict,
            vi.fn(),
        )
        expect(conflict.statusCode).toBe(409)

        const removed = responseHarness()
        await h.routes.get('DELETE /api/plugin-models/:profileId')!(
            { params: { profileId: PROFILE_ID }, headers: { 'x-risu-plugin-principal-id': PRINCIPAL_A } },
            removed,
            vi.fn(),
        )
        expect(removed.jsonValue).toEqual({ purgedBytes: 0 })
    })

    it('accepts only omitted or strict includePartial boolean removal options', async () => {
        const service = { remove: vi.fn(async () => ({ purgedBytes: 0 })) }
        const h = routeHarness(service)
        const remove = h.routes.get('DELETE /api/plugin-models/:profileId')!
        const base = {
            params: { profileId: PROFILE_ID },
            headers: { 'x-risu-plugin-principal-id': PRINCIPAL_A },
        }

        await remove(base, responseHarness(), vi.fn())
        await remove({ ...base, body: { includePartial: false } }, responseHarness(), vi.fn())
        expect(service.remove.mock.calls).toEqual([
            [PROFILE_ID, true],
            [PROFILE_ID, false],
        ])

        const unparsed = responseHarness()
        await remove({
            ...base,
            headers: { ...base.headers, 'content-length': '2' },
            body: undefined,
        }, unparsed, vi.fn())
        expect(unparsed.statusCode).toBe(400)

        const accessor = Object.defineProperty({}, 'includePartial', {
            enumerable: true,
            get() { throw new Error('includePartial getter must not run') },
        })
        for (const body of [
            { includePartial: false, artifact: 'tiny.bin' },
            { includePartial: 'false' },
            accessor,
        ]) {
            const res = responseHarness()
            await remove({ ...base, body }, res, vi.fn())
            expect(res.statusCode).toBe(400)
        }
        expect(service.remove).toHaveBeenCalledTimes(2)
    })

    it('validates the removal principal before reading its body', async () => {
        const service = { remove: vi.fn() }
        const h = routeHarness(service)
        const remove = h.routes.get('DELETE /api/plugin-models/:profileId')!
        const req = {
            params: { profileId: PROFILE_ID },
            headers: { 'x-risu-plugin-principal-id': 'not-a-uuid' },
        } as any
        Object.defineProperty(req, 'body', {
            get() { throw new Error('body getter must not run') },
        })

        const res = responseHarness()
        await remove(req, res, vi.fn())
        expect(res.statusCode).toBe(400)
        expect(service.remove).not.toHaveBeenCalled()
    })
})

describe('Pocket updater model-cache preservation', () => {
    it.each([
        'server/node/server.cjs',
        'scripts/updater.cjs',
    ])('keeps and skips replacement of model-cache in %s', (relativePath) => {
        const source = readFileSync(path.resolve(process.cwd(), relativePath), 'utf8')
        const sets = [...source.matchAll(/const (keep|skipMove) = new Set\(\[([^\]]+)]\)/g)]
        const byName = new Map(sets.map((match) => [match[1], match[2]]))

        expect(byName.get('keep')).toContain("'model-cache'")
        expect(byName.get('skipMove')).toContain("'model-cache'")
    })
})

describe('tiny fixture integrity', () => {
    it('uses a hand-pinned byte length and digest', () => {
        expect(TINY_BYTES.byteLength).toBe(26)
        expect(createHash('sha256').update(TINY_BYTES).digest('hex')).toBe(TINY_DIGEST)
    })
})

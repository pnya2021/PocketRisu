import { describe, expect, it, vi } from 'vitest'
import { PluginApiError } from '../illustration/errors'
import {
    PIXAI_PROFILE,
    PocketPluginModelClient,
    type PocketPluginModelBridge,
} from './pocketPluginModelClient'

const PRINCIPAL = '123e4567-e89b-42d3-a456-426614174000'

function statusBody(state: 'absent' | 'partial' | 'verified' = 'absent') {
    const stored = state === 'absent'
        ? [0, 0, 0]
        : state === 'verified'
            ? PIXAI_PROFILE.artifacts.map((artifact) => artifact.bytes)
            : [4096, 0, 0]
    return {
        profileId: PIXAI_PROFILE.id,
        revision: PIXAI_PROFILE.revision,
        state,
        storedBytes: stored.reduce((sum, value) => sum + value, 0),
        totalBytes: PIXAI_PROFILE.totalBytes,
        artifacts: PIXAI_PROFILE.artifacts.map((artifact, index) => ({
            name: artifact.name,
            sha256: artifact.sha256,
            state: state === 'verified'
                ? 'verified'
                : stored[index] === 0 ? 'absent' : 'partial',
            storedBytes: stored[index],
            expectedBytes: artifact.bytes,
        })),
        storage: {
            kind: 'node',
            persistent: true,
            resumable: true,
            usageBytes: 8192,
            quotaBytes: 2_000_000_000,
        },
    }
}

function ndjsonResponse(records: unknown[], fragments?: number[]): Response {
    const encoded = new TextEncoder().encode(
        records.map((record) => `${JSON.stringify(record)}\n`).join(''),
    )
    let offset = 0
    let fragment = 0
    return new Response(new ReadableStream<Uint8Array>({
        pull(controller) {
            if (offset >= encoded.length) {
                controller.close()
                return
            }
            const requested = fragments?.[fragment++] ?? encoded.length
            const end = Math.min(offset + requested, encoded.length)
            controller.enqueue(encoded.slice(offset, end))
            offset = end
        },
    }), { status: 200, headers: { 'content-type': 'application/x-ndjson' } })
}

function bridge(overrides: Partial<PocketPluginModelBridge> = {}): PocketPluginModelBridge {
    return {
        pluginModelStatus: vi.fn(async () => Response.json(statusBody())),
        pluginModelDownload: vi.fn(async () => ndjsonResponse([])),
        pluginModelCancel: vi.fn(async () => Response.json({ cancelled: false })),
        pluginModelRemove: vi.fn(async () => Response.json({ purgedBytes: 0 })),
        ...overrides,
    }
}

function expectCode(error: unknown, code: string, retryable = false) {
    expect(error).toBeInstanceOf(PluginApiError)
    expect(error).toMatchObject({ code, retryable })
}

describe('PocketPluginModelClient', () => {
    it('strictly decodes the fixed status contract and rejects hostile or inconsistent data', async () => {
        const transport = bridge()
        const client = new PocketPluginModelClient(transport, PRINCIPAL)
        await expect(client.status()).resolves.toEqual(statusBody())
        expect(transport.pluginModelStatus).toHaveBeenCalledWith()

        const malformed = [
            { ...statusBody(), extra: true },
            { ...statusBody(), profileId: 'other' },
            { ...statusBody(), storedBytes: Number.MAX_SAFE_INTEGER + 1 },
            { ...statusBody(), state: 'verified' },
            {
                ...statusBody(),
                artifacts: statusBody().artifacts.map((artifact, index) =>
                    index === 0 ? { ...artifact, sha256: 'raw-server-secret' } : artifact),
            },
            { ...statusBody(), storage: { ...statusBody().storage, resumable: false } },
        ]
        for (const body of malformed) {
            const bad = new PocketPluginModelClient(bridge({
                pluginModelStatus: vi.fn(async () => Response.json(body)),
            }), PRINCIPAL)
            await expect(bad.status()).rejects.toSatisfy((error: unknown) => {
                expectCode(error, 'INTERNAL')
                expect(String((error as Error).message)).not.toContain('raw-server-secret')
                return true
            })
        }
    })

    it('accepts fragmented ordered NDJSON and isolates throwing progress callbacks', async () => {
        const progress = {
            type: 'progress',
            profileId: PIXAI_PROFILE.id,
            artifact: PIXAI_PROFILE.artifacts[0].name,
            phase: 'downloading',
            artifactLoadedBytes: 1024,
            artifactTotalBytes: PIXAI_PROFILE.artifacts[0].bytes,
            loadedBytes: 1024,
            totalBytes: PIXAI_PROFILE.totalBytes,
        } as const
        const transport = bridge({
            pluginModelDownload: vi.fn(async (_principal, signal) => {
                expect(_principal).toBe(PRINCIPAL)
                expect(signal).toBeInstanceOf(AbortSignal)
                return ndjsonResponse([
                    { type: 'accepted', joined: false, profileId: PIXAI_PROFILE.id },
                    progress,
                    { type: 'done', state: 'verified', bytes: PIXAI_PROFILE.totalBytes },
                ], [1, 2, 3, 5, 8, 13])
            }),
        })
        const client = new PocketPluginModelClient(transport, PRINCIPAL)
        const callback = vi.fn(() => {
            throw new Error('plugin callback detail')
        })
        await expect(client.download(new AbortController().signal, callback)).resolves.toEqual({
            state: 'verified',
            bytes: PIXAI_PROFILE.totalBytes,
        })
        expect(callback).toHaveBeenCalledWith({
            profileId: PIXAI_PROFILE.id,
            artifact: PIXAI_PROFILE.artifacts[0].name,
            phase: 'downloading',
            artifactLoadedBytes: 1024,
            artifactTotalBytes: PIXAI_PROFILE.artifacts[0].bytes,
            loadedBytes: 1024,
            totalBytes: PIXAI_PROFILE.totalBytes,
        })

        const rejecting = vi.fn(async () => {
            throw new Error('async callback detail')
        })
        await expect(client.download(new AbortController().signal, rejecting)).resolves.toMatchObject({
            state: 'verified',
        })
    })

    it('rejects invalid NDJSON order, shape, bounds, trailing records and missing terminal', async () => {
        const accepted = { type: 'accepted', joined: false, profileId: PIXAI_PROFILE.id }
        const done = { type: 'done', state: 'verified', bytes: PIXAI_PROFILE.totalBytes }
        const invalidStreams = [
            [done],
            [accepted, accepted, done],
            [accepted],
            [accepted, done, { type: 'progress' }],
            [accepted, { ...done, extra: true }],
            [accepted, { type: 'unknown' }],
        ]
        for (const records of invalidStreams) {
            const client = new PocketPluginModelClient(bridge({
                pluginModelDownload: vi.fn(async () => ndjsonResponse(records)),
            }), PRINCIPAL)
            await expect(client.download(new AbortController().signal)).rejects.toSatisfy(
                (error: unknown) => {
                    expectCode(error, records.length === 1 && records[0] === accepted ? 'NETWORK' : 'INTERNAL', records.length === 1 && records[0] === accepted)
                    return true
                },
            )
        }

        const oversized = new Response(`${'x'.repeat(70_000)}\n`, {
            status: 200,
            headers: { 'content-type': 'application/x-ndjson' },
        })
        const client = new PocketPluginModelClient(bridge({
            pluginModelDownload: vi.fn(async () => oversized),
        }), PRINCIPAL)
        await expect(client.download(new AbortController().signal)).rejects.toSatisfy(
            (error: unknown) => {
                expectCode(error, 'INTERNAL')
                return true
            },
        )
    })

    it.each([
        ['ABORTED', 'ABORTED', false],
        ['NETWORK_ERROR', 'NETWORK', true],
        ['INTEGRITY_ERROR', 'INTEGRITY_MISMATCH', false],
        ['STORAGE_QUOTA', 'QUOTA_EXCEEDED', false],
        ['STORAGE_ERROR', 'INTERNAL', false],
        ['UNKNOWN_SERVER_CODE', 'INTERNAL', false],
    ])('maps %s without exposing the server message', async (serverCode, publicCode, retryable) => {
        const raw = 'secret signed URL https://example.invalid/?token=raw'
        const client = new PocketPluginModelClient(bridge({
            pluginModelDownload: vi.fn(async () => ndjsonResponse([
                { type: 'accepted', joined: false, profileId: PIXAI_PROFILE.id },
                { type: 'error', code: serverCode, message: raw },
            ])),
        }), PRINCIPAL)
        await expect(client.download(new AbortController().signal)).rejects.toSatisfy(
            (error: unknown) => {
                expectCode(error, publicCode, retryable)
                expect(String((error as Error).message)).not.toContain(raw)
                expect(JSON.stringify(error)).not.toContain('token=raw')
                return true
            },
        )
    })

    it('maps HTTP and transport failures, preserving no raw response detail', async () => {
        const cases: Array<[Response | Error, string, boolean]> = [
            [Response.json({ error: { code: 'ACTIVE_DOWNLOAD', message: 'private conflict' } }, { status: 409 }), 'CONFLICT', false],
            [new Response('private missing route', { status: 404 }), 'UNSUPPORTED', false],
            [new Response('private old route', { status: 405 }), 'UNSUPPORTED', false],
            [new Error('private fetch URL'), 'NETWORK', true],
        ]
        for (const [result, code, retryable] of cases) {
            const client = new PocketPluginModelClient(bridge({
                pluginModelDownload: vi.fn(async () => {
                    if (result instanceof Error) throw result
                    return result
                }),
            }), PRINCIPAL)
            await expect(client.download(new AbortController().signal)).rejects.toSatisfy(
                (error: unknown) => {
                    expectCode(error, code, retryable)
                    expect(String((error as Error).message)).not.toContain('private')
                    return true
                },
            )
        }
    })

    it('strictly decodes cancel and remove and forwards only the captured principal/options', async () => {
        const transport = bridge({
            pluginModelCancel: vi.fn(async () => Response.json({ cancelled: true })),
            pluginModelRemove: vi.fn(async () => Response.json({ purgedBytes: 1234 })),
        })
        const client = new PocketPluginModelClient(transport, PRINCIPAL)
        await expect(client.cancel()).resolves.toEqual({ cancelled: true })
        await expect(client.remove(false)).resolves.toEqual({ purgedBytes: 1234 })
        expect(transport.pluginModelCancel).toHaveBeenCalledWith(PRINCIPAL)
        expect(transport.pluginModelRemove).toHaveBeenCalledWith(PRINCIPAL, false)

        const malformed = new PocketPluginModelClient(bridge({
            pluginModelCancel: vi.fn(async () => Response.json({ cancelled: true, raw: 'secret' })),
            pluginModelRemove: vi.fn(async () => Response.json({ purgedBytes: -1 })),
        }), PRINCIPAL)
        await expect(malformed.cancel()).rejects.toMatchObject({ code: 'INTERNAL' })
        await expect(malformed.remove(true)).rejects.toMatchObject({ code: 'INTERNAL' })
    })
})

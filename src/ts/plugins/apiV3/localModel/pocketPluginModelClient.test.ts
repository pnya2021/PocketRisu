import { describe, expect, it, vi } from 'vitest'
import { PluginApiError } from '../illustration/errors'
import {
    PIXAI_PROFILE,
    PocketPluginModelClient,
    type PocketPluginModelBridge,
} from './pocketPluginModelClient'

const PRINCIPAL = '123e4567-e89b-42d3-a456-426614174000'
const INSTANCE = '223e4567-e89b-42d3-a456-426614174000'
const SESSION = '323e4567-e89b-42d3-a456-426614174000'

function inferenceCapabilityBody(modelReady = true) {
    return {
        backendAvailable: true,
        modelReady,
        ...(modelReady ? {} : { reason: 'model-not-ready' }),
        providers: {
            node: { available: modelReady },
            webgpu: { available: false },
            wasm: { available: false },
        },
    }
}

function inferenceResultBody(tags: unknown[] = [{
    index: 4,
    name: '1girl',
    score: 0.91,
    category: 'general',
}]) {
    return {
        modelProfileId: PIXAI_PROFILE.id,
        modelRevision: PIXAI_PROFILE.revision,
        modelSha256: PIXAI_PROFILE.artifacts[0].sha256,
        preprocessVersion: 'pixai-v0.9-preprocess-448-rgb-bilinear-v1',
        provider: 'node',
        tags,
        thresholds: { general: 0.3, character: 0.85 },
        truncated: false,
        timings: {
            decodeMs: 1,
            preprocessMs: 2,
            inferenceMs: 3,
            postprocessMs: 4,
            totalMs: 10,
        },
        warnings: [],
    }
}

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
        pluginModelInferenceCapabilities: vi.fn(async () => Response.json(inferenceCapabilityBody())),
        pluginModelInferenceAcquire: vi.fn(async () => Response.json({ sessionId: SESSION, provider: 'node' })),
        pluginModelInferenceRun: vi.fn(async () => Response.json(inferenceResultBody())),
        pluginModelInferenceRelease: vi.fn(async () => Response.json({ released: true })),
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

    it('strictly decodes backend capabilities without initializing or prompting', async () => {
        const transport = bridge()
        const client = new PocketPluginModelClient(transport, PRINCIPAL, INSTANCE)
        await expect(client.inferenceCapabilities()).resolves.toEqual(inferenceCapabilityBody())
        expect(transport.pluginModelInferenceCapabilities).toHaveBeenCalledWith()

        for (const value of [
            { ...inferenceCapabilityBody(), extra: true },
            { ...inferenceCapabilityBody(), backendAvailable: 'yes' },
            { ...inferenceCapabilityBody(), providers: { ...inferenceCapabilityBody().providers, node: { available: true, detail: 'raw' } } },
            { ...inferenceCapabilityBody(), reason: 'x'.repeat(513) },
        ]) {
            const malformed = new PocketPluginModelClient(bridge({
                pluginModelInferenceCapabilities: vi.fn(async () => Response.json(value)),
            }), PRINCIPAL, INSTANCE)
            await expect(malformed.inferenceCapabilities()).rejects.toMatchObject({
                code: 'INTERNAL', message: 'Internal plugin API error',
            })
        }
    })

    it('acquires, runs, maps the bounded P4 result, and releases with captured ownership', async () => {
        const transport = bridge()
        const client = new PocketPluginModelClient(transport, PRINCIPAL, INSTANCE)
        const acquireSignal = new AbortController().signal
        const runSignal = new AbortController().signal
        const image = new Uint8Array([0x89, 0x50, 0x4e, 0x47])

        await expect(client.acquire('auto', acquireSignal)).resolves.toEqual({
            sessionId: SESSION,
            provider: 'node',
        })
        await expect(client.run(
            SESSION,
            image,
            'image/png',
            { thresholds: { general: 0.3 }, categories: ['general'], maxResults: 100 },
            runSignal,
        )).resolves.toEqual({
            model: {
                profile: PIXAI_PROFILE.id,
                revision: PIXAI_PROFILE.revision,
                sha256: PIXAI_PROFILE.artifacts[0].sha256,
                preprocessVersion: 'pixai-v0.9-preprocess-448-rgb-bilinear-v1',
            },
            execution: { provider: 'node' },
            tags: [{ index: 4, name: '1girl', score: 0.91, category: 'general' }],
            thresholds: { general: 0.3, character: 0.85 },
            truncated: false,
            timingMs: { decode: 1, preprocess: 2, inference: 3, postprocess: 4, total: 10 },
            warnings: [],
        })
        await expect(client.release(SESSION)).resolves.toBeUndefined()

        expect(transport.pluginModelInferenceAcquire).toHaveBeenCalledWith(
            PRINCIPAL, INSTANCE, 'auto', acquireSignal,
        )
        expect(transport.pluginModelInferenceRun).toHaveBeenCalledWith(
            PRINCIPAL,
            INSTANCE,
            SESSION,
            image,
            'image/png',
            { thresholds: { general: 0.3 }, categories: ['general'], maxResults: 100 },
            runSignal,
        )
        expect(transport.pluginModelInferenceRelease).toHaveBeenCalledWith(PRINCIPAL, INSTANCE, SESSION)
    })

    it('enforces the 500-tag public boundary and rejects malformed private results', async () => {
        const validTags = Array.from({ length: 500 }, (_, index) => ({
            index,
            name: `tag_${index}`,
            score: 0.5,
            category: index % 2 ? 'character' : 'general',
        }))
        const client = new PocketPluginModelClient(bridge({
            pluginModelInferenceRun: vi.fn(async () => Response.json(inferenceResultBody(validTags))),
        }), PRINCIPAL, INSTANCE)
        await expect(client.run(
            SESSION, new Uint8Array([1]), 'image/jpeg', {}, new AbortController().signal,
        )).resolves.toHaveProperty('tags', validTags)

        const malformed = [
            inferenceResultBody([...validTags, { index: 501, name: 'overflow', score: 0.5, category: 'general' }]),
            { ...inferenceResultBody(), rawScores: [0.1] },
            { ...inferenceResultBody(), modelRevision: 'private-revision' },
            { ...inferenceResultBody(), tags: [{ index: -1, name: 'raw', score: 0.2, category: 'general' }] },
            { ...inferenceResultBody(), timings: { ...inferenceResultBody().timings, totalMs: Number.POSITIVE_INFINITY } },
            { ...inferenceResultBody(), warnings: ['x'.repeat(513)] },
        ]
        for (const value of malformed) {
            const invalid = new PocketPluginModelClient(bridge({
                pluginModelInferenceRun: vi.fn(async () => Response.json(value)),
            }), PRINCIPAL, INSTANCE)
            await expect(invalid.run(
                SESSION, new Uint8Array([1]), 'image/jpeg', {}, new AbortController().signal,
            )).rejects.toSatisfy((error: unknown) => {
                expectCode(error, 'INTERNAL')
                expect(JSON.stringify(error)).not.toContain('private-revision')
                return true
            })
        }
    })

    it.each([
        ['NOT_FOUND', 'NOT_FOUND', false],
        ['UNSUPPORTED', 'UNSUPPORTED', false],
        ['INVALID_ARGUMENT', 'INVALID_ARGUMENT', false],
        ['RESOURCE_LIMIT', 'RESOURCE_LIMIT', true],
        ['CONFLICT', 'CONFLICT', false],
        ['ABORTED', 'ABORTED', false],
        ['DECODE_FAILED', 'DECODE_FAILED', false],
        ['PROVIDER_ERROR', 'PROVIDER_ERROR', true],
    ])('maps inference %s to stable public %s without raw detail', async (privateCode, publicCode, retryable) => {
        const raw = 'native stack C:\\secret\\model.onnx'
        const client = new PocketPluginModelClient(bridge({
            pluginModelInferenceRun: vi.fn(async () => Response.json({
                error: { code: privateCode, message: raw, retryable },
            }, { status: privateCode === 'NOT_FOUND' ? 404 : 400 })),
        }), PRINCIPAL, INSTANCE)
        await expect(client.run(
            SESSION, new Uint8Array([1]), 'image/webp', {}, new AbortController().signal,
        )).rejects.toSatisfy((error: unknown) => {
            expectCode(error, publicCode, retryable)
            expect(String((error as Error).message)).not.toContain(raw)
            expect(JSON.stringify(error)).not.toContain('secret')
            return true
        })
    })

    it('preserves the P5-A retryable pending-removal conflict without exposing its message', async () => {
        const client = new PocketPluginModelClient(bridge({
            pluginModelInferenceAcquire: vi.fn(async () => Response.json({
                error: { code: 'CONFLICT', message: 'private removal state', retryable: true },
            }, { status: 409 })),
        }), PRINCIPAL, INSTANCE)
        await expect(client.acquire('node', new AbortController().signal)).rejects.toSatisfy(
            (error: unknown) => {
                expectCode(error, 'CONFLICT', true)
                expect(String((error as Error).message)).not.toContain('private removal state')
                return true
            },
        )
    })

    it('rejects malformed, unknown, oversized inference responses and maps aborted transport', async () => {
        const malformedBodies = [
            { error: { code: 'UNKNOWN', message: 'raw', retryable: false } },
            { error: { code: 'NOT_FOUND', message: 'raw', retryable: false }, extra: true },
            { error: { code: 'RESOURCE_LIMIT', message: 'raw', retryable: false } },
        ]
        for (const body of malformedBodies) {
            const client = new PocketPluginModelClient(bridge({
                pluginModelInferenceAcquire: vi.fn(async () => Response.json(body, { status: 400 })),
            }), PRINCIPAL, INSTANCE)
            await expect(client.acquire('node', new AbortController().signal))
                .rejects.toMatchObject({ code: 'INTERNAL', message: 'Internal plugin API error' })
        }

        const oversized = new PocketPluginModelClient(bridge({
            pluginModelInferenceCapabilities: vi.fn(async () => new Response('x'.repeat(70_000))),
        }), PRINCIPAL, INSTANCE)
        await expect(oversized.inferenceCapabilities()).rejects.toMatchObject({ code: 'INTERNAL' })

        const controller = new AbortController()
        const abortedClient = new PocketPluginModelClient(bridge({
            pluginModelInferenceAcquire: vi.fn(async () => {
                controller.abort()
                throw new Error('raw URL')
            }),
        }), PRINCIPAL, INSTANCE)
        await expect(abortedClient.acquire('auto', controller.signal)).rejects.toMatchObject({ code: 'ABORTED' })
    })

    it('accepts only immediate or deferred exact remove results', async () => {
        const immediate = new PocketPluginModelClient(bridge({
            pluginModelRemove: vi.fn(async () => Response.json({ purgedBytes: 1234 })),
        }), PRINCIPAL)
        await expect(immediate.remove(false)).resolves.toEqual({ purgedBytes: 1234 })

        const deferred = new PocketPluginModelClient(bridge({
            pluginModelRemove: vi.fn(async () => Response.json({ purgedBytes: 0, pending: true })),
        }), PRINCIPAL)
        await expect(deferred.remove(true)).resolves.toEqual({ purgedBytes: 0, pending: true })

        for (const value of [
            { purgedBytes: 0, pending: false },
            { purgedBytes: 1, pending: true },
            { purgedBytes: 0, pending: true, raw: 'secret' },
        ]) {
            const malformed = new PocketPluginModelClient(bridge({
                pluginModelRemove: vi.fn(async () => Response.json(value)),
            }), PRINCIPAL)
            await expect(malformed.remove(true)).rejects.toMatchObject({ code: 'INTERNAL' })
        }
    })
})

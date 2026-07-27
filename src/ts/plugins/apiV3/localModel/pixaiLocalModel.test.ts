import { describe, expect, it, vi } from 'vitest'
import type { InlayAssetRecord } from 'src/ts/process/files/inlays'
import { PluginApiError } from '../illustration/errors'
import type { PluginExecutionContext, PluginPermissionId } from '../illustration/permissions'
import {
    PIXAI_PROFILE,
    type PocketInferenceCapabilities,
    type PocketInferenceResult,
    type PocketModelStatus,
} from './pocketPluginModelClient'
import { PixaiLocalModel, type PixaiLocalModelClient } from './pixaiLocalModel'

const PRINCIPAL = '11111111-1111-4111-8111-111111111111'
const INSTANCE = '22222222-2222-4222-8222-222222222222'
const SESSION_A = '33333333-3333-4333-8333-333333333333'
const SESSION_B = '44444444-4444-4444-8444-444444444444'
const REVISION_PATTERN = /^sha256:[0-9a-f]{64}$/
const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1])

function executionContext(controller = new AbortController()): PluginExecutionContext {
    return {
        principalId: PRINCIPAL,
        instanceId: INSTANCE,
        displayName: 'Illustrator',
        internalName: 'illustrator',
        signal: controller.signal,
    }
}

function status(state: 'absent' | 'verified' = 'absent'): PocketModelStatus {
    const artifacts = PIXAI_PROFILE.artifacts.map((artifact) => ({
        name: artifact.name,
        sha256: artifact.sha256,
        state,
        storedBytes: state === 'verified' ? artifact.bytes : 0,
        expectedBytes: artifact.bytes,
    }))
    return {
        profileId: PIXAI_PROFILE.id,
        revision: PIXAI_PROFILE.revision,
        state,
        storedBytes: artifacts.reduce((sum, artifact) => sum + artifact.storedBytes, 0),
        totalBytes: PIXAI_PROFILE.totalBytes,
        artifacts,
        storage: {
            kind: 'node', persistent: true, resumable: true,
            usageBytes: 900, quotaBytes: 800,
        },
    }
}

function capability(modelReady = true, backendAvailable = true): PocketInferenceCapabilities {
    return {
        backendAvailable,
        modelReady: backendAvailable && modelReady,
        ...(!backendAvailable
            ? { reason: 'runtime-unavailable' }
            : modelReady ? {} : { reason: 'model-not-ready' }),
        providers: {
            node: { available: backendAvailable && modelReady },
            webgpu: { available: false },
            wasm: { available: false },
        },
    }
}

function inferenceResult(): PocketInferenceResult {
    return {
        model: {
            profile: PIXAI_PROFILE.id,
            revision: PIXAI_PROFILE.revision,
            sha256: PIXAI_PROFILE.artifacts[0].sha256,
            preprocessVersion: 'pixai-v0.9-preprocess-448-rgb-bilinear-v1',
        },
        execution: { provider: 'node' },
        tags: [{ index: 1, name: '1girl', score: 0.9, category: 'general' }],
        thresholds: { general: 0.3, character: 0.85 },
        truncated: false,
        timingMs: { decode: 1, preprocess: 2, inference: 3, postprocess: 4, total: 10 },
        warnings: [],
    }
}

function client(overrides: Partial<PixaiLocalModelClient> = {}): PixaiLocalModelClient {
    return {
        status: vi.fn(async () => status()),
        inferenceCapabilities: vi.fn(async () => capability()),
        acquire: vi.fn(async () => ({ sessionId: SESSION_A, provider: 'node' as const })),
        run: vi.fn(async () => inferenceResult()),
        release: vi.fn(async () => undefined),
        ...overrides,
    }
}

function setup(overrides: {
    context?: PluginExecutionContext
    client?: PixaiLocalModelClient
    readContextAsset?: (...args: any[]) => Promise<any>
    getInlayAssetRecord?: (id: string) => Promise<InlayAssetRecord | null>
    getInlayAssetBlob?: (id: string) => Promise<({ data: Blob } & Record<string, unknown>) | null>
    requirePermission?: (permission: PluginPermissionId) => Promise<void>
} = {}) {
    const modelClient = overrides.client ?? client()
    const permission = vi.fn(overrides.requirePermission ?? (async () => undefined))
    const readContextAsset = vi.fn(overrides.readContextAsset ?? (async () => ({
        data: png.slice(), revision: 'sha256:unused', name: 'card.png', mediaType: 'image/png',
    })))
    const getInlayAssetRecord = vi.fn(overrides.getInlayAssetRecord ?? (async () => null))
    const getInlayAssetBlob = vi.fn(overrides.getInlayAssetBlob ?? (async () => null))
    const facade = new PixaiLocalModel({
        context: overrides.context ?? executionContext(),
        client: modelClient,
        contextResources: { readContextAsset },
        requirePermission: permission,
        getInlayAssetRecord,
        getInlayAssetBlob,
    })
    return {
        facade,
        client: modelClient,
        permission,
        readContextAsset,
        getInlayAssetRecord,
        getInlayAssetBlob,
    }
}

async function revision(data: Uint8Array) {
    const digest = await crypto.subtle.digest('SHA-256', data.slice())
    return `sha256:${[...new Uint8Array(digest)].map((value) => value.toString(16).padStart(2, '0')).join('')}`
}

async function deterministicInlayId(ownerPrincipalId: string, idempotencyKey: string) {
    const encoded = new TextEncoder().encode(JSON.stringify([
        ownerPrincipalId,
        'inlay.create.v1',
        idempotencyKey,
    ]))
    const digest = await crypto.subtle.digest('SHA-256', encoded)
    return `inlay_${[...new Uint8Array(digest)].map((value) => value.toString(16).padStart(2, '0')).join('')}`
}

async function ownedRecord(data = png): Promise<InlayAssetRecord> {
    return {
        data: new Blob([data]),
        ext: 'png',
        name: 'owned.png',
        type: 'image',
        lifecycle: {
            version: 1,
            ownerPrincipalId: PRINCIPAL,
            operation: 'inlay.create.v1',
            idempotencyKey: 'base-character',
            argumentDigest: 'a'.repeat(64),
            revision: await revision(data),
            context: { kind: 'character', characterId: 'card-1' },
        },
    }
}

describe('PixaiLocalModel facade', () => {
    it('maps no-prompt backend, model and storage facts into fixed capabilities', async () => {
        const modelClient = client({
            status: vi.fn(async () => status('absent')),
            inferenceCapabilities: vi.fn(async () => capability(false)),
        })
        const { facade, permission } = setup({ client: modelClient })

        await expect(facade.getLocalModelCapabilities(PIXAI_PROFILE.id)).resolves.toEqual({
            supported: true,
            reasons: ['model-not-ready'],
            providers: {
                node: { available: false, reason: 'model-not-ready' },
                webgpu: { available: false, reason: 'unsupported-provider' },
                wasm: { available: false, reason: 'unsupported-provider' },
            },
            storage: {
                backend: 'node', persistent: true, resumable: true,
                usageBytes: 900, quotaBytes: 800, availableBytes: 0,
            },
            limits: { maxInputBytes: 33_554_432, maxInputPixels: 64_000_000, maxResultTags: 500 },
        })
        await expect(facade.backendHealthy()).resolves.toBe(true)
        expect(permission).not.toHaveBeenCalled()

        vi.mocked(modelClient.inferenceCapabilities).mockResolvedValueOnce(capability(false, false))
        await expect(facade.getLocalModelCapabilities(PIXAI_PROFILE.id)).resolves.toMatchObject({
            supported: false,
            reasons: ['runtime-unavailable'],
            providers: { node: { available: false, reason: 'runtime-unavailable' } },
        })
        vi.mocked(modelClient.inferenceCapabilities).mockRejectedValueOnce(new Error('private route'))
        await expect(facade.backendHealthy()).resolves.toBe(false)
    })

    it('requires inference permission for acquire/run but never for owned release', async () => {
        const { facade, client: modelClient, permission } = setup()
        await expect(facade.acquireLocalModelSession(PIXAI_PROFILE.id)).resolves.toEqual({
            sessionId: SESSION_A, provider: 'node',
        })
        await expect(facade.runLocalModel(SESSION_A, {
            image: { kind: 'bytes', data: png, mediaType: 'image/png' },
            categories: ['general'],
        })).resolves.toEqual(inferenceResult())
        await expect(facade.releaseLocalModelSession(SESSION_A)).resolves.toBeUndefined()

        expect(permission.mock.calls).toEqual([['localModelInference'], ['localModelInference']])
        expect(modelClient.release).toHaveBeenCalledWith(SESSION_A)
        await expect(facade.runLocalModel(SESSION_A, {
            image: { kind: 'bytes', data: png, mediaType: 'image/png' },
        })).rejects.toMatchObject({ code: 'NOT_FOUND' })
        expect(permission).toHaveBeenCalledTimes(2)
    })

    it('closes pre/during abort and releases an acquisition completed after unload', async () => {
        const pre = new AbortController()
        pre.abort()
        const preCase = setup({ context: executionContext(pre) })
        await expect(preCase.facade.acquireLocalModelSession(PIXAI_PROFILE.id))
            .rejects.toMatchObject({ code: 'ABORTED' })
        expect(preCase.permission).not.toHaveBeenCalled()

        const contextController = new AbortController()
        let finishPermission!: () => void
        const during = setup({
            context: executionContext(contextController),
            requirePermission: () => new Promise<void>((resolve) => { finishPermission = resolve }),
        })
        const pending = during.facade.acquireLocalModelSession(PIXAI_PROFILE.id)
        contextController.abort()
        finishPermission()
        await expect(pending).rejects.toMatchObject({ code: 'ABORTED' })
        expect(during.client.acquire).not.toHaveBeenCalled()

        const lateController = new AbortController()
        let finishAcquire!: () => void
        const lateClient = client({
            acquire: vi.fn(() => new Promise<{ sessionId: string; provider: 'node' }>((resolve) => {
                finishAcquire = () => resolve({ sessionId: SESSION_A, provider: 'node' })
            })),
        })
        const late = setup({ context: executionContext(lateController), client: lateClient })
        const latePending = late.facade.acquireLocalModelSession(PIXAI_PROFILE.id)
        await Promise.resolve()
        lateController.abort()
        finishAcquire()
        await expect(latePending).rejects.toMatchObject({ code: 'ABORTED' })
        expect(lateClient.release).toHaveBeenCalledWith(SESSION_A)
    })

    it('delegates context assets to the authorized resolver and validates the returned type', async () => {
        const assetRevision = `sha256:${'b'.repeat(64)}`
        const { facade, client: modelClient, readContextAsset } = setup({
            readContextAsset: async () => ({
                data: png.slice(), revision: assetRevision, name: 'portrait.png', mediaType: 'image/png',
            }),
        })
        await facade.acquireLocalModelSession(PIXAI_PROFILE.id)
        await facade.runLocalModel(SESSION_A, {
            image: {
                kind: 'context-asset',
                assetId: `ctxasset_${'a'.repeat(64)}`,
                revision: assetRevision,
            },
        })
        expect(readContextAsset).toHaveBeenCalledWith(`ctxasset_${'a'.repeat(64)}`, {
            ifRevision: assetRevision,
            variant: 'original',
            maxBytes: 33_554_432,
        })
        expect(modelClient.run).toHaveBeenCalledWith(
            SESSION_A,
            expect.any(Uint8Array),
            'image/png',
            {},
            expect.any(AbortSignal),
        )

        vi.mocked(readContextAsset).mockResolvedValueOnce({
            data: png.slice(), revision: assetRevision, name: 'bad.gif', mediaType: 'image/gif',
        })
        await expect(facade.runLocalModel(SESSION_A, {
            image: { kind: 'context-asset', assetId: `ctxasset_${'a'.repeat(64)}` },
        })).rejects.toMatchObject({ code: 'DECODE_FAILED' })
        expect(modelClient.run).toHaveBeenCalledTimes(1)
    })

    it('copies direct bytes before permission awaits and needs no source permission', async () => {
        let allow!: () => void
        const { facade, client: modelClient, permission } = setup({
            requirePermission: () => new Promise<void>((resolve) => { allow = resolve }),
        })
        const acquire = facade.acquireLocalModelSession(PIXAI_PROFILE.id)
        allow()
        await acquire

        const source = png.slice()
        const original = source.slice()
        const pending = facade.runLocalModel(SESSION_A, {
            image: { kind: 'bytes', data: source, mediaType: 'image/png' },
        })
        source.fill(0)
        allow()
        await pending
        const sent = vi.mocked(modelClient.run).mock.calls[0][1]
        expect(sent).toEqual(original)
        expect(sent).not.toBe(source)
        expect(permission.mock.calls).toEqual([['localModelInference'], ['localModelInference']])
    })

    it('uses inlayWrite only for valid own lifecycle and inlayRead for foreign or legacy records', async () => {
        const own = await ownedRecord()
        const foreign = { ...own, lifecycle: { ...own.lifecycle!, ownerPrincipalId: '55555555-5555-4555-8555-555555555555' } }
        const legacy = { ...own, lifecycle: undefined }
        const records = [own, own, foreign, foreign, legacy, legacy]
        const { facade, permission } = setup({
            getInlayAssetRecord: async () => records.shift() ?? null,
            getInlayAssetBlob: async () => ({ data: new Blob([png]) }),
        })
        await facade.acquireLocalModelSession(PIXAI_PROFILE.id)

        for (const inlayId of [
            await deterministicInlayId(PRINCIPAL, own.lifecycle!.idempotencyKey),
            await deterministicInlayId(foreign.lifecycle!.ownerPrincipalId, foreign.lifecycle!.idempotencyKey),
            'legacy-id',
        ]) {
            await facade.runLocalModel(SESSION_A, {
                image: { kind: 'inlay', inlayId, revision: await revision(png) },
            })
        }
        expect(permission.mock.calls).toEqual([
            ['localModelInference'],
            ['localModelInference'], ['inlayWrite'],
            ['localModelInference'], ['inlayRead'],
            ['localModelInference'], ['inlayRead'],
        ])
    })

    it('treats an own-looking lifecycle relocated to a non-deterministic ID as foreign', async () => {
        const relocated = await ownedRecord()
        const { facade, client: modelClient, permission } = setup({
            getInlayAssetRecord: async () => relocated,
            getInlayAssetBlob: async () => ({ data: new Blob([png]) }),
            requirePermission: async (requested) => {
                if (requested === 'inlayRead') {
                    throw new PluginApiError('PERMISSION_DENIED', 'Foreign Inlay read was denied')
                }
            },
        })
        await facade.acquireLocalModelSession(PIXAI_PROFILE.id)

        await expect(facade.runLocalModel(SESSION_A, {
            image: { kind: 'inlay', inlayId: 'relocated-id', revision: await revision(png) },
        })).rejects.toMatchObject({ code: 'PERMISSION_DENIED' })
        expect(permission.mock.calls).toEqual([
            ['localModelInference'],
            ['localModelInference'],
            ['inlayRead'],
        ])
        expect(modelClient.run).not.toHaveBeenCalled()
    })

    it('rejects inlay races, revision, size and media failures before private inference', async () => {
        const own = await ownedRecord()
        const changed = { ...own, lifecycle: { ...own.lifecycle!, revision: `sha256:${'f'.repeat(64)}` } }
        const records = [own, changed]
        const race = setup({
            getInlayAssetRecord: async () => records.shift() ?? null,
            getInlayAssetBlob: async () => ({ data: new Blob([png]) }),
        })
        await race.facade.acquireLocalModelSession(PIXAI_PROFILE.id)
        await expect(race.facade.runLocalModel(SESSION_A, {
            image: { kind: 'inlay', inlayId: 'race-id', revision: await revision(png) },
        })).rejects.toMatchObject({ code: 'CONFLICT' })
        expect(race.client.run).not.toHaveBeenCalled()

        const badCases = [
            { blob: new Blob([png]), revision: `sha256:${'0'.repeat(64)}` },
            { blob: new Blob([new Uint8Array(33_554_433)]), revision: undefined },
            { blob: new Blob([new TextEncoder().encode('not-image')]), revision: undefined },
        ]
        for (const entry of badCases) {
            const record = { ...own, lifecycle: undefined }
            const failure = setup({
                getInlayAssetRecord: async () => record,
                getInlayAssetBlob: async () => ({ data: entry.blob }),
            })
            await failure.facade.acquireLocalModelSession(PIXAI_PROFILE.id)
            await expect(failure.facade.runLocalModel(SESSION_A, {
                image: { kind: 'inlay', inlayId: 'bad-id', ...(entry.revision ? { revision: entry.revision } : {}) },
            })).rejects.toMatchObject({ code: expect.stringMatching(/CONFLICT|RESOURCE_LIMIT|DECODE_FAILED/) })
            expect(failure.client.run).not.toHaveBeenCalled()
        }
    })

    it('best-effort releases every known session after context abort', async () => {
        const controller = new AbortController()
        const modelClient = client({
            acquire: vi.fn()
                .mockResolvedValueOnce({ sessionId: SESSION_A, provider: 'node' })
                .mockResolvedValueOnce({ sessionId: SESSION_B, provider: 'node' }),
            release: vi.fn(async (id: string) => {
                if (id === SESSION_A) throw new PluginApiError('NETWORK', 'transport')
            }),
        })
        const { facade } = setup({ context: executionContext(controller), client: modelClient })
        await facade.acquireLocalModelSession(PIXAI_PROFILE.id)
        await facade.acquireLocalModelSession(PIXAI_PROFILE.id)
        controller.abort()
        await expect(facade.releaseAll()).resolves.toBeUndefined()
        expect(vi.mocked(modelClient.release).mock.calls.map(([id]) => id).sort()).toEqual([
            SESSION_A, SESSION_B,
        ])
        await expect(facade.releaseLocalModelSession(SESSION_B)).rejects.toMatchObject({ code: 'NOT_FOUND' })
    })

    it('rejects hostile public shapes and never sends malformed source bytes', async () => {
        const { facade, client: modelClient } = setup()
        await facade.acquireLocalModelSession(PIXAI_PROFILE.id)
        const hostile = Object.defineProperty({}, 'image', {
            enumerable: true,
            get() { throw new Error('raw getter') },
        })
        await expect(facade.runLocalModel(SESSION_A, hostile)).rejects.toMatchObject({
            code: 'INVALID_ARGUMENT',
        })
        await expect(facade.runLocalModel(SESSION_A, {
            image: { kind: 'bytes', data: new Uint8Array([1]), mediaType: 'image/png' },
        })).rejects.toMatchObject({ code: 'DECODE_FAILED' })
        expect(modelClient.run).not.toHaveBeenCalled()
        expect(REVISION_PATTERN.test(await revision(png))).toBe(true)
    })
})

import type { InlayAssetRecord } from 'src/ts/process/files/inlays'
import type { ContextResourceService } from '../illustration/contextResources'
import { PluginApiError } from '../illustration/errors'
import type { PluginExecutionContext, PluginPermissionId } from '../illustration/permissions'
import {
    PIXAI_PROFILE,
    type PocketInferenceCapabilities,
    type PocketInferenceResult,
    type PocketInferenceRunOptions,
    type PocketLocalModelMediaType,
    type PocketLocalModelProvider,
    type PocketModelStatus,
} from './pocketPluginModelClient'

const MAX_INPUT_BYTES = 33_554_432
const MAX_INPUT_PIXELS = 64_000_000
const MAX_RESULT_TAGS = 500
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
const REVISION = /^sha256:[0-9a-f]{64}$/
const CONTEXT_ASSET_ID = /^ctxasset_[0-9a-f]{64}$/
const INLAY_ID = /^[A-Za-z0-9_-]{1,128}$/
const DIGEST = /^[0-9a-f]{64}$/
const MEDIA_TYPES = new Set<PocketLocalModelMediaType>(['image/jpeg', 'image/png', 'image/webp'])
const PROVIDERS = new Set<PocketLocalModelProvider>(['auto', 'webgpu', 'wasm', 'node'])
export const PIXAI_INFERENCE_CAPABILITY_ID = 'local-model.pixai-v0.9.v1'

export async function withPixaiInferenceCapability(
    ids: readonly string[] | undefined,
    registeredServices: Iterable<string>,
    backendHealthy: () => Promise<boolean>,
): Promise<Set<string>> {
    const result = new Set(registeredServices)
    if (ids !== undefined && !ids.includes(PIXAI_INFERENCE_CAPABILITY_ID)) return result
    try {
        if (await backendHealthy()) result.add(PIXAI_INFERENCE_CAPABILITY_ID)
    } catch {
        // An old or unhealthy backend remains truthfully unavailable.
    }
    return result
}

export type LocalModelProvider = PocketLocalModelProvider
export type LocalModelSessionId = string
export type LocalImageSource =
    | { kind: 'context-asset'; assetId: string; revision?: string }
    | { kind: 'inlay'; inlayId: string; revision?: string }
    | { kind: 'bytes'; data: Uint8Array; mediaType: PocketLocalModelMediaType }

export interface LocalModelCapabilities {
    supported: boolean
    reasons: string[]
    providers: Record<'webgpu' | 'wasm' | 'node', { available: boolean; reason?: string }>
    storage: {
        backend: 'node'
        usageBytes?: number
        quotaBytes?: number
        availableBytes?: number
        persistent: boolean
        resumable: boolean
    }
    limits: {
        maxInputBytes: number
        maxInputPixels: number
        maxResultTags: number
    }
}

export interface PixaiLocalModelClient {
    status(): Promise<PocketModelStatus>
    inferenceCapabilities(): Promise<PocketInferenceCapabilities>
    acquire(
        provider: PocketLocalModelProvider,
        signal: AbortSignal,
    ): Promise<{ sessionId: string; provider: 'node' }>
    run(
        sessionId: string,
        image: Uint8Array,
        mediaType: PocketLocalModelMediaType,
        options: PocketInferenceRunOptions,
        signal: AbortSignal,
    ): Promise<PocketInferenceResult>
    release(sessionId: string): Promise<void>
}

export interface PixaiLocalModelOptions {
    context: PluginExecutionContext
    client: PixaiLocalModelClient
    contextResources: Pick<ContextResourceService, 'readContextAsset'>
    requirePermission(permission: PluginPermissionId): Promise<void>
    getInlayAssetRecord(id: string): Promise<InlayAssetRecord | null>
    getInlayAssetBlob(id: string): Promise<({ data: Blob } & Record<string, unknown>) | null>
}

type NormalizedImageSource =
    | { kind: 'context-asset'; assetId: string; revision?: string }
    | { kind: 'inlay'; inlayId: string; revision?: string }
    | { kind: 'bytes'; data: Uint8Array; mediaType: PocketLocalModelMediaType }

type NormalizedRunRequest = PocketInferenceRunOptions & { image: NormalizedImageSource }

function invalid(message = 'Invalid local model inference request'): never {
    throw new PluginApiError('INVALID_ARGUMENT', message)
}

function aborted(): never {
    throw new PluginApiError('ABORTED', 'Local model inference aborted')
}

function internal(): never {
    throw new PluginApiError('INTERNAL', 'Internal plugin API error')
}

function exactObject(
    value: unknown,
    required: readonly string[],
    optional: readonly string[] = [],
    label = 'local model value',
): Record<string, unknown> {
    try {
        if (!value || typeof value !== 'object' || Array.isArray(value)) invalid(`Invalid ${label}`)
        const prototype = Object.getPrototypeOf(value)
        if (prototype !== Object.prototype && prototype !== null) invalid(`Invalid ${label}`)
        if (Object.getOwnPropertySymbols(value).length > 0) invalid(`Invalid ${label}`)
        const descriptors = Object.getOwnPropertyDescriptors(value)
        const allowed = new Set([...required, ...optional])
        const keys = Object.keys(descriptors)
        if (
            required.some((key) => !Object.hasOwn(descriptors, key))
            || keys.some((key) => !allowed.has(key))
            || keys.length < required.length
            || keys.length > required.length + optional.length
        ) invalid(`Invalid ${label}`)
        const result: Record<string, unknown> = {}
        for (const key of keys) {
            const descriptor = descriptors[key]
            if (!descriptor.enumerable || !('value' in descriptor)) invalid(`Invalid ${label}`)
            result[key] = descriptor.value
        }
        return result
    } catch (error) {
        if (error instanceof PluginApiError) throw error
        return invalid(`Invalid ${label}`)
    }
}

function assertProfile(value: unknown) {
    if (value !== PIXAI_PROFILE.id) invalid('Unsupported local model profile')
    return PIXAI_PROFILE.id
}

function assertRevision(value: unknown): string | undefined {
    if (value === undefined) return undefined
    if (typeof value !== 'string' || !REVISION.test(value)) invalid('Invalid image revision')
    return value
}

function assertSessionId(value: unknown): string {
    if (typeof value !== 'string' || !UUID.test(value)) invalid('Invalid local model session ID')
    return value.toLowerCase()
}

function sniffMediaType(data: Uint8Array): PocketLocalModelMediaType | undefined {
    if (
        data.byteLength >= 8
        && data[0] === 0x89 && data[1] === 0x50 && data[2] === 0x4e && data[3] === 0x47
        && data[4] === 0x0d && data[5] === 0x0a && data[6] === 0x1a && data[7] === 0x0a
    ) return 'image/png'
    if (data.byteLength >= 3 && data[0] === 0xff && data[1] === 0xd8 && data[2] === 0xff) {
        return 'image/jpeg'
    }
    if (
        data.byteLength >= 12
        && String.fromCharCode(...data.subarray(0, 4)) === 'RIFF'
        && String.fromCharCode(...data.subarray(8, 12)) === 'WEBP'
    ) return 'image/webp'
    return undefined
}

function validateImageBytes(
    value: unknown,
    expectedMediaType?: unknown,
): { data: Uint8Array; mediaType: PocketLocalModelMediaType } {
    if (!(value instanceof Uint8Array) || Object.getPrototypeOf(value) !== Uint8Array.prototype) {
        invalid('Image data must be a Uint8Array')
    }
    if (value.byteLength < 1) throw new PluginApiError('DECODE_FAILED', 'Image data is empty')
    if (value.byteLength > MAX_INPUT_BYTES) {
        throw new PluginApiError('RESOURCE_LIMIT', 'Image data exceeds the advertised limit')
    }
    const data = value.slice()
    const actual = sniffMediaType(data)
    if (!actual) throw new PluginApiError('DECODE_FAILED', 'Unsupported or invalid local image')
    if (expectedMediaType !== undefined) {
        if (typeof expectedMediaType !== 'string' || !MEDIA_TYPES.has(expectedMediaType as PocketLocalModelMediaType)) {
            throw new PluginApiError('DECODE_FAILED', 'Unsupported local image media type')
        }
        if (actual !== expectedMediaType) {
            throw new PluginApiError('DECODE_FAILED', 'Local image media type does not match its bytes')
        }
    }
    return { data, mediaType: actual }
}

function normalizeImageSource(value: unknown): NormalizedImageSource {
    const source = exactObject(value, ['kind'], ['assetId', 'inlayId', 'revision', 'data', 'mediaType'], 'image source')
    if (source.kind === 'context-asset') {
        const exact = exactObject(value, ['kind', 'assetId'], ['revision'], 'context asset source')
        if (typeof exact.assetId !== 'string' || !CONTEXT_ASSET_ID.test(exact.assetId)) {
            invalid('Invalid context asset handle')
        }
        const revision = assertRevision(exact.revision)
        return {
            kind: 'context-asset',
            assetId: exact.assetId,
            ...(revision === undefined ? {} : { revision }),
        }
    }
    if (source.kind === 'inlay') {
        const exact = exactObject(value, ['kind', 'inlayId'], ['revision'], 'Inlay source')
        if (typeof exact.inlayId !== 'string' || !INLAY_ID.test(exact.inlayId)) invalid('Invalid Inlay ID')
        const revision = assertRevision(exact.revision)
        return {
            kind: 'inlay',
            inlayId: exact.inlayId,
            ...(revision === undefined ? {} : { revision }),
        }
    }
    if (source.kind === 'bytes') {
        const exact = exactObject(value, ['kind', 'data', 'mediaType'], [], 'byte image source')
        const validated = validateImageBytes(exact.data, exact.mediaType)
        return { kind: 'bytes', data: validated.data, mediaType: validated.mediaType }
    }
    return invalid('Invalid image source kind')
}

function normalizeThresholds(value: unknown) {
    if (value === undefined) return undefined
    const data = exactObject(value, [], ['general', 'character'], 'local model thresholds')
    const result: { general?: number; character?: number } = {}
    for (const category of ['general', 'character'] as const) {
        const threshold = data[category]
        if (threshold === undefined) continue
        if (typeof threshold !== 'number' || !Number.isFinite(threshold) || threshold < 0 || threshold > 1) {
            invalid('Invalid local model threshold')
        }
        result[category] = threshold
    }
    return result
}

function normalizeCategories(value: unknown) {
    if (value === undefined) return undefined
    if (!Array.isArray(value) || value.length < 1 || value.length > 2) invalid('Invalid local model categories')
    const result: Array<'general' | 'character'> = []
    for (const category of value) {
        if ((category !== 'general' && category !== 'character') || result.includes(category)) {
            invalid('Invalid local model categories')
        }
        result.push(category)
    }
    return result
}

function normalizeRunRequest(value: unknown): NormalizedRunRequest {
    const data = exactObject(
        value,
        ['image'],
        ['thresholds', 'categories', 'maxResults'],
        'local model run request',
    )
    const thresholds = normalizeThresholds(data.thresholds)
    const categories = normalizeCategories(data.categories)
    if (data.maxResults !== undefined && (
        !Number.isSafeInteger(data.maxResults)
        || (data.maxResults as number) < 1
        || (data.maxResults as number) > MAX_RESULT_TAGS
    )) invalid('Invalid local model result limit')
    return {
        image: normalizeImageSource(data.image),
        ...(thresholds === undefined ? {} : { thresholds }),
        ...(categories === undefined ? {} : { categories }),
        ...(data.maxResults === undefined ? {} : { maxResults: data.maxResults as number }),
    }
}

function normalizeSignalOptions(value: unknown, allowProvider: boolean) {
    if (value === undefined) return { provider: 'auto' as PocketLocalModelProvider, signal: undefined }
    const data = exactObject(
        value,
        [],
        allowProvider ? ['provider', 'signal'] : ['signal'],
        'local model options',
    )
    const provider = data.provider === undefined ? 'auto' : data.provider
    if (!PROVIDERS.has(provider as PocketLocalModelProvider)) invalid('Invalid local model provider')
    if (data.signal !== undefined && !(data.signal instanceof AbortSignal)) invalid('Invalid abort signal')
    return { provider: provider as PocketLocalModelProvider, signal: data.signal as AbortSignal | undefined }
}

function combinedSignal(contextSignal: AbortSignal, callerSignal?: AbortSignal) {
    const controller = new AbortController()
    const signals = [...new Set([contextSignal, callerSignal].filter((value): value is AbortSignal => Boolean(value)))]
    const onAbort = () => controller.abort()
    for (const signal of signals) {
        if (signal.aborted) controller.abort()
        else signal.addEventListener('abort', onAbort, { once: true })
    }
    return {
        signal: controller.signal,
        dispose: () => {
            for (const signal of signals) signal.removeEventListener('abort', onAbort)
        },
    }
}

function throwIfAborted(signal: AbortSignal) {
    if (signal.aborted) aborted()
}

function sanitize(error: unknown, signal?: AbortSignal): never {
    if (signal?.aborted || (error instanceof DOMException && error.name === 'AbortError')) aborted()
    if (error instanceof PluginApiError) throw error
    return internal()
}

function lifecycleValue(value: unknown): Record<string, unknown> | undefined {
    try {
        const data = exactObject(value, [
            'version', 'ownerPrincipalId', 'operation', 'idempotencyKey',
            'argumentDigest', 'revision', 'context',
        ], [], 'Inlay lifecycle')
        const context = exactObject(data.context, ['kind', 'characterId'], [], 'Inlay lifecycle context')
        if (
            data.version !== 1
            || typeof data.ownerPrincipalId !== 'string'
            || !UUID.test(data.ownerPrincipalId)
            || data.operation !== 'inlay.create.v1'
            || typeof data.idempotencyKey !== 'string'
            || data.idempotencyKey.length < 1
            || new TextEncoder().encode(data.idempotencyKey).byteLength > 256
            || typeof data.argumentDigest !== 'string'
            || !DIGEST.test(data.argumentDigest)
            || typeof data.revision !== 'string'
            || !REVISION.test(data.revision)
            || context.kind !== 'character'
            || typeof context.characterId !== 'string'
            || context.characterId.length < 1
        ) return undefined
        return {
            version: 1,
            ownerPrincipalId: data.ownerPrincipalId.toLowerCase(),
            operation: 'inlay.create.v1',
            idempotencyKey: data.idempotencyKey,
            argumentDigest: data.argumentDigest,
            revision: data.revision,
            context: { kind: 'character', characterId: context.characterId },
        }
    } catch {
        return undefined
    }
}

function boundedFingerprint(value: unknown, depth = 0): unknown {
    if (depth > 4) return '[depth]'
    if (value === null || ['string', 'number', 'boolean'].includes(typeof value)) return value
    if (!value || typeof value !== 'object') return `[${typeof value}]`
    try {
        const descriptors = Object.getOwnPropertyDescriptors(value)
        const keys = Object.keys(descriptors).sort().slice(0, 32)
        const result: Record<string, unknown> = {}
        for (const key of keys) {
            const descriptor = descriptors[key]
            result[key] = descriptor && 'value' in descriptor
                ? boundedFingerprint(descriptor.value, depth + 1)
                : '[accessor]'
        }
        return result
    } catch {
        return '[unreadable]'
    }
}

async function deterministicLifecycleInlayId(ownerPrincipalId: string, idempotencyKey: string) {
    const encoded = new TextEncoder().encode(JSON.stringify([
        ownerPrincipalId,
        'inlay.create.v1',
        idempotencyKey,
    ]))
    const revision = await sha256Revision(encoded)
    return `inlay_${revision.slice('sha256:'.length)}`
}

async function lifecycleSnapshot(record: InlayAssetRecord, inlayId: string): Promise<{
    valid?: Record<string, unknown>
    key: string
    owner?: string
    revision?: string
}> {
    let descriptor: PropertyDescriptor | undefined
    try {
        descriptor = Object.getOwnPropertyDescriptor(record, 'lifecycle')
    } catch {
        return { key: 'malformed:[unreadable]' }
    }
    if (!descriptor || ('value' in descriptor && descriptor.value === undefined)) return { key: 'legacy' }
    if (!('value' in descriptor)) return { key: 'malformed:[accessor]' }
    const valid = lifecycleValue(descriptor.value)
    if (valid) {
        const expectedId = await deterministicLifecycleInlayId(
            valid.ownerPrincipalId as string,
            valid.idempotencyKey as string,
        )
        if (expectedId !== inlayId) {
            return { key: `relocated:${JSON.stringify(valid)}` }
        }
        return {
            valid,
            key: `valid:${JSON.stringify(valid)}`,
            owner: valid.ownerPrincipalId as string,
            revision: valid.revision as string,
        }
    }
    return { key: `malformed:${JSON.stringify(boundedFingerprint(descriptor.value))}` }
}

async function sha256Revision(data: Uint8Array) {
    const digest = await crypto.subtle.digest('SHA-256', data.slice().buffer)
    return `sha256:${[...new Uint8Array(digest)].map((value) => value.toString(16).padStart(2, '0')).join('')}`
}

export class PixaiLocalModel {
    private readonly context: PluginExecutionContext
    private readonly client: PixaiLocalModelClient
    private readonly contextResources: Pick<ContextResourceService, 'readContextAsset'>
    private readonly requirePermission: (permission: PluginPermissionId) => Promise<void>
    private readonly getInlayAssetRecord: (id: string) => Promise<InlayAssetRecord | null>
    private readonly getInlayAssetBlob: (id: string) => Promise<({ data: Blob } & Record<string, unknown>) | null>
    private readonly sessions = new Set<string>()

    constructor(options: PixaiLocalModelOptions) {
        this.context = options.context
        this.client = options.client
        this.contextResources = options.contextResources
        this.requirePermission = options.requirePermission
        this.getInlayAssetRecord = options.getInlayAssetRecord
        this.getInlayAssetBlob = options.getInlayAssetBlob
    }

    async backendHealthy(): Promise<boolean> {
        try {
            return (await this.client.inferenceCapabilities()).backendAvailable
        } catch {
            return false
        }
    }

    async getLocalModelCapabilities(profileValue: unknown): Promise<LocalModelCapabilities> {
        assertProfile(profileValue)
        let probe: PocketInferenceCapabilities
        try {
            probe = await this.client.inferenceCapabilities()
        } catch {
            probe = {
                backendAvailable: false,
                modelReady: false,
                reason: 'runtime-unavailable',
                providers: {
                    node: { available: false },
                    webgpu: { available: false },
                    wasm: { available: false },
                },
            }
        }
        let status: PocketModelStatus | undefined
        try {
            status = await this.client.status()
        } catch {
            status = undefined
        }
        const healthy = probe.backendAvailable
        const reasons = healthy
            ? (probe.modelReady ? [] : ['model-not-ready'])
            : ['runtime-unavailable']
        const storage: LocalModelCapabilities['storage'] = {
            backend: 'node',
            persistent: status?.storage.persistent ?? true,
            resumable: status?.storage.resumable ?? true,
        }
        if (status?.storage.usageBytes !== undefined) storage.usageBytes = status.storage.usageBytes
        if (status?.storage.quotaBytes !== undefined) storage.quotaBytes = status.storage.quotaBytes
        if (storage.usageBytes !== undefined && storage.quotaBytes !== undefined) {
            storage.availableBytes = Math.max(0, storage.quotaBytes - storage.usageBytes)
        }
        return {
            supported: healthy,
            reasons,
            providers: {
                node: probe.modelReady && probe.providers.node.available
                    ? { available: true }
                    : { available: false, reason: healthy ? 'model-not-ready' : 'runtime-unavailable' },
                webgpu: { available: false, reason: 'unsupported-provider' },
                wasm: { available: false, reason: 'unsupported-provider' },
            },
            storage,
            limits: {
                maxInputBytes: MAX_INPUT_BYTES,
                maxInputPixels: MAX_INPUT_PIXELS,
                maxResultTags: MAX_RESULT_TAGS,
            },
        }
    }

    async acquireLocalModelSession(profileValue: unknown, optionsValue?: unknown) {
        assertProfile(profileValue)
        const options = normalizeSignalOptions(optionsValue, true)
        const combined = combinedSignal(this.context.signal, options.signal)
        let acquired: { sessionId: string; provider: 'node' } | undefined
        try {
            throwIfAborted(combined.signal)
            await this.requirePermission('localModelInference')
            throwIfAborted(combined.signal)
            acquired = await this.client.acquire(options.provider, combined.signal)
            if (!UUID.test(acquired.sessionId) || acquired.provider !== 'node') internal()
            if (combined.signal.aborted) {
                try { await this.client.release(acquired.sessionId) } catch { /* best effort */ }
                aborted()
            }
            const normalizedId = acquired.sessionId.toLowerCase()
            this.sessions.add(normalizedId)
            return { sessionId: normalizedId, provider: 'node' as const }
        } catch (error) {
            return sanitize(error, combined.signal)
        } finally {
            combined.dispose()
        }
    }

    private async resolveContextAsset(
        source: Extract<NormalizedImageSource, { kind: 'context-asset' }>,
        signal: AbortSignal,
    ) {
        const value = await this.contextResources.readContextAsset(source.assetId, {
            ifRevision: source.revision,
            variant: 'original',
            maxBytes: MAX_INPUT_BYTES,
            signal,
        })
        return validateImageBytes(value.data, value.mediaType)
    }

    private async resolveInlay(
        source: Extract<NormalizedImageSource, { kind: 'inlay' }>,
        signal: AbortSignal,
    ) {
        const before = await this.getInlayAssetRecord(source.inlayId)
        throwIfAborted(signal)
        if (!before) throw new PluginApiError('NOT_FOUND', 'Inlay was not found')
        const beforeLifecycle = await lifecycleSnapshot(before, source.inlayId)
        throwIfAborted(signal)
        await this.requirePermission(beforeLifecycle.owner === this.context.principalId
            ? 'inlayWrite'
            : 'inlayRead')
        throwIfAborted(signal)
        const blobRecord = await this.getInlayAssetBlob(source.inlayId)
        throwIfAborted(signal)
        if (!blobRecord) throw new PluginApiError('CONFLICT', 'Inlay changed while it was being read', { retryable: true })
        const descriptor = Object.getOwnPropertyDescriptor(blobRecord, 'data')
        if (!descriptor?.enumerable || !('value' in descriptor) || !(descriptor.value instanceof Blob)) internal()
        const blob = descriptor.value
        if (blob.size < 1) throw new PluginApiError('DECODE_FAILED', 'Inlay image is empty')
        if (blob.size > MAX_INPUT_BYTES) {
            throw new PluginApiError('RESOURCE_LIMIT', 'Inlay image exceeds the advertised limit')
        }
        let data: Uint8Array
        try {
            data = new Uint8Array(await blob.arrayBuffer()).slice()
        } catch (error) {
            return sanitize(error, signal)
        }
        throwIfAborted(signal)
        const actualRevision = await sha256Revision(data)
        throwIfAborted(signal)
        if (source.revision !== undefined && source.revision !== actualRevision) {
            throw new PluginApiError('CONFLICT', 'Inlay revision changed', { retryable: true })
        }
        if (beforeLifecycle.revision !== undefined && beforeLifecycle.revision !== actualRevision) {
            throw new PluginApiError('CONFLICT', 'Inlay lifecycle revision does not match its bytes', { retryable: true })
        }
        const after = await this.getInlayAssetRecord(source.inlayId)
        throwIfAborted(signal)
        if (!after || (await lifecycleSnapshot(after, source.inlayId)).key !== beforeLifecycle.key) {
            throw new PluginApiError('CONFLICT', 'Inlay changed while it was being read', { retryable: true })
        }
        return validateImageBytes(data)
    }

    private async resolveImage(source: NormalizedImageSource, signal: AbortSignal) {
        if (source.kind === 'bytes') return { data: source.data.slice(), mediaType: source.mediaType }
        if (source.kind === 'context-asset') return this.resolveContextAsset(source, signal)
        return this.resolveInlay(source, signal)
    }

    async runLocalModel(sessionIdValue: unknown, requestValue: unknown, optionsValue?: unknown) {
        const sessionId = assertSessionId(sessionIdValue)
        if (!this.sessions.has(sessionId)) throw new PluginApiError('NOT_FOUND', 'Local model session was not found')
        const request = normalizeRunRequest(requestValue)
        const options = normalizeSignalOptions(optionsValue, false)
        const combined = combinedSignal(this.context.signal, options.signal)
        try {
            throwIfAborted(combined.signal)
            await this.requirePermission('localModelInference')
            throwIfAborted(combined.signal)
            const image = await this.resolveImage(request.image, combined.signal)
            throwIfAborted(combined.signal)
            const runOptions: PocketInferenceRunOptions = {
                ...(request.thresholds === undefined ? {} : { thresholds: request.thresholds }),
                ...(request.categories === undefined ? {} : { categories: request.categories }),
                ...(request.maxResults === undefined ? {} : { maxResults: request.maxResults }),
            }
            return await this.client.run(
                sessionId,
                image.data,
                image.mediaType,
                runOptions,
                combined.signal,
            )
        } catch (error) {
            return sanitize(error, combined.signal)
        } finally {
            combined.dispose()
        }
    }

    async releaseLocalModelSession(sessionIdValue: unknown): Promise<void> {
        const sessionId = assertSessionId(sessionIdValue)
        if (!this.sessions.has(sessionId)) throw new PluginApiError('NOT_FOUND', 'Local model session was not found')
        try {
            await this.client.release(sessionId)
            this.sessions.delete(sessionId)
        } catch (error) {
            return sanitize(error)
        }
    }

    async releaseAll(): Promise<void> {
        const sessions = [...this.sessions]
        this.sessions.clear()
        await Promise.allSettled(sessions.map((sessionId) => this.client.release(sessionId)))
    }
}

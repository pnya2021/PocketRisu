import { PluginApiError } from '../illustration/errors'
import type { PluginApiErrorCode } from '../illustration/contracts'

export const PIXAI_PROFILE = Object.freeze({
    id: 'pixai-tagger-v0.9-onnx',
    repository: 'deepghs/pixai-tagger-v0.9-onnx',
    revision: 'd8cf666911a2c3d10d586d7823259192313c7eb7',
    sourceUrl: 'https://huggingface.co/deepghs/pixai-tagger-v0.9-onnx',
    license: 'Apache-2.0',
    licenseUrl: 'https://www.apache.org/licenses/LICENSE-2.0',
    totalBytes: 1_271_963_279,
    artifacts: Object.freeze([
        Object.freeze({
            name: 'model.onnx',
            bytes: 1_271_365_854,
            sha256: 'a8d479098b5e23f253543c93df42391736abbb77c21c2efd3a513b9cda7b3657',
        }),
        Object.freeze({
            name: 'selected_tags.csv',
            bytes: 596_868,
            sha256: '76b5dd39354a7a4d9baefb94d63b44a09a4934ee15303b7eb86c38f2128eb68a',
        }),
        Object.freeze({
            name: 'preprocess.json',
            bytes: 557,
            sha256: '5f8303626704053724fa7ac19cd269f57f5f843b6cca314276c8c4d48d335975',
        }),
    ]),
} as const)

export type PixaiProfileId = typeof PIXAI_PROFILE.id
export type PocketLocalModelProvider = 'auto' | 'webgpu' | 'wasm' | 'node'
export type PocketLocalModelMediaType = 'image/jpeg' | 'image/png' | 'image/webp'
export type PocketLocalModelCategory = 'general' | 'character'
export type PocketModelArtifactState = 'absent' | 'partial' | 'verified'
export type PocketModelProgressPhase = 'downloading' | 'verifying' | 'committing'

export interface PocketModelArtifactStatus {
    name: string
    sha256: string
    state: PocketModelArtifactState
    storedBytes: number
    expectedBytes: number
}

export interface PocketModelProgress {
    profileId: PixaiProfileId
    artifact: string
    phase: PocketModelProgressPhase
    artifactLoadedBytes: number
    artifactTotalBytes: number
    loadedBytes: number
    totalBytes: number
}

export interface PocketModelStatus {
    profileId: PixaiProfileId
    revision: string
    state: PocketModelArtifactState
    storedBytes: number
    totalBytes: number
    artifacts: PocketModelArtifactStatus[]
    storage: {
        kind: 'node'
        persistent: boolean
        resumable: true
        usageBytes?: number
        quotaBytes?: number
    }
    active?: PocketModelProgress
}

export interface PocketInferenceCapabilities {
    backendAvailable: boolean
    modelReady: boolean
    reason?: string
    providers: Record<'node' | 'webgpu' | 'wasm', { available: boolean }>
}

export interface PocketInferenceRunOptions {
    thresholds?: { general?: number; character?: number }
    categories?: PocketLocalModelCategory[]
    maxResults?: number
}

export interface PocketInferenceResult {
    model: {
        profile: PixaiProfileId
        revision: string
        sha256: string
        preprocessVersion: string
    }
    execution: { provider: 'node' }
    tags: Array<{
        index: number
        name: string
        score: number
        category: PocketLocalModelCategory
    }>
    thresholds: { general: number; character: number }
    truncated: boolean
    timingMs: {
        decode: number
        preprocess: number
        inference: number
        postprocess: number
        total: number
    }
    warnings: string[]
}

export interface PocketPluginModelBridge {
    pluginModelStatus(): Promise<Response>
    pluginModelDownload(principalId: string, signal: AbortSignal): Promise<Response>
    pluginModelCancel(principalId: string): Promise<Response>
    pluginModelRemove(principalId: string, includePartial: boolean): Promise<Response>
    pluginModelInferenceCapabilities(): Promise<Response>
    pluginModelInferenceAcquire(
        principalId: string,
        instanceId: string,
        provider: PocketLocalModelProvider,
        signal: AbortSignal,
    ): Promise<Response>
    pluginModelInferenceRun(
        principalId: string,
        instanceId: string,
        sessionId: string,
        image: Uint8Array,
        mediaType: PocketLocalModelMediaType,
        options: PocketInferenceRunOptions,
        signal: AbortSignal,
    ): Promise<Response>
    pluginModelInferenceRelease(
        principalId: string,
        instanceId: string,
        sessionId: string,
    ): Promise<Response>
}

const PRINCIPAL_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
const MAX_JSON_BYTES = 64 * 1024
const MAX_NDJSON_RECORD_BYTES = 64 * 1024
const MAX_NDJSON_BYTES = 4 * 1024 * 1024
const MAX_NDJSON_RECORDS = 4096
const MAX_INFERENCE_TAGS = 500
const MAX_IMAGE_BYTES = 33_554_432
const MAX_SAFE_TEXT_BYTES = 512
const MAX_WARNINGS = 16
const MAX_TIMING_MS = 300_000
const MAX_TAG_INDEX = 13_460
const PIXAI_PREPROCESS_VERSION = 'pixai-v0.9-preprocess-448-rgb-bilinear-v1'
const INFERENCE_MEDIA_TYPES = new Set<PocketLocalModelMediaType>(['image/jpeg', 'image/png', 'image/webp'])
const INFERENCE_PROVIDERS = new Set<PocketLocalModelProvider>(['auto', 'webgpu', 'wasm', 'node'])

const INTERNAL_MESSAGE = 'Internal plugin API error'

function internal(): PluginApiError {
    return new PluginApiError('INTERNAL', INTERNAL_MESSAGE)
}

function network(): PluginApiError {
    return new PluginApiError('NETWORK', 'Local model transport failed', {
        retryable: true,
    })
}

function aborted(): PluginApiError {
    return new PluginApiError('ABORTED', 'Local model download aborted')
}

function inferenceAborted(): PluginApiError {
    return new PluginApiError('ABORTED', 'Local model inference aborted')
}

function unsupported(): PluginApiError {
    return new PluginApiError('UNSUPPORTED', 'Local model installation is unavailable')
}

function conflict(): PluginApiError {
    return new PluginApiError('CONFLICT', 'A local model operation is already active')
}

function exactDataObject(
    value: unknown,
    required: readonly string[],
    optional: readonly string[] = [],
): Record<string, unknown> {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) throw internal()
    let prototype: object | null
    let descriptors: PropertyDescriptorMap
    try {
        prototype = Object.getPrototypeOf(value)
        descriptors = Object.getOwnPropertyDescriptors(value)
    } catch {
        throw internal()
    }
    if (prototype !== Object.prototype && prototype !== null) throw internal()
    if (Object.getOwnPropertySymbols(value).length > 0) throw internal()
    const allowed = new Set([...required, ...optional])
    const keys = Object.keys(descriptors)
    if (
        required.some((key) => !(key in descriptors))
        || keys.some((key) => !allowed.has(key))
        || keys.length < required.length
        || keys.length > required.length + optional.length
    ) throw internal()
    const result: Record<string, unknown> = {}
    for (const key of keys) {
        const descriptor = descriptors[key]
        if (!descriptor.enumerable || !('value' in descriptor)) throw internal()
        result[key] = descriptor.value
    }
    return result
}

function safeBytes(value: unknown): number {
    if (!Number.isSafeInteger(value) || (value as number) < 0) throw internal()
    return value as number
}

function safeFinite(value: unknown, maximum = Number.MAX_VALUE): number {
    if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > maximum) {
        throw internal()
    }
    return value
}

function safeText(value: unknown, allowEmpty = false): string {
    if (
        typeof value !== 'string'
        || (!allowEmpty && value.length === 0)
        || new TextEncoder().encode(value).byteLength > MAX_SAFE_TEXT_BYTES
        || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(value)
    ) throw internal()
    return value
}

function sessionId(value: unknown): string {
    if (typeof value !== 'string' || !PRINCIPAL_PATTERN.test(value)) throw internal()
    return value.toLowerCase()
}

function decodeProviderAvailability(value: unknown): { available: boolean } {
    const data = exactDataObject(value, ['available'])
    if (typeof data.available !== 'boolean') throw internal()
    return { available: data.available }
}

function decodeInferenceCapabilities(value: unknown): PocketInferenceCapabilities {
    const data = exactDataObject(
        value,
        ['backendAvailable', 'modelReady', 'providers'],
        ['reason'],
    )
    if (typeof data.backendAvailable !== 'boolean' || typeof data.modelReady !== 'boolean') {
        throw internal()
    }
    const providersData = exactDataObject(data.providers, ['node', 'webgpu', 'wasm'])
    const providers = {
        node: decodeProviderAvailability(providersData.node),
        webgpu: decodeProviderAvailability(providersData.webgpu),
        wasm: decodeProviderAvailability(providersData.wasm),
    }
    const expectedNode = data.backendAvailable && data.modelReady
    if (
        data.modelReady && !data.backendAvailable
        || providers.node.available !== expectedNode
        || providers.webgpu.available
        || providers.wasm.available
    ) throw internal()
    let reason: string | undefined
    if (data.reason !== undefined) reason = safeText(data.reason)
    if ((data.backendAvailable && data.modelReady) === (reason !== undefined)) throw internal()
    return {
        backendAvailable: data.backendAvailable,
        modelReady: data.modelReady,
        ...(reason === undefined ? {} : { reason }),
        providers,
    }
}

function normalizeInferenceOptions(value: unknown): PocketInferenceRunOptions {
    const data = exactDataObject(value, [], ['thresholds', 'categories', 'maxResults'])
    const result: PocketInferenceRunOptions = {}
    if (data.thresholds !== undefined) {
        const thresholds = exactDataObject(data.thresholds, [], ['general', 'character'])
        const normalized: { general?: number; character?: number } = {}
        for (const category of ['general', 'character'] as const) {
            if (thresholds[category] === undefined) continue
            const threshold = safeFinite(thresholds[category], 1)
            normalized[category] = threshold
        }
        result.thresholds = normalized
    }
    if (data.categories !== undefined) {
        if (!Array.isArray(data.categories) || data.categories.length < 1 || data.categories.length > 2) {
            throw internal()
        }
        const categories: PocketLocalModelCategory[] = []
        for (const category of data.categories) {
            if (
                (category !== 'general' && category !== 'character')
                || categories.includes(category)
            ) throw internal()
            categories.push(category)
        }
        result.categories = categories
    }
    if (data.maxResults !== undefined) {
        if (!Number.isSafeInteger(data.maxResults) || (data.maxResults as number) < 1
            || (data.maxResults as number) > MAX_INFERENCE_TAGS) throw internal()
        result.maxResults = data.maxResults as number
    }
    return result
}

function decodeInferenceResult(value: unknown): PocketInferenceResult {
    const data = exactDataObject(value, [
        'modelProfileId', 'modelRevision', 'modelSha256', 'preprocessVersion',
        'provider', 'tags', 'thresholds', 'truncated', 'timings', 'warnings',
    ])
    if (
        data.modelProfileId !== PIXAI_PROFILE.id
        || data.modelRevision !== PIXAI_PROFILE.revision
        || data.modelSha256 !== PIXAI_PROFILE.artifacts[0].sha256
        || data.preprocessVersion !== PIXAI_PREPROCESS_VERSION
        || data.provider !== 'node'
        || typeof data.truncated !== 'boolean'
        || !Array.isArray(data.tags)
        || data.tags.length > MAX_INFERENCE_TAGS
        || !Array.isArray(data.warnings)
        || data.warnings.length > MAX_WARNINGS
    ) throw internal()

    const seen = new Set<number>()
    const tags = data.tags.map((value) => {
        const tag = exactDataObject(value, ['index', 'name', 'score', 'category'])
        if (
            !Number.isSafeInteger(tag.index)
            || (tag.index as number) < 0
            || (tag.index as number) > MAX_TAG_INDEX
            || seen.has(tag.index as number)
            || (tag.category !== 'general' && tag.category !== 'character')
        ) throw internal()
        const index = tag.index as number
        seen.add(index)
        return {
            index,
            name: safeText(tag.name),
            score: safeFinite(tag.score, 1),
            category: tag.category as PocketLocalModelCategory,
        }
    })

    const thresholdData = exactDataObject(data.thresholds, ['general', 'character'])
    const thresholds = {
        general: safeFinite(thresholdData.general, 1),
        character: safeFinite(thresholdData.character, 1),
    }
    const timingData = exactDataObject(data.timings, [
        'decodeMs', 'preprocessMs', 'inferenceMs', 'postprocessMs', 'totalMs',
    ])
    const timingMs = {
        decode: safeFinite(timingData.decodeMs, MAX_TIMING_MS),
        preprocess: safeFinite(timingData.preprocessMs, MAX_TIMING_MS),
        inference: safeFinite(timingData.inferenceMs, MAX_TIMING_MS),
        postprocess: safeFinite(timingData.postprocessMs, MAX_TIMING_MS),
        total: safeFinite(timingData.totalMs, MAX_TIMING_MS),
    }
    if (timingMs.total < Math.max(
        timingMs.decode,
        timingMs.preprocess,
        timingMs.inference,
        timingMs.postprocess,
    )) throw internal()
    const warnings = data.warnings.map((warning) => safeText(warning, true))

    return {
        model: {
            profile: PIXAI_PROFILE.id,
            revision: PIXAI_PROFILE.revision,
            sha256: PIXAI_PROFILE.artifacts[0].sha256,
            preprocessVersion: PIXAI_PREPROCESS_VERSION,
        },
        execution: { provider: 'node' },
        tags,
        thresholds,
        truncated: data.truncated,
        timingMs,
        warnings,
    }
}

function artifactByName(name: unknown) {
    if (typeof name !== 'string') throw internal()
    const artifact = PIXAI_PROFILE.artifacts.find((candidate) => candidate.name === name)
    if (!artifact) throw internal()
    return artifact
}

function decodeProgress(value: unknown, includesType: boolean): PocketModelProgress {
    const data = exactDataObject(
        value,
        includesType
            ? ['type', 'profileId', 'artifact', 'phase', 'artifactLoadedBytes', 'artifactTotalBytes', 'loadedBytes', 'totalBytes']
            : ['profileId', 'artifact', 'phase', 'artifactLoadedBytes', 'artifactTotalBytes', 'loadedBytes', 'totalBytes'],
    )
    if (includesType && data.type !== 'progress') throw internal()
    if (data.profileId !== PIXAI_PROFILE.id) throw internal()
    const artifact = artifactByName(data.artifact)
    if (!['downloading', 'verifying', 'committing'].includes(data.phase as string)) throw internal()
    const artifactLoadedBytes = safeBytes(data.artifactLoadedBytes)
    const artifactTotalBytes = safeBytes(data.artifactTotalBytes)
    const loadedBytes = safeBytes(data.loadedBytes)
    const totalBytes = safeBytes(data.totalBytes)
    if (
        artifactTotalBytes !== artifact.bytes
        || totalBytes !== PIXAI_PROFILE.totalBytes
        || artifactLoadedBytes > artifactTotalBytes
        || loadedBytes > totalBytes
        || loadedBytes < artifactLoadedBytes
    ) throw internal()
    return {
        profileId: PIXAI_PROFILE.id,
        artifact: artifact.name,
        phase: data.phase as PocketModelProgressPhase,
        artifactLoadedBytes,
        artifactTotalBytes,
        loadedBytes,
        totalBytes,
    }
}

function decodeStatus(value: unknown): PocketModelStatus {
    const data = exactDataObject(
        value,
        ['profileId', 'revision', 'state', 'storedBytes', 'totalBytes', 'artifacts', 'storage'],
        ['active'],
    )
    if (
        data.profileId !== PIXAI_PROFILE.id
        || data.revision !== PIXAI_PROFILE.revision
        || !['absent', 'partial', 'verified'].includes(data.state as string)
        || safeBytes(data.totalBytes) !== PIXAI_PROFILE.totalBytes
        || !Array.isArray(data.artifacts)
        || data.artifacts.length !== PIXAI_PROFILE.artifacts.length
    ) throw internal()

    const artifacts = data.artifacts.map((value, index): PocketModelArtifactStatus => {
        const decoded = exactDataObject(
            value,
            ['name', 'sha256', 'state', 'storedBytes', 'expectedBytes'],
        )
        const expected = PIXAI_PROFILE.artifacts[index]
        if (
            decoded.name !== expected.name
            || decoded.sha256 !== expected.sha256
            || !['absent', 'partial', 'verified'].includes(decoded.state as string)
            || safeBytes(decoded.expectedBytes) !== expected.bytes
        ) throw internal()
        const storedBytes = safeBytes(decoded.storedBytes)
        if (
            storedBytes > expected.bytes
            || (decoded.state === 'absent' && storedBytes !== 0)
            || (decoded.state === 'verified' && storedBytes !== expected.bytes)
        ) throw internal()
        return {
            name: expected.name,
            sha256: expected.sha256,
            state: decoded.state as PocketModelArtifactState,
            storedBytes,
            expectedBytes: expected.bytes,
        }
    })
    const storedBytes = safeBytes(data.storedBytes)
    if (storedBytes !== artifacts.reduce((sum, artifact) => sum + artifact.storedBytes, 0)) {
        throw internal()
    }
    const aggregateState = artifacts.every((artifact) => artifact.state === 'verified')
        ? 'verified'
        : artifacts.every((artifact) => artifact.state === 'absent')
            ? 'absent'
            : 'partial'
    if (data.state !== aggregateState) throw internal()

    const storageData = exactDataObject(
        data.storage,
        ['kind', 'persistent', 'resumable'],
        ['usageBytes', 'quotaBytes'],
    )
    if (
        storageData.kind !== 'node'
        || typeof storageData.persistent !== 'boolean'
        || storageData.resumable !== true
    ) throw internal()
    const storage: PocketModelStatus['storage'] = {
        kind: 'node',
        persistent: storageData.persistent,
        resumable: true,
    }
    if (storageData.usageBytes !== undefined) storage.usageBytes = safeBytes(storageData.usageBytes)
    if (storageData.quotaBytes !== undefined) storage.quotaBytes = safeBytes(storageData.quotaBytes)

    return {
        profileId: PIXAI_PROFILE.id,
        revision: PIXAI_PROFILE.revision,
        state: data.state as PocketModelArtifactState,
        storedBytes,
        totalBytes: PIXAI_PROFILE.totalBytes,
        artifacts,
        storage,
        ...(data.active === undefined ? {} : { active: decodeProgress(data.active, false) }),
    }
}

function mapServerCode(code: unknown): PluginApiError {
    switch (code) {
        case 'ABORTED':
            return aborted()
        case 'NETWORK_ERROR':
            return network()
        case 'INTEGRITY_ERROR':
            return new PluginApiError('INTEGRITY_MISMATCH', 'Local model verification failed')
        case 'STORAGE_QUOTA':
            return new PluginApiError('QUOTA_EXCEEDED', 'Insufficient local model storage quota')
        case 'STORAGE_ERROR':
        default:
            return internal()
    }
}

function mapInferenceServerCode(code: unknown, retryable: unknown): PluginApiError {
    if (typeof retryable !== 'boolean') throw internal()
    const definitions: Partial<Record<string, { message: string; retryable: boolean | 'server' }>> = {
        NOT_FOUND: { message: 'Local model resource was not found', retryable: false },
        UNSUPPORTED: { message: 'Local model inference is unavailable', retryable: false },
        INVALID_ARGUMENT: { message: 'Invalid local model inference request', retryable: false },
        RESOURCE_LIMIT: { message: 'Local model inference resource limit reached', retryable: true },
        CONFLICT: { message: 'Local model inference conflict', retryable: 'server' },
        ABORTED: { message: 'Local model inference aborted', retryable: false },
        DECODE_FAILED: { message: 'Local image decode failed', retryable: false },
        PROVIDER_ERROR: { message: 'Local model inference provider failed', retryable: true },
    }
    if (typeof code !== 'string') throw internal()
    const definition = definitions[code]
    if (!definition || (definition.retryable !== 'server' && retryable !== definition.retryable)) {
        throw internal()
    }
    const publicRetryable = definition.retryable === 'server' ? retryable : definition.retryable
    return new PluginApiError(code as PluginApiErrorCode, definition.message, {
        retryable: publicRetryable,
    })
}

async function readBoundedText(response: Response, maximum: number): Promise<string> {
    if (!response.body) throw network()
    const reader = response.body.getReader()
    const decoder = new TextDecoder('utf-8', { fatal: true })
    let bytes = 0
    let text = ''
    try {
        while (true) {
            let chunk: ReadableStreamReadResult<Uint8Array>
            try {
                chunk = await reader.read()
            } catch {
                throw network()
            }
            if (chunk.done) break
            bytes += chunk.value.byteLength
            if (bytes > maximum) throw internal()
            try {
                text += decoder.decode(chunk.value, { stream: true })
            } catch {
                throw internal()
            }
        }
        try {
            text += decoder.decode()
        } catch {
            throw internal()
        }
        return text
    } finally {
        reader.releaseLock()
    }
}

async function decodeJsonResponse(response: Response): Promise<unknown> {
    const text = await readBoundedText(response, MAX_JSON_BYTES)
    try {
        return JSON.parse(text)
    } catch {
        throw internal()
    }
}

async function responseError(response: Response, inference = false): Promise<never> {
    if (!inference && [404, 405, 501].includes(response.status)) throw unsupported()
    if (!inference && response.status === 409) throw conflict()
    let body: unknown
    try {
        body = await decodeJsonResponse(response)
        const envelope = exactDataObject(body, ['error'])
        const error = exactDataObject(
            envelope.error,
            inference ? ['code', 'message', 'retryable'] : ['code', 'message'],
        )
        if (typeof error.message !== 'string') throw internal()
        throw inference
            ? mapInferenceServerCode(error.code, error.retryable)
            : mapServerCode(error.code)
    } catch (error) {
        if (error instanceof PluginApiError) throw error
        throw internal()
    }
}

async function checkedResponse(
    call: () => Promise<Response>,
    signal?: AbortSignal,
    inference = false,
): Promise<Response> {
    let response: Response
    try {
        response = await call()
    } catch {
        if (signal?.aborted) throw inference ? inferenceAborted() : aborted()
        throw network()
    }
    if (!(response instanceof Response)) throw internal()
    if (!response.ok) await responseError(response, inference)
    return response
}

function decodeAccepted(value: unknown): void {
    const data = exactDataObject(value, ['type', 'joined', 'profileId'])
    if (
        data.type !== 'accepted'
        || typeof data.joined !== 'boolean'
        || data.profileId !== PIXAI_PROFILE.id
    ) throw internal()
}

function decodeDone(value: unknown): { state: 'verified'; bytes: number } {
    const data = exactDataObject(value, ['type', 'state', 'bytes'])
    if (
        data.type !== 'done'
        || data.state !== 'verified'
        || safeBytes(data.bytes) !== PIXAI_PROFILE.totalBytes
    ) throw internal()
    return { state: 'verified', bytes: PIXAI_PROFILE.totalBytes }
}

function decodeStreamError(value: unknown): PluginApiError {
    const data = exactDataObject(value, ['type', 'code', 'message'])
    if (data.type !== 'error' || typeof data.message !== 'string') throw internal()
    return mapServerCode(data.code)
}

export class PocketPluginModelClient {
    private readonly bridge: PocketPluginModelBridge
    private readonly principalId: string
    private readonly instanceId?: string

    constructor(bridge: PocketPluginModelBridge, principalId: string, instanceId?: string) {
        if (!PRINCIPAL_PATTERN.test(principalId)) throw internal()
        if (instanceId !== undefined && !PRINCIPAL_PATTERN.test(instanceId)) throw internal()
        this.bridge = bridge
        this.principalId = principalId.toLowerCase()
        this.instanceId = instanceId?.toLowerCase()
    }

    private inferenceInstance(): string {
        if (!this.instanceId) throw internal()
        return this.instanceId
    }

    async status(): Promise<PocketModelStatus> {
        const response = await checkedResponse(() => this.bridge.pluginModelStatus())
        return decodeStatus(await decodeJsonResponse(response))
    }

    async download(
        signal: AbortSignal,
        onProgress?: (progress: PocketModelProgress) => unknown,
    ): Promise<{ state: 'verified'; bytes: number }> {
        if (!(signal instanceof AbortSignal)) throw internal()
        if (onProgress !== undefined && typeof onProgress !== 'function') throw internal()
        const response = await checkedResponse(
            () => this.bridge.pluginModelDownload(this.principalId, signal),
            signal,
        )
        if (!response.body) throw network()

        const reader = response.body.getReader()
        const decoder = new TextDecoder('utf-8', { fatal: true })
        const encoder = new TextEncoder()
        let aggregateBytes = 0
        let buffered = ''
        let records = 0
        let accepted = false
        let terminal: { result?: { state: 'verified'; bytes: number }; error?: PluginApiError } | undefined

        const consume = (line: string) => {
            records += 1
            if (records > MAX_NDJSON_RECORDS) throw internal()
            if (encoder.encode(line).byteLength > MAX_NDJSON_RECORD_BYTES) throw internal()
            let value: unknown
            try {
                value = JSON.parse(line)
            } catch {
                throw internal()
            }
            if (terminal) throw internal()
            const record = exactDataObject(value, ['type'], [
                'joined', 'profileId', 'artifact', 'phase', 'artifactLoadedBytes',
                'artifactTotalBytes', 'loadedBytes', 'totalBytes', 'state', 'bytes',
                'code', 'message',
            ])
            if (!accepted) {
                decodeAccepted(value)
                accepted = true
                return
            }
            if (record.type === 'accepted') throw internal()
            if (record.type === 'progress') {
                const progress = decodeProgress(value, true)
                if (onProgress) {
                    try {
                        void Promise.resolve(onProgress({ ...progress })).catch(() => undefined)
                    } catch {
                        // Progress callbacks are advisory.
                    }
                }
                return
            }
            if (record.type === 'done') {
                terminal = { result: decodeDone(value) }
                return
            }
            if (record.type === 'error') {
                terminal = { error: decodeStreamError(value) }
                return
            }
            throw internal()
        }

        try {
            while (true) {
                let chunk: ReadableStreamReadResult<Uint8Array>
                try {
                    chunk = await reader.read()
                } catch {
                    if (signal.aborted) throw aborted()
                    throw network()
                }
                if (chunk.done) break
                aggregateBytes += chunk.value.byteLength
                if (aggregateBytes > MAX_NDJSON_BYTES) throw internal()
                try {
                    buffered += decoder.decode(chunk.value, { stream: true })
                } catch {
                    throw internal()
                }
                let newline: number
                while ((newline = buffered.indexOf('\n')) >= 0) {
                    const line = buffered.slice(0, newline)
                    buffered = buffered.slice(newline + 1)
                    if (line.length === 0) throw internal()
                    consume(line.endsWith('\r') ? line.slice(0, -1) : line)
                }
                if (encoder.encode(buffered).byteLength > MAX_NDJSON_RECORD_BYTES) throw internal()
            }
            try {
                buffered += decoder.decode()
            } catch {
                throw internal()
            }
            if (buffered.length !== 0) throw network()
            if (!accepted || !terminal) throw network()
            if (terminal.error) throw terminal.error
            return terminal.result!
        } finally {
            reader.releaseLock()
        }
    }

    async cancel(): Promise<{ cancelled: boolean }> {
        const response = await checkedResponse(
            () => this.bridge.pluginModelCancel(this.principalId),
        )
        const data = exactDataObject(await decodeJsonResponse(response), ['cancelled'])
        if (typeof data.cancelled !== 'boolean') throw internal()
        return { cancelled: data.cancelled }
    }

    async remove(includePartial: boolean): Promise<{ purgedBytes: number; pending?: true }> {
        if (typeof includePartial !== 'boolean') throw internal()
        const response = await checkedResponse(
            () => this.bridge.pluginModelRemove(this.principalId, includePartial),
        )
        const value = await decodeJsonResponse(response)
        try {
            const immediate = exactDataObject(value, ['purgedBytes'])
            return { purgedBytes: safeBytes(immediate.purgedBytes) }
        } catch (error) {
            if (!(error instanceof PluginApiError) || error.code !== 'INTERNAL') throw error
        }
        const deferred = exactDataObject(value, ['purgedBytes', 'pending'])
        if (safeBytes(deferred.purgedBytes) !== 0 || deferred.pending !== true) throw internal()
        return { purgedBytes: 0, pending: true }
    }

    async inferenceCapabilities(): Promise<PocketInferenceCapabilities> {
        const response = await checkedResponse(
            () => this.bridge.pluginModelInferenceCapabilities(),
            undefined,
            true,
        )
        return decodeInferenceCapabilities(await decodeJsonResponse(response))
    }

    async acquire(
        provider: PocketLocalModelProvider,
        signal: AbortSignal,
    ): Promise<{ sessionId: string; provider: 'node' }> {
        const instanceId = this.inferenceInstance()
        if (!INFERENCE_PROVIDERS.has(provider)) throw internal()
        if (!(signal instanceof AbortSignal)) throw internal()
        if (signal.aborted) throw inferenceAborted()
        const response = await checkedResponse(
            () => this.bridge.pluginModelInferenceAcquire(
                this.principalId,
                instanceId,
                provider,
                signal,
            ),
            signal,
            true,
        )
        const data = exactDataObject(await decodeJsonResponse(response), ['sessionId', 'provider'])
        if (data.provider !== 'node') throw internal()
        return { sessionId: sessionId(data.sessionId), provider: 'node' }
    }

    async run(
        sessionIdValue: string,
        image: Uint8Array,
        mediaType: PocketLocalModelMediaType,
        optionsValue: PocketInferenceRunOptions,
        signal: AbortSignal,
    ): Promise<PocketInferenceResult> {
        const instanceId = this.inferenceInstance()
        const normalizedSessionId = sessionId(sessionIdValue)
        if (
            !(image instanceof Uint8Array)
            || Object.getPrototypeOf(image) !== Uint8Array.prototype
            || image.byteLength < 1
            || image.byteLength > MAX_IMAGE_BYTES
        ) throw internal()
        if (!INFERENCE_MEDIA_TYPES.has(mediaType)) throw internal()
        if (!(signal instanceof AbortSignal)) throw internal()
        const options = normalizeInferenceOptions(optionsValue)
        if (signal.aborted) throw inferenceAborted()
        const response = await checkedResponse(
            () => this.bridge.pluginModelInferenceRun(
                this.principalId,
                instanceId,
                normalizedSessionId,
                image,
                mediaType,
                options,
                signal,
            ),
            signal,
            true,
        )
        return decodeInferenceResult(await decodeJsonResponse(response))
    }

    async release(sessionIdValue: string): Promise<void> {
        const response = await checkedResponse(
            () => this.bridge.pluginModelInferenceRelease(
                this.principalId,
                this.inferenceInstance(),
                sessionId(sessionIdValue),
            ),
            undefined,
            true,
        )
        const data = exactDataObject(await decodeJsonResponse(response), ['released'])
        if (data.released !== true) throw internal()
    }
}

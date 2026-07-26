import { PluginApiError } from '../illustration/errors'

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

export interface PocketPluginModelBridge {
    pluginModelStatus(): Promise<Response>
    pluginModelDownload(principalId: string, signal: AbortSignal): Promise<Response>
    pluginModelCancel(principalId: string): Promise<Response>
    pluginModelRemove(principalId: string, includePartial: boolean): Promise<Response>
}

const PRINCIPAL_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
const MAX_JSON_BYTES = 64 * 1024
const MAX_NDJSON_RECORD_BYTES = 64 * 1024
const MAX_NDJSON_BYTES = 4 * 1024 * 1024
const MAX_NDJSON_RECORDS = 4096

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

async function responseError(response: Response): Promise<never> {
    if ([404, 405, 501].includes(response.status)) throw unsupported()
    if (response.status === 409) throw conflict()
    let body: unknown
    try {
        body = await decodeJsonResponse(response)
        const envelope = exactDataObject(body, ['error'])
        const error = exactDataObject(envelope.error, ['code', 'message'])
        if (typeof error.message !== 'string') throw internal()
        throw mapServerCode(error.code)
    } catch (error) {
        if (error instanceof PluginApiError) throw error
        throw internal()
    }
}

async function checkedResponse(call: () => Promise<Response>, signal?: AbortSignal): Promise<Response> {
    let response: Response
    try {
        response = await call()
    } catch {
        if (signal?.aborted) throw aborted()
        throw network()
    }
    if (!(response instanceof Response)) throw internal()
    if (!response.ok) await responseError(response)
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

    constructor(bridge: PocketPluginModelBridge, principalId: string) {
        if (!PRINCIPAL_PATTERN.test(principalId)) throw internal()
        this.bridge = bridge
        this.principalId = principalId.toLowerCase()
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

    async remove(includePartial: boolean): Promise<{ purgedBytes: number }> {
        if (typeof includePartial !== 'boolean') throw internal()
        const response = await checkedResponse(
            () => this.bridge.pluginModelRemove(this.principalId, includePartial),
        )
        const data = exactDataObject(await decodeJsonResponse(response), ['purgedBytes'])
        return { purgedBytes: safeBytes(data.purgedBytes) }
    }
}

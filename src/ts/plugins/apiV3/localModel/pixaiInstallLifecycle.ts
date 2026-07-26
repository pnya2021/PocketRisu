import {
    SecurityConfirmationQueue,
    securityConfirmationQueue,
} from '../../securityConfirmationQueue'
import type { PluginApiErrorShape } from '../illustration/contracts'
import { PluginApiError, serializePluginApiError } from '../illustration/errors'
import {
    pluginPermissionService,
    type PluginExecutionContext,
} from '../illustration/permissions'
import {
    PIXAI_PROFILE,
    type PixaiProfileId,
    type PocketModelProgress,
    type PocketModelStatus,
} from './pocketPluginModelClient'

export const TERMINAL_OPERATION_TTL_MS = 7 * 24 * 60 * 60 * 1_000
const MAX_TERMINAL_OPERATIONS_PER_PRINCIPAL = 100
const MAX_OPERATION_ID_LENGTH = 128
const OPERATION_ID_PATTERN = /^[A-Za-z0-9_-]+$/

export interface LocalModelStatus {
    state: 'absent' | 'partial' | 'downloading' | 'verifying' | 'ready' | 'corrupt' | 'evicted'
    revision?: string
    sha256?: string
    storedBytes?: number
    operationId?: string
}

export interface LocalModelProgress {
    phase: 'checking-capabilities' | 'awaiting-consent' | 'checking-quota'
        | 'downloading' | 'verifying' | 'committing' | 'ready'
    loadedBytes?: number
    totalBytes?: number
    bytesPerSecond?: number
    etaMs?: number
}

export interface LocalModelOperationSnapshot {
    state: 'queued' | 'running' | 'succeeded' | 'failed' | 'cancelled'
    progress?: LocalModelProgress
    error?: PluginApiErrorShape
}

export interface LocalModelRemoveResult {
    releasedPluginReference: boolean
    purgedBytes: number
    retainedForOtherOwners: boolean
    pending: boolean
}

export interface PixaiInstallLifecycleClient {
    status(): Promise<PocketModelStatus>
    download(
        signal: AbortSignal,
        onProgress?: (progress: PocketModelProgress) => unknown,
    ): Promise<{ state: 'verified'; bytes: number }>
    cancel(): Promise<{ cancelled: boolean }>
    remove(includePartial: boolean): Promise<{ purgedBytes: number }>
}

export interface PixaiInstallLifecycleOptions {
    clientForPrincipal: (principalId: string) => PixaiInstallLifecycleClient
    queue?: SecurityConfirmationQueue
    requirePermission?: (context: PluginExecutionContext) => Promise<void>
    now?: () => number
    createOperationId?: () => string
}

interface ProgressCallbackEntry {
    callback: (progress: LocalModelProgress) => unknown
    signal: AbortSignal
    onAbort: () => void
}

interface LocalModelOperation {
    readonly id: string
    readonly principalId: string
    readonly profile: PixaiProfileId
    readonly sequence: number
    readonly client: PixaiInstallLifecycleClient
    readonly controller: AbortController
    readonly callbacks: Map<string, ProgressCallbackEntry>
    state: LocalModelOperationSnapshot['state']
    progress?: LocalModelProgress
    error?: PluginApiErrorShape
    terminalAt?: number
    task?: Promise<void>
}

const allowedModelErrorCodes = new Set([
    'INVALID_ARGUMENT', 'UNSUPPORTED', 'PERMISSION_DENIED', 'NOT_FOUND',
    'QUOTA_EXCEEDED', 'NETWORK', 'INTEGRITY_MISMATCH', 'ABORTED',
    'CONFLICT', 'INTERNAL',
])

function invalid(message: string): never {
    throw new PluginApiError('INVALID_ARGUMENT', message)
}

function assertProfile(value: unknown): PixaiProfileId {
    if (value !== PIXAI_PROFILE.id) invalid('Unsupported local model profile')
    return value
}

function assertOperationId(value: unknown): string {
    if (
        typeof value !== 'string'
        || value.length === 0
        || value.length > MAX_OPERATION_ID_LENGTH
        || !OPERATION_ID_PATTERN.test(value)
    ) invalid('Invalid local model operation ID')
    return value
}

function assertProgressCallback(value: unknown) {
    if (value === undefined) return undefined
    if (typeof value !== 'function') invalid('Invalid local model progress callback')
    return value as (progress: LocalModelProgress) => unknown
}

function removalOptions(value: unknown): { scope: 'plugin' | 'device'; includePartial: boolean } {
    if (value === undefined) return { scope: 'plugin', includePartial: true }
    if (value === null || typeof value !== 'object' || Array.isArray(value)) {
        invalid('Invalid local model removal options')
    }
    let prototype: object | null
    let descriptors: PropertyDescriptorMap
    try {
        prototype = Object.getPrototypeOf(value)
        descriptors = Object.getOwnPropertyDescriptors(value)
    } catch {
        invalid('Invalid local model removal options')
    }
    if (
        (prototype !== Object.prototype && prototype !== null)
        || Object.getOwnPropertySymbols(value).length > 0
    ) invalid('Invalid local model removal options')
    for (const [key, descriptor] of Object.entries(descriptors)) {
        if (
            !descriptor.enumerable
            || !('value' in descriptor)
            || (key !== 'scope' && key !== 'includePartial')
        ) invalid('Invalid local model removal options')
    }
    const scope = descriptors.scope?.value ?? 'plugin'
    const includePartial = descriptors.includePartial?.value ?? true
    if (scope !== 'plugin' && scope !== 'device') invalid('Invalid local model removal scope')
    if (typeof includePartial !== 'boolean') invalid('Invalid includePartial option')
    return { scope, includePartial }
}

function cloneProgress(progress: LocalModelProgress): LocalModelProgress {
    return {
        phase: progress.phase,
        ...(progress.loadedBytes === undefined ? {} : { loadedBytes: progress.loadedBytes }),
        ...(progress.totalBytes === undefined ? {} : { totalBytes: progress.totalBytes }),
        ...(progress.bytesPerSecond === undefined ? {} : { bytesPerSecond: progress.bytesPerSecond }),
        ...(progress.etaMs === undefined ? {} : { etaMs: progress.etaMs }),
    }
}

function cloneError(error: PluginApiErrorShape): PluginApiErrorShape {
    return {
        name: 'PluginApiError',
        code: error.code,
        message: error.message,
        retryable: error.retryable,
        ...(error.retryAfterMs === undefined ? {} : { retryAfterMs: error.retryAfterMs }),
        ...(error.details === undefined ? {} : { details: { ...error.details } }),
    }
}

function normalizeError(error: unknown, abortedByHost = false): PluginApiErrorShape {
    if (abortedByHost || (error instanceof DOMException && error.name === 'AbortError')) {
        return serializePluginApiError(new PluginApiError('ABORTED', 'Local model operation cancelled'))
    }
    if (error instanceof PluginApiError) {
        const serialized = serializePluginApiError(error)
        if (allowedModelErrorCodes.has(serialized.code)) return serialized
    }
    return serializePluginApiError(new Error('redacted local model failure'))
}

function throwNormalized(error: unknown): never {
    const normalized = normalizeError(error)
    throw new PluginApiError(normalized.code, normalized.message, {
        retryable: normalized.retryable,
        retryAfterMs: normalized.retryAfterMs,
        details: normalized.details,
    })
}

function profileDigest(): string {
    return JSON.stringify([
        PIXAI_PROFILE.id,
        PIXAI_PROFILE.revision,
        PIXAI_PROFILE.totalBytes,
        ...PIXAI_PROFILE.artifacts.flatMap((artifact) => [
            artifact.name, artifact.bytes, artifact.sha256,
        ]),
    ])
}

function confirmationDescription(
    context: PluginExecutionContext,
    action: 'install' | 'remove',
): string {
    const identity = `${context.displayName} (${context.internalName ?? context.displayName})`
    const digests = PIXAI_PROFILE.artifacts
        .map((artifact) => `${artifact.name}: ${artifact.sha256}`)
        .join('; ')
    const verb = action === 'install' ? 'install' : 'remove from this device'
    return `${identity} requests to ${verb} ${PIXAI_PROFILE.id}. `
        + `Source: ${PIXAI_PROFILE.sourceUrl}. License: ${PIXAI_PROFILE.license} (${PIXAI_PROFILE.licenseUrl}). `
        + `Immutable revision: ${PIXAI_PROFILE.revision}. Total manifest bytes: ${PIXAI_PROFILE.totalBytes}. `
        + `SHA-256 digests: ${digests}. `
        + 'This uses device-local persistent storage and local compute. '
        + 'Local images stay on this device and are processed locally.'
}

function statusFromHost(status: PocketModelStatus): LocalModelStatus {
    if (status.active) {
        return {
            state: status.active.phase === 'downloading' ? 'downloading' : 'verifying',
            revision: PIXAI_PROFILE.revision,
            sha256: PIXAI_PROFILE.artifacts[0].sha256,
            storedBytes: status.active.loadedBytes,
        }
    }
    if (status.state === 'verified') {
        return {
            state: 'ready', revision: PIXAI_PROFILE.revision,
            sha256: PIXAI_PROFILE.artifacts[0].sha256,
            storedBytes: status.storedBytes,
        }
    }
    if (status.state === 'partial') {
        return {
            state: 'partial', revision: PIXAI_PROFILE.revision,
            sha256: PIXAI_PROFILE.artifacts[0].sha256,
            storedBytes: status.storedBytes,
        }
    }
    return { state: 'absent' }
}

export class PixaiInstallLifecycle {
    private readonly clientForPrincipal: (principalId: string) => PixaiInstallLifecycleClient
    private readonly queue: SecurityConfirmationQueue
    private readonly requirePermission: (context: PluginExecutionContext) => Promise<void>
    private readonly now: () => number
    private readonly createOperationId: () => string
    private readonly operations = new Map<string, LocalModelOperation>()
    private readonly active = new Map<string, LocalModelOperation>()
    private readonly owners = new Set<string>()
    private nextSequence = 0
    private lifecycleMutationTail: Promise<void> = Promise.resolve()

    constructor(options: PixaiInstallLifecycleOptions) {
        this.clientForPrincipal = options.clientForPrincipal
        this.queue = options.queue ?? securityConfirmationQueue
        this.requirePermission = options.requirePermission
            ?? ((context) => pluginPermissionService.require(context, 'localModelInference'))
        this.now = options.now ?? Date.now
        this.createOperationId = options.createOperationId
            ?? (() => `lmo_${crypto.randomUUID().replaceAll('-', '')}`)
    }

    async getLocalModelStatus(
        context: PluginExecutionContext,
        profileValue: unknown,
    ): Promise<LocalModelStatus> {
        assertProfile(profileValue)
        const current = this.active.get(this.activeKey(context.principalId))
        if (current) {
            const progress = current.progress
            return {
                state: progress?.phase === 'verifying' || progress?.phase === 'committing'
                    ? 'verifying' : 'downloading',
                revision: PIXAI_PROFILE.revision,
                sha256: PIXAI_PROFILE.artifacts[0].sha256,
                ...(progress?.loadedBytes === undefined ? {} : { storedBytes: progress.loadedBytes }),
                operationId: current.id,
            }
        }
        let status: PocketModelStatus
        try {
            status = await this.clientForPrincipal(context.principalId).status()
        } catch (error) {
            throwNormalized(error)
        }
        const mapped = statusFromHost(status)
        if (mapped.state === 'absent' && this.owners.has(context.principalId)) {
            return {
                state: 'evicted', revision: PIXAI_PROFILE.revision,
                sha256: PIXAI_PROFILE.artifacts[0].sha256, storedBytes: 0,
            }
        }
        return mapped
    }

    async installLocalModel(
        context: PluginExecutionContext,
        profileValue: unknown,
        progressValue?: unknown,
    ): Promise<{ operationId: string }> {
        const profile = assertProfile(profileValue)
        const callback = assertProgressCallback(progressValue)
        await this.requirePermission(context)
        if (context.signal.aborted) throw new PluginApiError('ABORTED', 'Plugin instance unloaded')

        const key = this.activeKey(context.principalId)
        const existing = this.active.get(key)
        if (existing) {
            this.attachCallback(existing, context, callback)
            return { operationId: existing.id }
        }

        const approved = await this.queue.request({
            kind: 'model-install',
            principalId: context.principalId,
            instanceId: context.instanceId,
            action: `install:${profile}`,
            profileDigest: profileDigest(),
            copyVersion: 1,
            displayName: context.displayName,
            internalName: context.internalName ?? context.displayName,
            title: 'Install local model',
            description: confirmationDescription(context, 'install'),
            allowLabel: 'Install',
            denyLabel: 'Cancel',
        }, context.signal)
        if (!approved) {
            if (context.signal.aborted) throw new PluginApiError('ABORTED', 'Plugin instance unloaded')
            throw new PluginApiError('PERMISSION_DENIED', 'Local model installation was denied')
        }
        if (context.signal.aborted) throw new PluginApiError('ABORTED', 'Plugin instance unloaded')

        return this.withLifecycleMutation(() => {
            if (context.signal.aborted) throw new PluginApiError('ABORTED', 'Plugin instance unloaded')
            const coalesced = this.active.get(key)
            if (coalesced) {
                this.attachCallback(coalesced, context, callback)
                return { operationId: coalesced.id }
            }
            const id = assertOperationId(this.createOperationId())
            if (this.operations.has(id)) {
                throw new PluginApiError('INTERNAL', 'Local model operation ID collision')
            }
            const operation: LocalModelOperation = {
                id,
                principalId: context.principalId,
                profile,
                sequence: ++this.nextSequence,
                client: this.clientForPrincipal(context.principalId),
                controller: new AbortController(),
                callbacks: new Map(),
                state: 'queued',
                progress: { phase: 'checking-quota', totalBytes: PIXAI_PROFILE.totalBytes },
            }
            this.operations.set(id, operation)
            this.active.set(key, operation)
            this.attachCallback(operation, context, callback)
            queueMicrotask(() => { operation.task = this.runOperation(operation) })
            return { operationId: id }
        })
    }

    async getLocalModelOperation(
        context: PluginExecutionContext,
        operationIdValue: unknown,
    ): Promise<LocalModelOperationSnapshot> {
        const operation = this.ownedOperation(context, operationIdValue)
        return {
            state: operation.state,
            ...(operation.progress ? { progress: cloneProgress(operation.progress) } : {}),
            ...(operation.error ? { error: cloneError(operation.error) } : {}),
        }
    }

    async cancelLocalModelOperation(
        context: PluginExecutionContext,
        operationIdValue: unknown,
    ): Promise<void> {
        const operation = this.ownedOperation(context, operationIdValue)
        if (operation.state !== 'queued' && operation.state !== 'running') {
            throw new PluginApiError('CONFLICT', 'Local model operation is already terminal')
        }
        let cancellationError: unknown
        try {
            await operation.client.cancel()
        } catch (error) {
            cancellationError = error
        } finally {
            operation.controller.abort(new PluginApiError('ABORTED', 'Local model operation cancelled'))
            while (!operation.task) await Promise.resolve()
            await operation.task
        }
        if (cancellationError) throwNormalized(cancellationError)
    }

    async removeLocalModel(
        context: PluginExecutionContext,
        profileValue: unknown,
        optionsValue?: unknown,
    ): Promise<LocalModelRemoveResult> {
        assertProfile(profileValue)
        const options = removalOptions(optionsValue)
        await this.requirePermission(context)
        if (context.signal.aborted) throw new PluginApiError('ABORTED', 'Plugin instance unloaded')
        if (this.active.size > 0) {
            throw new PluginApiError('CONFLICT', 'A local model installation is active')
        }
        if (options.scope === 'device') {
            const approved = await this.queue.request({
                kind: 'model-remove',
                principalId: context.principalId,
                instanceId: context.instanceId,
                action: `remove:${PIXAI_PROFILE.id}:device`,
                profileDigest: profileDigest(),
                copyVersion: 1,
                displayName: context.displayName,
                internalName: context.internalName ?? context.displayName,
                title: 'Remove local model',
                description: confirmationDescription(context, 'remove'),
                allowLabel: 'Remove',
                denyLabel: 'Cancel',
            }, context.signal)
            if (!approved) {
                if (context.signal.aborted) throw new PluginApiError('ABORTED', 'Plugin instance unloaded')
                throw new PluginApiError('PERMISSION_DENIED', 'Device model removal was denied')
            }
        }

        return this.withLifecycleMutation(async () => {
            if (context.signal.aborted) throw new PluginApiError('ABORTED', 'Plugin instance unloaded')
            if (this.active.size > 0) {
                throw new PluginApiError('CONFLICT', 'A local model installation is active')
            }
            const releasedPluginReference = this.owners.delete(context.principalId)
            if (options.scope === 'plugin' && this.owners.size > 0) {
                return {
                    releasedPluginReference,
                    purgedBytes: 0,
                    retainedForOtherOwners: true,
                    pending: false,
                }
            }
            if (options.scope === 'device') this.owners.clear()
            let result: { purgedBytes: number }
            try {
                result = await this.clientForPrincipal(context.principalId).remove(options.includePartial)
            } catch (error) {
                throwNormalized(error)
            }
            return {
                releasedPluginReference,
                purgedBytes: result.purgedBytes,
                retainedForOtherOwners: false,
                pending: false,
            }
        })
    }

    private activeKey(principalId: string): string {
        return `${principalId}\u0000${PIXAI_PROFILE.id}`
    }

    private async withLifecycleMutation<T>(mutation: () => T | Promise<T>): Promise<T> {
        let release!: () => void
        const previous = this.lifecycleMutationTail
        this.lifecycleMutationTail = new Promise<void>((resolve) => { release = resolve })
        await previous
        try {
            return await mutation()
        } finally {
            release()
        }
    }

    private attachCallback(
        operation: LocalModelOperation,
        context: PluginExecutionContext,
        callback?: (progress: LocalModelProgress) => unknown,
    ): void {
        if (!callback || context.signal.aborted) return
        const prior = operation.callbacks.get(context.instanceId)
        if (prior) prior.signal.removeEventListener('abort', prior.onAbort)
        const onAbort = () => {
            const current = operation.callbacks.get(context.instanceId)
            if (current?.onAbort === onAbort) operation.callbacks.delete(context.instanceId)
        }
        operation.callbacks.set(context.instanceId, {
            callback, signal: context.signal, onAbort,
        })
        context.signal.addEventListener('abort', onAbort, { once: true })
    }

    private publish(operation: LocalModelOperation, progress: LocalModelProgress): void {
        operation.progress = cloneProgress(progress)
        for (const [instanceId, entry] of operation.callbacks) {
            if (entry.signal.aborted) {
                operation.callbacks.delete(instanceId)
                continue
            }
            try {
                void Promise.resolve(entry.callback(cloneProgress(progress))).catch(() => undefined)
            } catch {
                // Progress callbacks are advisory.
            }
        }
    }

    private publishHostProgress(operation: LocalModelOperation, progress: PocketModelProgress): void {
        if (
            progress.profileId !== PIXAI_PROFILE.id
            || !Number.isSafeInteger(progress.loadedBytes)
            || progress.loadedBytes < 0
            || progress.loadedBytes > PIXAI_PROFILE.totalBytes
            || progress.totalBytes !== PIXAI_PROFILE.totalBytes
            || !['downloading', 'verifying', 'committing'].includes(progress.phase)
        ) throw new PluginApiError('INTERNAL', 'Internal plugin API error')
        this.publish(operation, {
            phase: progress.phase,
            loadedBytes: progress.loadedBytes,
            totalBytes: PIXAI_PROFILE.totalBytes,
        })
    }

    private async runOperation(operation: LocalModelOperation): Promise<void> {
        operation.state = 'running'
        try {
            const result = await operation.client.download(
                operation.controller.signal,
                (progress) => this.publishHostProgress(operation, progress),
            )
            if (result.state !== 'verified' || result.bytes !== PIXAI_PROFILE.totalBytes) {
                throw new PluginApiError('INTERNAL', 'Internal plugin API error')
            }
            this.owners.add(operation.principalId)
            operation.state = 'succeeded'
            this.publish(operation, {
                phase: 'ready',
                loadedBytes: PIXAI_PROFILE.totalBytes,
                totalBytes: PIXAI_PROFILE.totalBytes,
            })
        } catch (error) {
            operation.error = normalizeError(error, operation.controller.signal.aborted)
            operation.state = operation.error.code === 'ABORTED' ? 'cancelled' : 'failed'
        } finally {
            operation.terminalAt = this.now()
            const key = this.activeKey(operation.principalId)
            if (this.active.get(key) === operation) this.active.delete(key)
            for (const entry of operation.callbacks.values()) {
                entry.signal.removeEventListener('abort', entry.onAbort)
            }
            operation.callbacks.clear()
            this.prune(operation.principalId)
        }
    }

    private ownedOperation(
        context: PluginExecutionContext,
        operationIdValue: unknown,
    ): LocalModelOperation {
        const operationId = assertOperationId(operationIdValue)
        this.prune(context.principalId)
        const operation = this.operations.get(operationId)
        if (!operation || operation.principalId !== context.principalId) {
            throw new PluginApiError('NOT_FOUND', 'Local model operation not found')
        }
        return operation
    }

    private prune(principalId: string): void {
        const now = this.now()
        const terminal = [...this.operations.values()]
            .filter((operation) => operation.principalId === principalId && operation.terminalAt !== undefined)
            .sort((left, right) => left.terminalAt! - right.terminalAt! || left.sequence - right.sequence)
        for (const operation of terminal) {
            if (now - operation.terminalAt! > TERMINAL_OPERATION_TTL_MS) {
                this.operations.delete(operation.id)
            }
        }
        const retained = terminal.filter((operation) => this.operations.has(operation.id))
        const excess = retained.length - MAX_TERMINAL_OPERATIONS_PER_PRINCIPAL
        for (let index = 0; index < excess; index += 1) {
            this.operations.delete(retained[index].id)
        }
    }
}

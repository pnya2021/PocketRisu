import type { PluginExecutionContext } from './permissions'
import { PluginApiError } from './errors'
import { canonicalArgumentsDigest, IdempotencyLedger } from './idempotency'
import { assertLimit, assertUtf8Limit, utf8ByteLength } from './limits'

export const INLAY_LIFECYCLE_CAPABILITY_IDS = [
    'inlay.create.v1',
    'inlay.read.v1',
    'inlay.delete-own.v1',
] as const

const CREATE_OPERATION = INLAY_LIFECYCLE_CAPABILITY_IDS[0]
const ATOMIC_ATTACH_OPERATION = 'inlay.atomic-attach.v1' as const
const MAX_INPUT_BYTES = 33_554_432
const MAX_OUTPUT_BYTES = 33_554_432
const MAX_NAME_BYTES = 255
const READS_PER_MINUTE = 60
const REVISION_PATTERN = /^sha256:[0-9a-f]{64}$/u

export interface InlayCreateOptions {
    name?: string
    idempotencyKey: string
    context: { kind: 'character'; characterId: string }
    return: 'descriptor'
}

export interface InlayDescriptor {
    id: string
    revision: string
    name: string
}

export interface OwnedInlayRead extends InlayDescriptor {
    mediaType: string
    data: Uint8Array
}

export interface InlayReadOptions {
    ifRevision: string
    maxBytes: number
}

interface InlayLifecycleMetadataBase {
    version: 1
    ownerPrincipalId: string
    idempotencyKey: string
    argumentDigest: string
    revision: string
}

export interface InlayCreateLifecycleMetadata extends InlayLifecycleMetadataBase {
    operation: typeof CREATE_OPERATION
    context: { kind: 'character'; characterId: string }
}

export interface InlayAtomicLifecycleMetadata extends InlayLifecycleMetadataBase {
    operation: typeof ATOMIC_ATTACH_OPERATION
    context: {
        kind: 'message'
        characterId: string
        conversationId: string
        messageId: string
    }
    inputRevision: string
}

export type InlayLifecycleMetadata = InlayCreateLifecycleMetadata | InlayAtomicLifecycleMetadata

export interface AtomicInlayStageRequest {
    name: string
    idempotencyKey: string
    argumentDigest: string
    target: { characterId: string; conversationId: string; messageId: string }
    inputRevision: string
    beforeMutation(): void | Promise<void>
}

export interface InlayLifecycleRecord extends InlayDescriptor {
    lifecycle?: InlayLifecycleMetadata
}

export interface InlayReadableRecord extends InlayLifecycleRecord {
    blob: Blob
    mediaType: string
}

export interface InlayLifecycleAdapter {
    getCurrentCharacterId(): string | null
    getInlay(id: string): Promise<InlayLifecycleRecord | null>
    getReadableInlay?(id: string): Promise<InlayReadableRecord | null>
    readInlayBytes?(record: InlayReadableRecord, maxBytes: number): Promise<Uint8Array>
    writeImage(data: Uint8Array, request: {
        id: string
        name: string
        lifecycle: InlayLifecycleMetadata
        beforeMutation(): void | Promise<void>
    }): Promise<void>
    hasReference(id: string): Promise<boolean>
    removeInlay(id: string): Promise<boolean>
}

export interface InlayPermissionService {
    require(context: PluginExecutionContext, permission: 'inlayWrite', options?: unknown): Promise<void>
}

const invalidArgument = (message: string): never => {
    throw new PluginApiError('INVALID_ARGUMENT', message)
}

const plainDataObject = (value: unknown, allowedKeys: readonly string[], label: string): Record<string, unknown> => {
    try {
        if (!value || typeof value !== 'object' || Array.isArray(value)) invalidArgument(`Invalid ${label}`)
        const object = value as object
        const prototype = Object.getPrototypeOf(object)
        if (prototype !== Object.prototype && prototype !== null) invalidArgument(`Invalid ${label}`)
        const keys = Reflect.ownKeys(object)
        if (keys.some((key) => typeof key !== 'string' || !allowedKeys.includes(key))) invalidArgument(`Invalid ${label}`)
        for (const key of keys) {
            const descriptor = Object.getOwnPropertyDescriptor(value, key)
            if (!descriptor?.enumerable || !Object.hasOwn(descriptor, 'value')) invalidArgument(`Invalid ${label}`)
        }
        return value as Record<string, unknown>
    } catch (error) {
        if (error instanceof PluginApiError) throw error
        return invalidArgument(`Invalid ${label}`)
    }
}

const nonEmptyString = (value: unknown): value is string => typeof value === 'string' && value.length > 0

const requiredString = (value: unknown, message: string) => {
    if (!nonEmptyString(value)) invalidArgument(message)
    return value as string
}

function normalizeCreateOptions(value: unknown): InlayCreateOptions {
    const options = plainDataObject(value, ['name', 'idempotencyKey', 'context', 'return'], 'createInlay options')
    const idempotencyKey = requiredString(options.idempotencyKey, 'idempotencyKey is required')
    assertUtf8Limit(idempotencyKey, 256, 'idempotencyKey')
    const name = options.name === undefined ? undefined : requiredString(options.name, 'Inlay name must be non-empty')
    if (name !== undefined) assertUtf8Limit(name, MAX_NAME_BYTES, 'name')
    if (options.return !== 'descriptor') invalidArgument('createInlay return must be descriptor')
    const context = plainDataObject(options.context, ['kind', 'characterId'], 'Inlay context')
    if (context.kind !== 'character') invalidArgument('Invalid character context')
    const characterId = requiredString(context.characterId, 'Invalid character context')
    return {
        ...(name === undefined ? {} : { name }),
        idempotencyKey,
        return: 'descriptor',
        context: { kind: 'character', characterId },
    }
}

const hex = (bytes: ArrayBuffer) => [...new Uint8Array(bytes)]
    .map((value) => value.toString(16).padStart(2, '0')).join('')

const sha256 = async (data: Uint8Array) => hex(await crypto.subtle.digest('SHA-256', Uint8Array.from(data).buffer))

const deterministicInlayId = async (principalId: string, operation: string, idempotencyKey: string) => {
    const encoded = new TextEncoder().encode(JSON.stringify([principalId, operation, idempotencyKey]))
    return `inlay_${await sha256(encoded)}`
}

function normalizeReadOptions(value: unknown): InlayReadOptions {
    const options = plainDataObject(value, ['ifRevision', 'maxBytes'], 'readOwnedInlay options')
    if (!REVISION_PATTERN.test(typeof options.ifRevision === 'string' ? options.ifRevision : '')) {
        invalidArgument('ifRevision must be a lowercase SHA-256 revision')
    }
    if (!Number.isSafeInteger(options.maxBytes) || (options.maxBytes as number) <= 0) {
        invalidArgument('maxBytes must be a positive safe integer')
    }
    if ((options.maxBytes as number) > MAX_OUTPUT_BYTES) {
        throw new PluginApiError('RESOURCE_LIMIT', 'maxBytes exceeds the owned Inlay read limit')
    }
    return {
        ifRevision: options.ifRevision as string,
        maxBytes: options.maxBytes as number,
    }
}

export const deterministicAtomicInlayId = (principalId: string, idempotencyKey: string) =>
    deterministicInlayId(principalId, ATOMIC_ATTACH_OPERATION, idempotencyKey)

const validMetadata = (value: unknown): value is InlayLifecycleMetadata => {
    if (!value || typeof value !== 'object') return false
    const metadata = value as Partial<InlayLifecycleMetadata>
    const common = metadata.version === 1
        && nonEmptyString(metadata.ownerPrincipalId)
        && (metadata.operation === CREATE_OPERATION || metadata.operation === ATOMIC_ATTACH_OPERATION)
        && nonEmptyString(metadata.idempotencyKey)
        && utf8ByteLength(metadata.idempotencyKey) <= 256
        && typeof metadata.argumentDigest === 'string'
        && /^[0-9a-f]{64}$/.test(metadata.argumentDigest)
        && typeof metadata.revision === 'string'
        && /^sha256:[0-9a-f]{64}$/.test(metadata.revision)
    if (!common || !metadata.context || !nonEmptyString(metadata.context.characterId)) return false
    if (metadata.operation === CREATE_OPERATION) return metadata.context.kind === 'character'
    return metadata.context.kind === 'message'
        && nonEmptyString(metadata.context.conversationId)
        && nonEmptyString(metadata.context.messageId)
        && nonEmptyString(metadata.inputRevision)
}

const exactStoredDataObject = (value: unknown, keys: readonly string[]) => {
    try {
        if (!value || typeof value !== 'object' || Array.isArray(value)) return false
        const prototype = Object.getPrototypeOf(value)
        if (prototype !== Object.prototype && prototype !== null) return false
        const ownKeys = Reflect.ownKeys(value)
        if (ownKeys.length !== keys.length
            || ownKeys.some((key) => typeof key !== 'string' || !keys.includes(key))) return false
        return ownKeys.every((key) => {
            const descriptor = Object.getOwnPropertyDescriptor(value, key)
            return descriptor?.enumerable === true && Object.hasOwn(descriptor, 'value')
        })
    } catch {
        return false
    }
}

const completeReadMetadata = (value: unknown): value is InlayLifecycleMetadata => {
    if (!validMetadata(value)) return false
    const metadataKeys = value.operation === CREATE_OPERATION
        ? ['version', 'ownerPrincipalId', 'operation', 'idempotencyKey', 'argumentDigest', 'revision', 'context']
        : ['version', 'ownerPrincipalId', 'operation', 'idempotencyKey', 'argumentDigest', 'revision', 'context', 'inputRevision']
    if (!exactStoredDataObject(value, metadataKeys)) return false
    if (value.operation === CREATE_OPERATION) {
        return exactStoredDataObject(value.context, ['kind', 'characterId'])
    }
    return exactStoredDataObject(value.context, ['kind', 'characterId', 'conversationId', 'messageId'])
        && REVISION_PATTERN.test(value.inputRevision)
}

const normalizeImageMediaType = (value: unknown) => {
    if (typeof value !== 'string') return null
    const mediaType = value.split(';', 1)[0]?.trim().toLowerCase()
    if (!mediaType || !/^image\/[a-z0-9][a-z0-9.+-]*$/u.test(mediaType)) return null
    return mediaType === 'image/jpg' ? 'image/jpeg' : mediaType
}

interface OwnedReadEvidence {
    id: string
    name: string
    revision: string
    mediaType: string
    blobSize: number
    blobType: string
    lifecycleIdentity: string
}

export class InlayReadRateLimiter {
    private readonly reads = new Map<string, number[]>()

    constructor(private readonly now: () => number = Date.now) {}

    consume(principalId: string) {
        const now = this.now()
        const retained = (this.reads.get(principalId) ?? []).filter((value) => value > now - 60_000)
        if (retained.length >= READS_PER_MINUTE) {
            this.reads.set(principalId, retained)
            throw new PluginApiError('RESOURCE_LIMIT', 'Owned Inlay read rate exceeded', {
                retryable: true,
                retryAfterMs: Math.max(1, retained[0] + 60_000 - now),
            })
        }
        retained.push(now)
        this.reads.set(principalId, retained)
    }
}

const sharedReadRateLimiter = new InlayReadRateLimiter()

export class InlayLifecycleService {
    private readonly ledger: IdempotencyLedger
    private readonly readRateLimiter: InlayReadRateLimiter

    constructor(
        private readonly context: PluginExecutionContext,
        private readonly adapter: InlayLifecycleAdapter,
        private readonly permissions: InlayPermissionService,
        options: { ledger?: IdempotencyLedger; readRateLimiter?: InlayReadRateLimiter } = {},
    ) {
        this.ledger = options.ledger ?? new IdempotencyLedger()
        this.readRateLimiter = options.readRateLimiter ?? sharedReadRateLimiter
    }

    private requirePermission() {
        return this.permissions.require(this.context, 'inlayWrite')
    }

    private ensureActive() {
        if (this.context.signal.aborted) throw new PluginApiError('ABORTED', 'Operation aborted')
    }

    private async readableRecord(id: string, afterRead = false) {
        if (!this.adapter.getReadableInlay) {
            throw new PluginApiError('INTERNAL', 'Owned Inlay reads are unavailable', { retryable: true })
        }
        try {
            const record = await this.adapter.getReadableInlay(id)
            this.ensureActive()
            return record
        } catch (error) {
            this.ensureActive()
            if (afterRead && error instanceof PluginApiError && error.code === 'PERMISSION_DENIED') {
                throw new PluginApiError('CONFLICT', 'Owned Inlay changed while it was being read', { retryable: true })
            }
            if (error instanceof PluginApiError) throw error
            throw new PluginApiError('INTERNAL', 'Unable to read owned Inlay storage', { retryable: true })
        }
    }

    private async ownedReadEvidence(record: InlayReadableRecord, id: string, afterRead = false) {
        const invalid = (): never => {
            if (afterRead) {
                throw new PluginApiError('CONFLICT', 'Owned Inlay changed while it was being read', { retryable: true })
            }
            throw new PluginApiError('PERMISSION_DENIED', 'Inlay is not owned by the current plugin')
        }
        try {
            if (!record || typeof record !== 'object') return invalid()
            const lifecycle = record.lifecycle
            if (!completeReadMetadata(lifecycle)
                || lifecycle.ownerPrincipalId !== this.context.principalId
                || record.id !== id
                || !nonEmptyString(record.name)
                || utf8ByteLength(record.name) > MAX_NAME_BYTES
                || !REVISION_PATTERN.test(record.revision)
                || record.revision !== lifecycle.revision
                || !(record.blob instanceof Blob)
                || !Number.isSafeInteger(record.blob.size)
                || record.blob.size < 0) return invalid()
            const mediaType = normalizeImageMediaType(record.blob.type)
            if (!mediaType || record.mediaType !== mediaType) return invalid()
            const deterministicId = await deterministicInlayId(
                lifecycle.ownerPrincipalId,
                lifecycle.operation,
                lifecycle.idempotencyKey,
            )
            this.ensureActive()
            if (deterministicId !== id) return invalid()
            return {
                id,
                name: record.name,
                revision: record.revision,
                mediaType,
                blobSize: record.blob.size,
                blobType: record.blob.type,
                lifecycleIdentity: JSON.stringify(lifecycle),
            } satisfies OwnedReadEvidence
        } catch (error) {
            if (error instanceof PluginApiError) throw error
            return invalid()
        }
    }

    private sameReadEvidence(before: OwnedReadEvidence, after: OwnedReadEvidence) {
        return before.id === after.id
            && before.name === after.name
            && before.revision === after.revision
            && before.mediaType === after.mediaType
            && before.blobSize === after.blobSize
            && before.blobType === after.blobType
            && before.lifecycleIdentity === after.lifecycleIdentity
    }

    async createInlay(data: Uint8Array, rawOptions: InlayCreateOptions): Promise<InlayDescriptor> {
        await this.requirePermission()
        if (!(data instanceof Uint8Array) || Object.getPrototypeOf(data) !== Uint8Array.prototype) {
            invalidArgument('createInlay data must be a Uint8Array')
        }
        const bytes = Uint8Array.from(data)
        assertLimit(bytes.byteLength, MAX_INPUT_BYTES, 'data')
        const options = normalizeCreateOptions(rawOptions)
        const id = await deterministicInlayId(this.context.principalId, CREATE_OPERATION, options.idempotencyKey)
        const name = options.name ?? `${id}.png`
        const canonicalArgs = { data: bytes, name, context: options.context, return: options.return }

        return this.ledger.run(
            this.context.principalId,
            CREATE_OPERATION,
            options.idempotencyKey,
            canonicalArgs,
            async () => {
                const [argumentDigest, contentDigest] = await Promise.all([
                    canonicalArgumentsDigest(canonicalArgs),
                    sha256(bytes),
                ])
                const revision = `sha256:${contentDigest}`
                const descriptor = { id, revision, name }
                const existing = await this.adapter.getInlay(id)
                if (existing) {
                    const metadata = existing.lifecycle
                    if (!validMetadata(metadata)
                        || metadata.operation !== CREATE_OPERATION
                        || metadata.ownerPrincipalId !== this.context.principalId
                        || metadata.idempotencyKey !== options.idempotencyKey
                        || metadata.argumentDigest !== argumentDigest
                        || metadata.revision !== revision
                        || metadata.context.characterId !== options.context.characterId
                        || existing.id !== id
                        || existing.revision !== revision
                        || existing.name !== name) {
                        throw new PluginApiError('CONFLICT', 'Stored Inlay conflicts with the idempotent create request')
                    }
                    return descriptor
                }

                const lifecycle: InlayLifecycleMetadata = {
                    version: 1,
                    ownerPrincipalId: this.context.principalId,
                    operation: CREATE_OPERATION,
                    idempotencyKey: options.idempotencyKey,
                    argumentDigest,
                    revision,
                    context: { ...options.context },
                }
                await this.adapter.writeImage(bytes.slice(), {
                    id,
                    name,
                    lifecycle,
                    beforeMutation: async () => {
                        if (this.adapter.getCurrentCharacterId() !== options.context.characterId) {
                            throw new PluginApiError('PERMISSION_DENIED', 'Character context is no longer current')
                        }
                    },
                })
                const stored = await this.adapter.getInlay(id)
                if (!stored || !validMetadata(stored.lifecycle)
                    || stored.lifecycle.ownerPrincipalId !== this.context.principalId
                    || stored.lifecycle.idempotencyKey !== options.idempotencyKey
                    || stored.lifecycle.argumentDigest !== argumentDigest
                    || stored.lifecycle.revision !== revision
                    || stored.lifecycle.context.characterId !== options.context.characterId
                    || stored.id !== id
                    || stored.name !== name
                    || stored.revision !== revision) {
                    throw new PluginApiError('INTERNAL', 'Inlay storage did not confirm the lifecycle record', { retryable: true })
                }
                return descriptor
            },
            { durable: true },
        )
    }

    async readOwnedInlay(id: string, rawOptions: InlayReadOptions): Promise<OwnedInlayRead | null> {
        await this.requirePermission()
        this.ensureActive()
        if (!nonEmptyString(id)) invalidArgument('Inlay id must be non-empty')
        const options = normalizeReadOptions(rawOptions)
        this.readRateLimiter.consume(this.context.principalId)

        const beforeRecord = await this.readableRecord(id)
        if (!beforeRecord) return null
        const before = await this.ownedReadEvidence(beforeRecord, id)
        this.ensureActive()
        if (before.revision !== options.ifRevision) {
            throw new PluginApiError('CONFLICT', 'Owned Inlay revision changed', { retryable: true })
        }
        if (before.blobSize > MAX_OUTPUT_BYTES || before.blobSize > options.maxBytes) {
            throw new PluginApiError('RESOURCE_LIMIT', 'Owned Inlay exceeds maxBytes')
        }

        let adapterBytes: Uint8Array
        if (!this.adapter.readInlayBytes) {
            throw new PluginApiError('INTERNAL', 'Owned Inlay reads are unavailable', { retryable: true })
        }
        try {
            adapterBytes = await this.adapter.readInlayBytes(beforeRecord, options.maxBytes)
            this.ensureActive()
        } catch (error) {
            this.ensureActive()
            if (error instanceof PluginApiError) throw error
            throw new PluginApiError('INTERNAL', 'Unable to read owned Inlay bytes', { retryable: true })
        }
        if (!(adapterBytes instanceof Uint8Array)) {
            throw new PluginApiError('INTERNAL', 'Owned Inlay backend returned invalid bytes', { retryable: true })
        }
        const bytes = Uint8Array.from(adapterBytes)
        if (bytes.byteLength > MAX_OUTPUT_BYTES || bytes.byteLength > options.maxBytes) {
            throw new PluginApiError('RESOURCE_LIMIT', 'Owned Inlay exceeds maxBytes')
        }
        if (bytes.byteLength !== before.blobSize) {
            throw new PluginApiError('CONFLICT', 'Owned Inlay changed while it was being read', { retryable: true })
        }
        const afterRecord = await this.readableRecord(id, true)
        if (!afterRecord) {
            throw new PluginApiError('CONFLICT', 'Owned Inlay changed while it was being read', { retryable: true })
        }
        const after = await this.ownedReadEvidence(afterRecord, id, true)
        this.ensureActive()
        if (!this.sameReadEvidence(before, after)) {
            throw new PluginApiError('CONFLICT', 'Owned Inlay changed while it was being read', { retryable: true })
        }
        this.ensureActive()
        return {
            id: before.id,
            revision: before.revision,
            name: before.name,
            mediaType: before.mediaType,
            data: bytes.slice(),
        }
    }

    /** Internal atomic-attach staging; its caller has already authorized inlayWrite. */
    async stageAtomicInlay(data: Uint8Array, request: AtomicInlayStageRequest): Promise<InlayDescriptor> {
        if (!(data instanceof Uint8Array) || Object.getPrototypeOf(data) !== Uint8Array.prototype) {
            invalidArgument('Atomic Inlay data must be a Uint8Array')
        }
        const bytes = Uint8Array.from(data)
        assertLimit(bytes.byteLength, MAX_INPUT_BYTES, 'data')
        const name = requiredString(request.name, 'Inlay name must be non-empty')
        assertUtf8Limit(name, MAX_NAME_BYTES, 'name')
        const idempotencyKey = requiredString(request.idempotencyKey, 'idempotencyKey is required')
        assertUtf8Limit(idempotencyKey, 256, 'idempotencyKey')
        if (!/^[0-9a-f]{64}$/u.test(request.argumentDigest)) invalidArgument('Invalid atomic argument digest')
        const characterId = requiredString(request.target?.characterId, 'Invalid atomic message target')
        const conversationId = requiredString(request.target?.conversationId, 'Invalid atomic message target')
        const messageId = requiredString(request.target?.messageId, 'Invalid atomic message target')
        const inputRevision = requiredString(request.inputRevision, 'Invalid atomic input revision')
        if (typeof request.beforeMutation !== 'function') invalidArgument('Invalid atomic mutation guard')
        const target = { characterId, conversationId, messageId }
        const id = await deterministicAtomicInlayId(this.context.principalId, idempotencyKey)
        const canonicalArgs = {
            data: bytes, name, argumentDigest: request.argumentDigest, target, inputRevision,
        }

        return this.ledger.run(
            this.context.principalId,
            ATOMIC_ATTACH_OPERATION,
            idempotencyKey,
            canonicalArgs,
            async () => {
                const contentDigest = await sha256(bytes)
                const revision = `sha256:${contentDigest}`
                const descriptor = { id, revision, name }
                const existing = await this.adapter.getInlay(id)
                if (existing) {
                    const metadata = existing.lifecycle
                    if (!validMetadata(metadata)
                        || metadata.operation !== ATOMIC_ATTACH_OPERATION
                        || metadata.ownerPrincipalId !== this.context.principalId
                        || metadata.idempotencyKey !== idempotencyKey
                        || metadata.argumentDigest !== request.argumentDigest
                        || metadata.revision !== revision
                        || metadata.context.characterId !== characterId
                        || metadata.context.conversationId !== conversationId
                        || metadata.context.messageId !== messageId
                        || metadata.inputRevision !== inputRevision
                        || existing.id !== id
                        || existing.revision !== revision
                        || existing.name !== name) {
                        throw new PluginApiError('CONFLICT', 'Stored Inlay conflicts with the atomic attach request')
                    }
                    return descriptor
                }

                const lifecycle: InlayAtomicLifecycleMetadata = {
                    version: 1,
                    ownerPrincipalId: this.context.principalId,
                    operation: ATOMIC_ATTACH_OPERATION,
                    idempotencyKey,
                    argumentDigest: request.argumentDigest,
                    revision,
                    context: { kind: 'message', ...target },
                    inputRevision,
                }
                await this.adapter.writeImage(bytes.slice(), {
                    id,
                    name,
                    lifecycle,
                    beforeMutation: async () => {
                        if (this.adapter.getCurrentCharacterId() !== characterId) {
                            throw new PluginApiError('PERMISSION_DENIED', 'Character context is no longer current')
                        }
                        await request.beforeMutation()
                    },
                })
                const stored = await this.adapter.getInlay(id)
                if (!stored || !validMetadata(stored.lifecycle)
                    || stored.lifecycle.operation !== ATOMIC_ATTACH_OPERATION
                    || stored.lifecycle.ownerPrincipalId !== this.context.principalId
                    || stored.lifecycle.idempotencyKey !== idempotencyKey
                    || stored.lifecycle.argumentDigest !== request.argumentDigest
                    || stored.lifecycle.revision !== revision
                    || stored.lifecycle.context.characterId !== characterId
                    || stored.lifecycle.context.conversationId !== conversationId
                    || stored.lifecycle.context.messageId !== messageId
                    || stored.lifecycle.inputRevision !== inputRevision
                    || stored.id !== id
                    || stored.name !== name
                    || stored.revision !== revision) {
                    throw new PluginApiError('INTERNAL', 'Inlay storage did not confirm the atomic lifecycle record', {
                        retryable: true,
                    })
                }
                return descriptor
            },
            { durable: true },
        )
    }

    async deleteInlay(id: string, rawOptions: { expectedRevision?: string } = {}) {
        await this.requirePermission()
        if (!nonEmptyString(id)) invalidArgument('Inlay id must be non-empty')
        const options = plainDataObject(rawOptions, ['expectedRevision'], 'deleteInlay options')
        const expectedRevision = options.expectedRevision === undefined
            ? undefined
            : requiredString(options.expectedRevision, 'expectedRevision must be non-empty')
        const record = await this.adapter.getInlay(id)
        if (!record) return { deleted: false as const, reason: 'not-found' as const }
        const metadata = record.lifecycle
        if (!validMetadata(metadata) || metadata.ownerPrincipalId !== this.context.principalId) {
            throw new PluginApiError('PERMISSION_DENIED', 'Inlay is not owned by the current plugin')
        }
        if (await deterministicInlayId(metadata.ownerPrincipalId, metadata.operation, metadata.idempotencyKey) !== id) {
            throw new PluginApiError('PERMISSION_DENIED', 'Inlay lifecycle identity is malformed')
        }
        if (expectedRevision !== undefined && expectedRevision !== record.revision) {
            throw new PluginApiError('CONFLICT', 'Inlay revision changed', {
                details: { expectedRevision, actualRevision: record.revision },
            })
        }
        if (await this.adapter.hasReference(id)) return { deleted: false as const, reason: 'referenced' as const }
        if (!await this.adapter.removeInlay(id)) {
            throw new PluginApiError('INTERNAL', 'Inlay storage did not confirm removal', { retryable: true })
        }
        this.ledger.releaseDurable(metadata.ownerPrincipalId, metadata.operation, metadata.idempotencyKey)
        return { deleted: true as const }
    }
}

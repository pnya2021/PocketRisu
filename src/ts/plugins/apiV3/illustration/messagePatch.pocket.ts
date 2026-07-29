import { safeStructuredClone } from '../../../polyfill'
import { PluginApiError } from './errors'
import type {
    MessagePatchHostAdapter,
    MessagePatchResult,
    PreparedMessagePatch,
    RestrictedMessagePatch,
} from './messagePatch'
import {
    MAX_CALLER_ATTACHMENTS,
    projectCallerAttachments,
    projectLogicalContent,
    resolveLogicalInsertionOffset,
    type MessageSnapshot,
    type PluginJsonValue,
} from './messageQuery'
import { canonicalJson, createRevision, validateJsonLimits } from './revision'

type UnknownRecord = Record<string, any>

const OPERATION = 'chat.message-patch.v1'
const RETENTION_MS = 86_400_000
const MAX_RECEIPTS_PER_PRINCIPAL = 4_096
const MAX_RECEIPT_BYTES = 2_200_000
const MAX_CHAT_RECEIPT_BYTES = 134_217_728
const MAX_METADATA_BYTES = 65_536
const MAX_METADATA_KEYS = 16
const MAX_SNAPSHOT_UTF16 = 262_144
const MAX_SNAPSHOT_JSON_BYTES = 2_097_152
const encoder = new TextEncoder()

export interface PocketMessagePatchDependencies {
    getDatabase(): { characters?: UnknownRecord[] }
    getCurrentCharacter(): UnknownRecord | undefined
    ensureChatHydrated(chats: any[], index: number, chaId: string): Promise<UnknownRecord | null>
    saveChatToServer(chaId: string, chatIndex: number, chatId: string, chat: any): Promise<void>
    runExclusiveMutation<T>(operation: () => T | Promise<T>): Promise<T>
    listInlayKeys(): Promise<string[]>
    getInlayAssetRecord(id: string): Promise<unknown | null>
    createRevision?(value: unknown): Promise<string>
    createId?(): string
    now?(): number
}

interface PersistedReceipt {
    version: 1
    principalId: string
    operation: typeof OPERATION
    idempotencyKey: string
    digest: string
    target: { characterId: string; conversationId: string; messageId: string }
    result: MessagePatchResult
    completedAt: number
    expiresAt: number
}

interface LiveCapture {
    root: object
    characters: UnknownRecord[]
    character: UnknownRecord
    characterIndex: number
    chats: UnknownRecord[]
    conversation: UnknownRecord
    conversationIndex: number
    messages: UnknownRecord[]
    message: UnknownRecord
    messageIndex: number
    messageCount: number
    isStreaming: unknown
    characterType: unknown
    memberIds: unknown[] | undefined
    canonicalSource: string
}

const nonEmptyString = (value: unknown): value is string => typeof value === 'string' && value.length > 0

const conflict = (message = 'Message changed; retry the patch'): never => {
    throw new PluginApiError('CONFLICT', message, { retryable: true })
}

const notFound = (): never => {
    throw new PluginApiError('NOT_FOUND', 'Message or conversation was not found')
}

const currentTarget = (dependencies: PocketMessagePatchDependencies) => {
    const character = dependencies.getCurrentCharacter()
    const characterId = character?.chaId
    const page = character?.chatPage
    const conversationId = Number.isInteger(page) ? character?.chats?.[page]?.id : undefined
    return nonEmptyString(characterId) && nonEmptyString(conversationId)
        ? { character, characterId, conversationId }
        : null
}

const ensureCurrentTarget = (dependencies: PocketMessagePatchDependencies, request: PreparedMessagePatch) => {
    const current = currentTarget(dependencies)
    if (!current || current.characterId !== request.input.target.characterId
        || current.conversationId !== request.input.target.conversationId) {
        throw new PluginApiError('PERMISSION_DENIED', 'Message target is not current')
    }
    return current
}

const ensureRequestActive = (request: PreparedMessagePatch) => {
    if (request.signal.aborted) throw new PluginApiError('ABORTED', 'Operation aborted')
}

const dependencyFailure = (error: unknown, label: string): never => {
    if (error instanceof PluginApiError) throw error
    throw new PluginApiError('INTERNAL', `${label} dependency failed`, { retryable: true })
}

const exactCharacter = (root: { characters?: UnknownRecord[] }, characterId: string) => {
    if (!Array.isArray(root.characters)) notFound()
    const matches = root.characters.flatMap((character, index) =>
        character?.chaId === characterId ? [{ character, index }] : [])
    if (matches.length === 0) notFound()
    if (matches.length !== 1) conflict('Character identity is ambiguous')
    return { characters: root.characters, ...matches[0] }
}

const exactConversation = (character: UnknownRecord, conversationId: string) => {
    if (!Array.isArray(character?.chats)) notFound()
    const matches = character.chats.flatMap((conversation: UnknownRecord, index: number) =>
        conversation?.id === conversationId ? [{ conversation, index }] : [])
    if (matches.length === 0) notFound()
    if (matches.length !== 1) conflict('Conversation identity is ambiguous')
    return { chats: character.chats as UnknownRecord[], ...matches[0] }
}

const exactMessage = (conversation: UnknownRecord, messageId: string) => {
    if (!Array.isArray(conversation?.message)) notFound()
    const matches = conversation.message.flatMap((message: UnknownRecord, index: number) =>
        message?.chatId === messageId ? [{ message, index }] : [])
    if (matches.length === 0) notFound()
    if (matches.length !== 1) conflict('Message identity is ambiguous')
    if (conversation.isStreaming === true && matches[0].index === conversation.message.length - 1
        && matches[0].message?.role === 'char') conflict('Message is still streaming')
    if ((matches[0].message?.role !== 'user' && matches[0].message?.role !== 'char')
        || typeof matches[0].message?.data !== 'string') conflict()
    return { messages: conversation.message as UnknownRecord[], ...matches[0] }
}

const revisionValue = (message: UnknownRecord) => ({
    role: message.role,
    data: message.data,
    saying: typeof message.saying === 'string' ? message.saying : null,
    generationId: typeof message.generationInfo?.generationId === 'string'
        ? message.generationInfo.generationId
        : null,
    pluginMessageState: message.pluginMessageState ?? {},
})

const sourceValue = (message: UnknownRecord) => ({
    revision: revisionValue(message),
    time: typeof message.time === 'number' && Number.isFinite(message.time) ? message.time : null,
    pluginMessageUpdatedAt: typeof message.pluginMessageUpdatedAt === 'number'
        && Number.isFinite(message.pluginMessageUpdatedAt)
        ? message.pluginMessageUpdatedAt
        : null,
})

const captureLive = (
    dependencies: PocketMessagePatchDependencies,
    request: PreparedMessagePatch,
): LiveCapture => {
    const root = dependencies.getDatabase()
    if (!root || typeof root !== 'object') notFound()
    const locatedCharacter = exactCharacter(root, request.input.target.characterId)
    const locatedConversation = exactConversation(locatedCharacter.character, request.input.target.conversationId)
    const locatedMessage = exactMessage(locatedConversation.conversation, request.input.target.messageId)
    return {
        root,
        characters: locatedCharacter.characters,
        character: locatedCharacter.character,
        characterIndex: locatedCharacter.index,
        chats: locatedConversation.chats,
        conversation: locatedConversation.conversation,
        conversationIndex: locatedConversation.index,
        messages: locatedMessage.messages,
        message: locatedMessage.message,
        messageIndex: locatedMessage.index,
        messageCount: locatedMessage.messages.length,
        isStreaming: locatedConversation.conversation.isStreaming,
        characterType: locatedCharacter.character.type,
        memberIds: Array.isArray(locatedCharacter.character.characters)
            ? [...locatedCharacter.character.characters]
            : undefined,
        canonicalSource: canonicalJson(sourceValue(locatedMessage.message)),
    }
}

const isCaptureCurrent = (
    dependencies: PocketMessagePatchDependencies,
    request: PreparedMessagePatch,
    capture: LiveCapture,
) => {
    try {
        const current = currentTarget(dependencies)
        return !!current
            && current.character === capture.character
            && current.characterId === request.input.target.characterId
            && current.conversationId === request.input.target.conversationId
            && dependencies.getDatabase() === capture.root
            && (capture.root as any).characters === capture.characters
            && capture.characters[capture.characterIndex] === capture.character
            && capture.character.chats === capture.chats
            && capture.chats[capture.conversationIndex] === capture.conversation
            && capture.conversation.id === request.input.target.conversationId
            && capture.conversation.isStreaming === capture.isStreaming
            && capture.conversation.message === capture.messages
            && capture.messages.length === capture.messageCount
            && capture.messages[capture.messageIndex] === capture.message
            && capture.message.chatId === request.input.target.messageId
            && capture.character.type === capture.characterType
            && (capture.memberIds === undefined
                ? capture.character.characters === undefined
                : Array.isArray(capture.character.characters)
                    && capture.character.characters.length === capture.memberIds.length
                    && capture.character.characters.every((value: unknown, index: number) =>
                        value === capture.memberIds![index]))
            && canonicalJson(sourceValue(capture.message)) === capture.canonicalSource
    } catch {
        return false
    }
}

const ensureCaptureCurrent = (
    dependencies: PocketMessagePatchDependencies,
    request: PreparedMessagePatch,
    capture: LiveCapture,
) => {
    ensureRequestActive(request)
    ensureCurrentTarget(dependencies, request)
    if (!isCaptureCurrent(dependencies, request, capture)) conflict()
}

const rejectAfterCaptureFailure = (
    dependencies: PocketMessagePatchDependencies,
    request: PreparedMessagePatch,
    capture: LiveCapture,
    error: unknown,
    label: string,
): never => {
    ensureCaptureCurrent(dependencies, request, capture)
    return dependencyFailure(error, label)
}

const plainRecord = (value: unknown): value is UnknownRecord => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return false
    const prototype = Object.getPrototypeOf(value)
    return prototype === Object.prototype || prototype === null
}

const cloneJson = <T>(value: T): T => JSON.parse(canonicalJson(value)) as T

const ownedInlayFailure = () => new PluginApiError(
    'PERMISSION_DENIED',
    'Inlay is not owned by the current plugin',
)

const deterministicInlayId = async (
    principalId: string,
    operation: 'inlay.create.v1' | 'inlay.atomic-attach.v1',
    idempotencyKey: string,
) => {
    const bytes = encoder.encode(JSON.stringify([principalId, operation, idempotencyKey]))
    const digest = await crypto.subtle.digest('SHA-256', bytes)
    return `inlay_${[...new Uint8Array(digest)]
        .map((byte) => byte.toString(16).padStart(2, '0')).join('')}`
}

const assertOwnedInlay = async (
    dependencies: PocketMessagePatchDependencies,
    request: PreparedMessagePatch,
    capture: LiveCapture,
    inlayId: string,
    allowAtomicMessageLifecycle: boolean,
) => {
    let record: unknown
    try {
        record = await dependencies.getInlayAssetRecord(inlayId)
    } catch (error) {
        return rejectAfterCaptureFailure(dependencies, request, capture, error, 'Inlay ownership')
    }
    ensureCaptureCurrent(dependencies, request, capture)
    if (record === null) throw new PluginApiError('NOT_FOUND', 'Owned Inlay was not found')
    const lifecycle = plainRecord(record) && plainRecord(record.lifecycle)
        ? record.lifecycle
        : undefined
    const context = lifecycle && plainRecord(lifecycle.context) ? lifecycle.context : undefined
    const validCreateContext = lifecycle?.operation === 'inlay.create.v1'
        && context?.kind === 'character'
        && context.characterId === request.input.target.characterId
    const validAtomicContext = allowAtomicMessageLifecycle
        && lifecycle?.operation === 'inlay.atomic-attach.v1'
        && context?.kind === 'message'
        && context.characterId === request.input.target.characterId
        && context.conversationId === request.input.target.conversationId
        && context.messageId === request.input.target.messageId
        && nonEmptyString(lifecycle.inputRevision)
    if (!lifecycle
        || lifecycle.version !== 1
        || lifecycle.ownerPrincipalId !== request.principalId
        || !nonEmptyString(lifecycle.idempotencyKey)
        || encoder.encode(lifecycle.idempotencyKey).byteLength > 256
        || typeof lifecycle.argumentDigest !== 'string'
        || !/^[0-9a-f]{64}$/u.test(lifecycle.argumentDigest)
        || typeof lifecycle.revision !== 'string'
        || !/^sha256:[0-9a-f]{64}$/u.test(lifecycle.revision)
        || (!validCreateContext && !validAtomicContext)) throw ownedInlayFailure()
    let expectedId: string
    try {
        expectedId = await deterministicInlayId(
            request.principalId,
            lifecycle.operation,
            lifecycle.idempotencyKey,
        )
    } catch (error) {
        return rejectAfterCaptureFailure(dependencies, request, capture, error, 'Inlay ownership')
    }
    ensureCaptureCurrent(dependencies, request, capture)
    if (expectedId !== inlayId) throw ownedInlayFailure()
    let confirmed: unknown
    try {
        confirmed = await dependencies.getInlayAssetRecord(inlayId)
    } catch (error) {
        return rejectAfterCaptureFailure(dependencies, request, capture, error, 'Inlay ownership')
    }
    ensureCaptureCurrent(dependencies, request, capture)
    const confirmedLifecycle = plainRecord(confirmed) && plainRecord(confirmed.lifecycle)
        ? confirmed.lifecycle
        : undefined
    if (!confirmedLifecycle || canonicalJson(confirmedLifecycle) !== canonicalJson(lifecycle)) {
        conflict('Owned Inlay changed before message staging')
    }
}

const storedAttachmentIndexes = (attachments: unknown[], inlayId: string) => attachments
    .flatMap((attachment, index) => plainRecord(attachment) && attachment.inlayId === inlayId
        ? [{ attachment, index }] : [])

const managedAttachment = (
    data: string,
    recognized: ReadonlySet<string>,
    attachments: unknown[],
    inlayId: string,
) => {
    const matches = storedAttachmentIndexes(attachments, inlayId)
    if (matches.length === 0) {
        throw new PluginApiError('NOT_FOUND', 'Caller-owned Inlay attachment was not found')
    }
    if (matches.length !== 1 || matches[0].attachment.presentation !== 'inline') {
        conflict('Caller-owned Inlay attachment is ambiguous')
    }
    const marker = projectLogicalContent(data, recognized).markers.find((candidate) => candidate.id === inlayId)
    if (!marker) conflict('Caller-owned Inlay marker is missing')
    return { ...matches[0], marker }
}

const attachedDescriptor = (patch: Extract<RestrictedMessagePatch, { op: 'attachInlay' }>) => ({
    inlayId: patch.inlayId,
    presentation: 'inline' as const,
    ...(patch.metadata === undefined ? {} : { metadata: cloneJson(patch.metadata) }),
})

const validReceipt = (value: unknown): value is PersistedReceipt => {
    if (!plainRecord(value)) return false
    return value.version === 1
        && nonEmptyString(value.principalId)
        && value.operation === OPERATION
        && nonEmptyString(value.idempotencyKey)
        && typeof value.digest === 'string' && /^[0-9a-f]{64}$/u.test(value.digest)
        && plainRecord(value.target)
        && nonEmptyString(value.target.characterId)
        && nonEmptyString(value.target.conversationId)
        && nonEmptyString(value.target.messageId)
        && plainRecord(value.result)
        && typeof value.result.changed === 'boolean'
        && nonEmptyString(value.result.commitId)
        && plainRecord(value.result.message)
        && typeof value.completedAt === 'number' && Number.isFinite(value.completedAt)
        && typeof value.expiresAt === 'number' && Number.isFinite(value.expiresAt)
}

const receipts = (conversation: UnknownRecord, now: number) => {
    const raw = conversation.pluginMessagePatchReceipts
    if (raw === undefined) return [] as PersistedReceipt[]
    if (!Array.isArray(raw) || raw.some((entry) => !validReceipt(entry))) {
        throw new PluginApiError('INTERNAL', 'Message patch receipts are invalid', { retryable: true })
    }
    return raw.filter((entry) => entry.expiresAt > now).map((entry) => cloneJson(entry))
}

const receiptReplay = (
    records: PersistedReceipt[],
    request: PreparedMessagePatch,
): MessagePatchResult | undefined => {
    const matches = records.filter((record) => record.principalId === request.principalId
        && record.operation === OPERATION && record.idempotencyKey === request.input.idempotencyKey)
    if (matches.length > 1) throw new PluginApiError('INTERNAL', 'Duplicate message patch receipt', { retryable: true })
    if (matches.length === 0) return undefined
    if (matches[0].digest !== request.argumentDigest) {
        throw new PluginApiError('CONFLICT', 'Idempotency key arguments conflict')
    }
    return cloneJson(matches[0].result)
}

const callerState = (message: UnknownRecord, principalId: string) => {
    const root = message.pluginMessageState
    if (root !== undefined && !plainRecord(root)) {
        throw new PluginApiError('INTERNAL', 'Plugin message state is invalid', { retryable: true })
    }
    const existing = root?.[principalId]
    if (existing !== undefined && !plainRecord(existing)) {
        throw new PluginApiError('INTERNAL', 'Caller message state is invalid', { retryable: true })
    }
    const metadata = existing?.metadata ?? {}
    const attachments = existing?.attachments ?? []
    if (!plainRecord(metadata) || !Array.isArray(attachments)) {
        throw new PluginApiError('INTERNAL', 'Caller message state is invalid', { retryable: true })
    }
    return {
        ...(existing ?? {}),
        metadata: cloneJson(metadata) as Record<string, PluginJsonValue>,
        attachments: safeStructuredClone(attachments),
    }
}

const validateCallerMetadata = (state: UnknownRecord) => {
    const keys = Reflect.ownKeys(state.metadata)
    if (keys.some((key) => typeof key !== 'string')) {
        throw new PluginApiError('INVALID_ARGUMENT', 'Invalid caller metadata')
    }
    if (keys.length > MAX_METADATA_KEYS) {
        throw new PluginApiError('RESOURCE_LIMIT', 'Caller message metadata key limit exceeded')
    }
    if (state.attachments.length > MAX_CALLER_ATTACHMENTS) {
        throw new PluginApiError('RESOURCE_LIMIT', 'Caller attachment limit exceeded')
    }
    state.attachments.forEach((attachment: unknown) => {
        if (!plainRecord(attachment)) {
            throw new PluginApiError('INTERNAL', 'Caller attachment state is invalid', { retryable: true })
        }
        if (Object.hasOwn(attachment, 'metadata')) {
            validateJsonLimits(attachment.metadata, { maxDepth: 32, maxBytes: MAX_METADATA_BYTES })
        }
    })
    validateJsonLimits({ metadata: state.metadata, attachments: state.attachments }, {
        maxDepth: 32, maxBytes: MAX_METADATA_BYTES,
    })
}

const timestamp = (value: unknown) => typeof value === 'number' && Number.isFinite(value) && value >= 0
    ? value
    : 0

const snapshot = async (
    capture: LiveCapture,
    message: UnknownRecord,
    request: PreparedMessagePatch,
    recognized: ReadonlySet<string>,
    revision: (value: unknown) => Promise<string>,
): Promise<MessageSnapshot> => {
    const state = message.pluginMessageState?.[request.principalId]
    const metadata = state?.metadata === undefined ? {} : cloneJson(state.metadata)
    const result: MessageSnapshot = {
        ...request.input.target,
        role: message.role,
        content: projectLogicalContent(message.data, recognized).content,
        revision: await revision(revisionValue(message)),
        updatedAt: Math.max(timestamp(message.time), timestamp(message.pluginMessageUpdatedAt), timestamp(state?.updatedAt)),
        callerPluginState: {
            metadata,
            attachments: projectCallerAttachments(message.data, recognized, state?.attachments),
        },
    }
    if (message.role === 'char') {
        if (capture.character.type === 'group') {
            if (Array.isArray(capture.character.characters) && capture.character.characters.includes(message.saying)) {
                result.speakerCharacterId = message.saying
            }
        } else result.speakerCharacterId = request.input.target.characterId
    }
    if (nonEmptyString(message.generationInfo?.generationId)) result.generationId = message.generationInfo.generationId
    if (timestamp(message.time) > 0 || message.time === 0) result.createdAt = message.time
    const details = {
        contentUtf16: result.content.length,
        callerAttachmentCount: result.callerPluginState.attachments.length,
    }
    if (result.content.length > MAX_SNAPSHOT_UTF16
        || new TextEncoder().encode(JSON.stringify(result)).byteLength > MAX_SNAPSHOT_JSON_BYTES) {
        throw new PluginApiError('RESOURCE_LIMIT', 'Message snapshot exceeds limit', { details })
    }
    return result
}

const appendReceipt = (records: PersistedReceipt[], receipt: PersistedReceipt) => {
    const principalCount = records.filter((record) => record.principalId === receipt.principalId).length
    if (principalCount >= MAX_RECEIPTS_PER_PRINCIPAL) {
        throw new PluginApiError('RESOURCE_LIMIT', 'Message patch receipt capacity is full', { retryable: true })
    }
    const receiptBytes = new TextEncoder().encode(canonicalJson(receipt)).byteLength
    if (receiptBytes > MAX_RECEIPT_BYTES) {
        throw new PluginApiError('RESOURCE_LIMIT', 'Message patch receipt exceeds storage limit')
    }
    const next = [...records, receipt]
    if (new TextEncoder().encode(canonicalJson(next)).byteLength > MAX_CHAT_RECEIPT_BYTES) {
        throw new PluginApiError('RESOURCE_LIMIT', 'Message patch receipt storage is full', { retryable: true })
    }
    return next
}

export function createPocketMessagePatchAdapter(
    dependencies: PocketMessagePatchDependencies,
): MessagePatchHostAdapter {
    const revision = dependencies.createRevision ?? createRevision
    const now = dependencies.now ?? Date.now
    const createId = dependencies.createId ?? (() => crypto.randomUUID())

    return {
        current() {
            const current = currentTarget(dependencies)
            return current ? { characterId: current.characterId, conversationId: current.conversationId } : null
        },

        patchCurrentMessage(request) {
            return dependencies.runExclusiveMutation(async () => {
                ensureRequestActive(request)
                ensureCurrentTarget(dependencies, request)
                const root = dependencies.getDatabase()
                if (!root || typeof root !== 'object') notFound()
                const character = exactCharacter(root, request.input.target.characterId)
                const conversation = exactConversation(character.character, request.input.target.conversationId)
                const initialIndex = conversation.index
                let hydrated: UnknownRecord | null
                try {
                    hydrated = await dependencies.ensureChatHydrated(
                        conversation.chats, initialIndex, request.input.target.characterId,
                    )
                } catch (error) {
                    ensureRequestActive(request)
                    ensureCurrentTarget(dependencies, request)
                    if (dependencies.getDatabase() !== root || root.characters !== character.characters
                        || character.characters[character.index] !== character.character
                        || character.character.chats !== conversation.chats
                        || conversation.chats[initialIndex] !== conversation.conversation) conflict()
                    return dependencyFailure(error, 'Message hydration')
                }
                ensureRequestActive(request)
                ensureCurrentTarget(dependencies, request)
                if (dependencies.getDatabase() !== root || root.characters !== character.characters
                    || character.characters[character.index] !== character.character
                    || character.character.chats !== conversation.chats) conflict()
                const afterHydration = exactConversation(character.character, request.input.target.conversationId)
                if (!hydrated || hydrated._placeholder === true || !Array.isArray(hydrated.message)
                    || afterHydration.index !== initialIndex || afterHydration.conversation !== hydrated) conflict()

                const activeReceipts = receipts(afterHydration.conversation, now())
                const replay = receiptReplay(activeReceipts, request)
                if (replay) return replay

                const capture = captureLive(dependencies, request)
                let actualRevision: string
                try {
                    actualRevision = await revision(revisionValue(capture.message))
                } catch (error) {
                    return rejectAfterCaptureFailure(
                        dependencies, request, capture, error, 'Message revision',
                    )
                }
                ensureCaptureCurrent(dependencies, request, capture)
                if (actualRevision !== request.input.expectedRevision) conflict('Message revision is stale')

                let keys: string[]
                try {
                    keys = await dependencies.listInlayKeys()
                } catch (error) {
                    return rejectAfterCaptureFailure(
                        dependencies, request, capture, error, 'Inlay enumeration',
                    )
                }
                ensureCaptureCurrent(dependencies, request, capture)
                if (!Array.isArray(keys) || keys.some((key) => typeof key !== 'string')) {
                    throw new PluginApiError('INTERNAL', 'Unable to enumerate Inlays', { retryable: true })
                }

                const patch = request.input.patch
                const mutationInlayIds = patch.op === 'detachOwnInlay'
                    ? [patch.inlayId]
                    : patch.op === 'attachInlay'
                        ? [
                            patch.inlayId,
                            ...(patch.placement.kind === 'replace-own-inlay'
                                ? [patch.placement.inlayId] : []),
                        ]
                        : []
                const ownershipChecks = patch.op === 'detachOwnInlay'
                    ? [{ id: patch.inlayId, allowAtomicMessageLifecycle: true }]
                    : patch.op === 'attachInlay'
                        ? [
                            { id: patch.inlayId, allowAtomicMessageLifecycle: false },
                            ...(patch.placement.kind === 'replace-own-inlay'
                                ? [{
                                    id: patch.placement.inlayId,
                                    allowAtomicMessageLifecycle: true,
                                }] : []),
                        ]
                        : []
                if (patch.op === 'attachInlay'
                    && patch.placement.kind === 'replace-own-inlay'
                    && patch.inlayId === patch.placement.inlayId) {
                    conflict('Replacement Inlay must be different')
                }
                const recognized = new Set([...keys, ...mutationInlayIds])

                const staged = safeStructuredClone(capture.conversation)
                const stagedMessage = staged.message[capture.messageIndex]
                const state = callerState(stagedMessage, request.principalId)
                const metadata = state.metadata
                const attachments = state.attachments
                let nextData = stagedMessage.data
                let changed = false
                if (patch.op === 'setPluginMetadata') {
                    const previous = Object.hasOwn(metadata, patch.key)
                        ? canonicalJson(metadata[patch.key])
                        : undefined
                    Object.defineProperty(metadata, patch.key, {
                        value: cloneJson(patch.value), enumerable: true, configurable: true, writable: true,
                    })
                    changed = previous !== canonicalJson(patch.value)
                } else if (patch.op === 'attachInlay') {
                    const projection = projectLogicalContent(nextData, recognized)
                    if (storedAttachmentIndexes(attachments, patch.inlayId).length > 0
                        || projection.markers.some((marker) => marker.id === patch.inlayId)) {
                        conflict('Inlay is already attached to this message')
                    }
                    const descriptor = attachedDescriptor(patch)
                    if (patch.placement.kind === 'replace-own-inlay') {
                        const existing = managedAttachment(
                            nextData,
                            recognized,
                            attachments,
                            patch.placement.inlayId,
                        )
                        attachments.splice(existing.index, 1, descriptor)
                        nextData = nextData.slice(0, existing.marker.rawStart)
                            + `{{inlay::${patch.inlayId}}}`
                            + nextData.slice(existing.marker.rawEnd)
                    } else {
                        const insertionOffset = resolveLogicalInsertionOffset(
                            nextData,
                            recognized,
                            patch.placement,
                        )
                        if (insertionOffset === null) {
                            throw new PluginApiError('INVALID_ARGUMENT', 'Invalid logical UTF-16 placement')
                        }
                        attachments.push(descriptor)
                        nextData = nextData.slice(0, insertionOffset)
                            + `{{inlay::${patch.inlayId}}}`
                            + nextData.slice(insertionOffset)
                    }
                    changed = true
                } else {
                    const existing = managedAttachment(
                        nextData,
                        recognized,
                        attachments,
                        patch.inlayId,
                    )
                    attachments.splice(existing.index, 1)
                    nextData = nextData.slice(0, existing.marker.rawStart)
                        + nextData.slice(existing.marker.rawEnd)
                    changed = true
                }
                validateCallerMetadata(state)
                const completedAt = now()
                if (changed) {
                    state.updatedAt = completedAt
                    stagedMessage.data = nextData
                    stagedMessage.pluginMessageState = {
                        ...(stagedMessage.pluginMessageState ?? {}),
                        [request.principalId]: state,
                    }
                    stagedMessage.pluginMessageUpdatedAt = completedAt
                }
                let message: MessageSnapshot
                try {
                    message = await snapshot(capture, stagedMessage, request, recognized, revision)
                } catch (error) {
                    return rejectAfterCaptureFailure(
                        dependencies, request, capture, error, 'Message snapshot',
                    )
                }
                ensureCaptureCurrent(dependencies, request, capture)
                for (const check of ownershipChecks) {
                    await assertOwnedInlay(
                        dependencies,
                        request,
                        capture,
                        check.id,
                        check.allowAtomicMessageLifecycle,
                    )
                }
                ensureCaptureCurrent(dependencies, request, capture)
                const result: MessagePatchResult = { changed, message, commitId: createId() }
                const receipt: PersistedReceipt = {
                    version: 1,
                    principalId: request.principalId,
                    operation: OPERATION,
                    idempotencyKey: request.input.idempotencyKey,
                    digest: request.argumentDigest,
                    target: { ...request.input.target },
                    result: cloneJson(result),
                    completedAt,
                    expiresAt: completedAt + RETENTION_MS,
                }
                staged.pluginMessagePatchReceipts = appendReceipt(activeReceipts, receipt)

                try {
                    await dependencies.saveChatToServer(
                        request.input.target.characterId,
                        capture.conversationIndex,
                        request.input.target.conversationId,
                        staged,
                    )
                } catch (error) {
                    return rejectAfterCaptureFailure(
                        dependencies, request, capture, error, 'Message persistence',
                    )
                }
                ensureCaptureCurrent(dependencies, request, capture)
                capture.chats[capture.conversationIndex] = staged
                return cloneJson(result)
            })
        },
    }
}

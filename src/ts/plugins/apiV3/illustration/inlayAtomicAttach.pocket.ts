import { safeStructuredClone } from '../../../polyfill'
import { PluginApiError } from './errors'
import type {
    InlayAtomicAttachHostAdapter,
    InlayAtomicAttachResult,
    PreparedInlayAtomicAttach,
} from './inlayAtomicAttach'
import type { AtomicInlayStageRequest, InlayDescriptor } from './inlayLifecycle'
import { deterministicAtomicInlayId } from './inlayLifecycle'
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

const OPERATION = 'inlay.atomic-attach.v1'
const MAX_METADATA_BYTES = 65_536
const MAX_METADATA_KEYS = 16
const MAX_RECEIPTS_PER_PRINCIPAL = 4_096
const MAX_RECEIPT_BYTES = 2_200_000
const MAX_CHAT_RECEIPT_BYTES = 134_217_728
const MAX_SNAPSHOT_UTF16 = 262_144
const MAX_SNAPSHOT_JSON_BYTES = 2_097_152

export interface PocketInlayAtomicAttachDependencies {
    getDatabase(): { characters?: UnknownRecord[] }
    getCurrentCharacter(): UnknownRecord | undefined
    ensureChatHydrated(chats: any[], index: number, chaId: string): Promise<UnknownRecord | null>
    saveChatToServer(chaId: string, chatIndex: number, chatId: string, chat: any): Promise<void>
    runFailClosedExclusiveMutation<T>(operation: () => T | Promise<T>): Promise<T>
    listInlayKeys(): Promise<string[]>
    stageAtomicInlay(data: Uint8Array, request: AtomicInlayStageRequest): Promise<InlayDescriptor>
    deleteInlay(id: string, options?: { expectedRevision?: string }): Promise<unknown>
    createRevision?(value: unknown): Promise<string>
    createId?(): string
    now?(): number
}

interface PersistedAtomicReceipt {
    version: 1
    principalId: string
    operation: typeof OPERATION
    idempotencyKey: string
    digest: string
    target: { characterId: string; conversationId: string; messageId: string }
    result: InlayAtomicAttachResult
    completedAt: number
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

type LeaseOutcome =
    | { ok: true; result: InlayAtomicAttachResult }
    | { ok: false; error: unknown }

const nonEmptyString = (value: unknown): value is string => typeof value === 'string' && value.length > 0
const plainRecord = (value: unknown): value is UnknownRecord => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return false
    const prototype = Object.getPrototypeOf(value)
    return prototype === Object.prototype || prototype === null
}

const conflict = (message = 'Message changed; retry the attachment'): never => {
    throw new PluginApiError('CONFLICT', message, { retryable: true })
}

const notFound = (): never => {
    throw new PluginApiError('NOT_FOUND', 'Message or conversation was not found')
}

const currentTarget = (dependencies: PocketInlayAtomicAttachDependencies) => {
    const character = dependencies.getCurrentCharacter()
    const characterId = character?.chaId
    const page = character?.chatPage
    const conversationId = Number.isInteger(page) ? character?.chats?.[page]?.id : undefined
    return nonEmptyString(characterId) && nonEmptyString(conversationId)
        ? { character, characterId, conversationId }
        : null
}

const ensureRequestActive = (request: PreparedInlayAtomicAttach) => {
    if (request.signal.aborted) throw new PluginApiError('ABORTED', 'Operation aborted')
}

const ensureCurrentTarget = (
    dependencies: PocketInlayAtomicAttachDependencies,
    request: PreparedInlayAtomicAttach,
) => {
    const current = currentTarget(dependencies)
    if (!current || current.characterId !== request.input.target.characterId
        || current.conversationId !== request.input.target.conversationId) {
        throw new PluginApiError('PERMISSION_DENIED', 'Message target is not current')
    }
    return current
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
    dependencies: PocketInlayAtomicAttachDependencies,
    request: PreparedInlayAtomicAttach,
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
    dependencies: PocketInlayAtomicAttachDependencies,
    request: PreparedInlayAtomicAttach,
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
    dependencies: PocketInlayAtomicAttachDependencies,
    request: PreparedInlayAtomicAttach,
    capture: LiveCapture,
) => {
    ensureRequestActive(request)
    ensureCurrentTarget(dependencies, request)
    if (!isCaptureCurrent(dependencies, request, capture)) conflict()
}

const rejectAfterCaptureFailure = (
    dependencies: PocketInlayAtomicAttachDependencies,
    request: PreparedInlayAtomicAttach,
    capture: LiveCapture,
    error: unknown,
    label: string,
): never => {
    ensureCaptureCurrent(dependencies, request, capture)
    return dependencyFailure(error, label)
}

const cloneJson = <T>(value: T): T => JSON.parse(canonicalJson(value)) as T

const validReceipt = (value: unknown): value is PersistedAtomicReceipt => {
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
        && plainRecord(value.result.inlay)
        && nonEmptyString(value.result.inlay.id)
        && nonEmptyString(value.result.inlay.revision)
        && nonEmptyString(value.result.inlay.name)
        && plainRecord(value.result.message)
        && nonEmptyString(value.result.commitId)
        && typeof value.completedAt === 'number' && Number.isFinite(value.completedAt)
}

const receipts = (conversation: UnknownRecord) => {
    const raw = conversation.pluginAtomicAttachReceipts
    if (raw === undefined) return [] as PersistedAtomicReceipt[]
    if (!Array.isArray(raw) || raw.some((entry) => !validReceipt(entry))) {
        throw new PluginApiError('INTERNAL', 'Atomic Inlay receipts are invalid', { retryable: true })
    }
    return raw.map((entry) => cloneJson(entry))
}

const receiptReplay = (
    records: PersistedAtomicReceipt[],
    request: PreparedInlayAtomicAttach,
): InlayAtomicAttachResult | undefined => {
    const matches = records.filter((record) => record.principalId === request.principalId
        && record.operation === OPERATION && record.idempotencyKey === request.input.idempotencyKey)
    if (matches.length > 1) throw new PluginApiError('INTERNAL', 'Duplicate atomic Inlay receipt', { retryable: true })
    if (matches.length === 0) return undefined
    if (matches[0].digest !== request.argumentDigest) {
        throw new PluginApiError('CONFLICT', 'Idempotency key arguments conflict')
    }
    return cloneJson(matches[0].result)
}

const appendReceipt = (records: PersistedAtomicReceipt[], receipt: PersistedAtomicReceipt) => {
    const principalCount = records.filter((record) => record.principalId === receipt.principalId).length
    if (principalCount >= MAX_RECEIPTS_PER_PRINCIPAL) {
        throw new PluginApiError('RESOURCE_LIMIT', 'Atomic Inlay receipt capacity is full', { retryable: true })
    }
    if (new TextEncoder().encode(canonicalJson(receipt)).byteLength > MAX_RECEIPT_BYTES) {
        throw new PluginApiError('RESOURCE_LIMIT', 'Atomic Inlay receipt exceeds storage limit')
    }
    const next = [...records, receipt]
    if (new TextEncoder().encode(canonicalJson(next)).byteLength > MAX_CHAT_RECEIPT_BYTES) {
        throw new PluginApiError('RESOURCE_LIMIT', 'Atomic Inlay receipt storage is full', { retryable: true })
    }
    return next
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
        attachments: safeStructuredClone(attachments) as UnknownRecord[],
    }
}

const validateCallerState = (state: UnknownRecord) => {
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
    request: PreparedInlayAtomicAttach,
    recognized: ReadonlySet<string>,
    revision: (value: unknown) => Promise<string>,
): Promise<MessageSnapshot> => {
    const state = message.pluginMessageState?.[request.principalId]
    const metadata = state?.metadata === undefined ? {} : cloneJson(state.metadata)
    const projection = projectLogicalContent(message.data, recognized)
    const result: MessageSnapshot = {
        ...request.input.target,
        role: message.role,
        content: projection.content,
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
        || result.callerPluginState.attachments.length > MAX_CALLER_ATTACHMENTS
        || new TextEncoder().encode(JSON.stringify(result)).byteLength > MAX_SNAPSHOT_JSON_BYTES) {
        throw new PluginApiError('RESOURCE_LIMIT', 'Message snapshot exceeds limit', { details })
    }
    return result
}

export function createPocketInlayAtomicAttachAdapter(
    dependencies: PocketInlayAtomicAttachDependencies,
): InlayAtomicAttachHostAdapter {
    const revision = dependencies.createRevision ?? createRevision
    const createId = dependencies.createId ?? (() => crypto.randomUUID())
    const now = dependencies.now ?? Date.now

    return {
        current() {
            const current = currentTarget(dependencies)
            return current ? { characterId: current.characterId, conversationId: current.conversationId } : null
        },

        async attachCurrentMessage(request) {
            let staged: InlayDescriptor | undefined
            let persistenceRequested = false
            const outcome = await dependencies.runFailClosedExclusiveMutation<LeaseOutcome>(async () => {
                try {
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

                    const activeReceipts = receipts(afterHydration.conversation)
                    const replay = receiptReplay(activeReceipts, request)
                    if (replay) return { ok: true, result: replay }

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
                    if (actualRevision !== request.input.expectedMessageRevision) {
                        conflict('Message revision is stale')
                    }

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
                    const known = new Set(keys)
                    const rawOffset = resolveLogicalInsertionOffset(
                        capture.message.data, known, request.input.placement,
                    )
                    if (rawOffset === null) {
                        throw new PluginApiError('INVALID_ARGUMENT', 'Invalid logical UTF-16 placement')
                    }
                    let anticipatedId: string
                    try {
                        anticipatedId = await deterministicAtomicInlayId(
                            request.principalId, request.input.idempotencyKey,
                        )
                    } catch (error) {
                        return rejectAfterCaptureFailure(
                            dependencies, request, capture, error, 'Atomic Inlay identity',
                        )
                    }
                    ensureCaptureCurrent(dependencies, request, capture)
                    const state = callerState(capture.message, request.principalId)
                    if (state.attachments.some((attachment) => attachment?.inlayId === anticipatedId)) {
                        conflict('Inlay is already attached to this message')
                    }
                    const metadataEntry = request.input.messageMetadata[0]
                    Object.defineProperty(state.metadata, metadataEntry.key, {
                        value: cloneJson(metadataEntry.value), enumerable: true, configurable: true, writable: true,
                    })
                    state.attachments.push({
                        inlayId: anticipatedId,
                        presentation: 'inline',
                        metadata: cloneJson(request.input.attachmentMetadata),
                    })
                    validateCallerState(state)

                    try {
                        staged = await dependencies.stageAtomicInlay(request.input.data.slice(), {
                            name: request.input.inlay.name,
                            idempotencyKey: request.input.idempotencyKey,
                            argumentDigest: request.argumentDigest,
                            target: { ...request.input.target },
                            inputRevision: request.input.expectedMessageRevision,
                            beforeMutation: () => ensureCaptureCurrent(dependencies, request, capture),
                        })
                    } catch (error) {
                        return rejectAfterCaptureFailure(
                            dependencies, request, capture, error, 'Atomic Inlay staging',
                        )
                    }
                    ensureCaptureCurrent(dependencies, request, capture)
                    if (staged.id !== anticipatedId || staged.name !== request.input.inlay.name
                        || !nonEmptyString(staged.revision)) {
                        throw new PluginApiError('INTERNAL', 'Atomic Inlay lifecycle returned an invalid descriptor', {
                            retryable: true,
                        })
                    }

                    const completedAt = now()
                    state.updatedAt = completedAt
                    const stagedChat = safeStructuredClone(capture.conversation)
                    const stagedMessage = stagedChat.message[capture.messageIndex]
                    stagedMessage.data = `${stagedMessage.data.slice(0, rawOffset)}{{inlay::${staged.id}}}${stagedMessage.data.slice(rawOffset)}`
                    stagedMessage.pluginMessageState = {
                        ...(stagedMessage.pluginMessageState ?? {}),
                        [request.principalId]: state,
                    }
                    stagedMessage.pluginMessageUpdatedAt = completedAt
                    const recognized = new Set([...known, staged.id])
                    let message: MessageSnapshot
                    try {
                        message = await snapshot(capture, stagedMessage, request, recognized, revision)
                    } catch (error) {
                        return rejectAfterCaptureFailure(
                            dependencies, request, capture, error, 'Message snapshot',
                        )
                    }
                    ensureCaptureCurrent(dependencies, request, capture)
                    const result: InlayAtomicAttachResult = {
                        inlay: cloneJson(staged),
                        message,
                        commitId: createId(),
                    }
                    const receipt: PersistedAtomicReceipt = {
                        version: 1,
                        principalId: request.principalId,
                        operation: OPERATION,
                        idempotencyKey: request.input.idempotencyKey,
                        digest: request.argumentDigest,
                        target: { ...request.input.target },
                        result: cloneJson(result),
                        completedAt,
                    }
                    stagedChat.pluginAtomicAttachReceipts = appendReceipt(activeReceipts, receipt)

                    persistenceRequested = true
                    try {
                        await dependencies.saveChatToServer(
                            request.input.target.characterId,
                            capture.conversationIndex,
                            request.input.target.conversationId,
                            stagedChat,
                        )
                    } catch (error) {
                        return rejectAfterCaptureFailure(
                            dependencies, request, capture, error, 'Message persistence',
                        )
                    }
                    ensureCaptureCurrent(dependencies, request, capture)
                    capture.chats[capture.conversationIndex] = stagedChat
                    return { ok: true, result: cloneJson(result) }
                } catch (error) {
                    if (persistenceRequested) throw error
                    return { ok: false, error }
                }
            })
            if (outcome.ok === false) {
                if (staged && !persistenceRequested) {
                    try {
                        await dependencies.deleteInlay(staged.id, { expectedRevision: staged.revision })
                    } catch {
                        // Preserve the primary known failure; deterministic staging remains retryable.
                    }
                }
                throw outcome.error
            }
            return outcome.result
        },
    }
}

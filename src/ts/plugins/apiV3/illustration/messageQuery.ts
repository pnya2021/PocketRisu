import { PluginApiError } from './errors'
import type { PluginExecutionContext, PluginPermissionId } from './permissions'
import { canonicalJson, createRevision, validateJsonLimits } from './revision'

export const MESSAGE_QUERY_CAPABILITY_IDS = ['chat.message-query.v1'] as const

const DEFAULT_RECENT_LIMIT = 8
const MAX_RECENT_LIMIT = 32
const DEFAULT_RECENT_UTF16 = 12_000
const MAX_RECENT_UTF16 = 65_536
const MAX_SNAPSHOT_UTF16 = 262_144
const MAX_SNAPSHOT_JSON_BYTES = 2_097_152
const MAX_CALLER_METADATA_JSON_BYTES = 65_536
export const MAX_CALLER_ATTACHMENTS = 256

export type PluginJsonValue =
    | null
    | boolean
    | number
    | string
    | PluginJsonValue[]
    | { [key: string]: PluginJsonValue }

export interface MessageCallerAttachmentSnapshot {
    inlayId: string
    presentation: 'inline'
    utf16Offset: number
    metadata?: PluginJsonValue
}

export interface LogicalInlayMarker {
    id: string
    rawStart: number
    rawEnd: number
    utf16Offset: number
}

export interface LogicalMessageProjection {
    content: string
    markers: LogicalInlayMarker[]
}

export type LogicalMessagePlacement =
    | { kind: 'end' }
    | { kind: 'utf16-offset'; offset: number }

export interface MessageRef {
    characterId: string
    conversationId: string
    messageId: string
}

export interface MessageSnapshot extends MessageRef {
    role: 'user' | 'char'
    speakerCharacterId?: string
    content: string
    revision: string
    generationId?: string
    createdAt?: number
    updatedAt: number
    callerPluginState: {
        metadata: Record<string, PluginJsonValue>
        attachments: MessageCallerAttachmentSnapshot[]
    }
}

export interface MessageQuerySourceMessage {
    role?: unknown
    data?: unknown
    messageId?: unknown
    speakerSourceId?: unknown
    generationId?: unknown
    createdAt?: unknown
    updatedAt?: unknown
    pluginMessageState?: unknown
    pluginMessageUpdatedAt?: unknown
}

export interface MessageQueryConversation {
    characterId: string
    conversationId: string
    currentCharacterId: string
    memberCharacterIds?: readonly string[]
    isStreaming?: boolean
    messages: readonly MessageQuerySourceMessage[]
    validationToken: unknown
}

export interface MessageQueryHostAdapter {
    current(): { characterId: string; conversationId: string } | null
    prepareConversation(target: { characterId: string; conversationId: string }): Promise<void>
    resolveConversation(target: { characterId: string; conversationId: string }): MessageQueryConversation | null
    isConversationCurrent(conversation: MessageQueryConversation): boolean
    recognizedInlayIds(): Promise<ReadonlySet<string>>
}

type ReadPermission = 'chatObserve' | 'chatObserveAll'
type ConversationTarget = Pick<MessageRef, 'characterId' | 'conversationId'>

const nonEmptyString = (value: unknown): value is string => typeof value === 'string' && value.length > 0
const stableMessageId = (value: unknown): value is string =>
    nonEmptyString(value) && !value.startsWith('legacy-message:')

const invalidArgument = (message: string): never => {
    throw new PluginApiError('INVALID_ARGUMENT', message)
}

const conflict = (): never => {
    throw new PluginApiError('CONFLICT', 'Message changed; retry the query', { retryable: true })
}

const notFound = (): never => {
    throw new PluginApiError('NOT_FOUND', 'Message or conversation was not found')
}

const normalizeConversationTarget = (value: unknown): ConversationTarget => {
    if (!value || typeof value !== 'object') invalidArgument('Invalid conversation target')
    const candidate = value as Partial<ConversationTarget>
    if (!nonEmptyString(candidate.characterId) || !nonEmptyString(candidate.conversationId)) {
        invalidArgument('Stable characterId and conversationId are required')
    }
    return { characterId: candidate.characterId, conversationId: candidate.conversationId }
}

const normalizeMessageRef = (value: unknown): MessageRef => {
    const conversation = normalizeConversationTarget(value)
    const candidate = value as Partial<MessageRef>
    if (!nonEmptyString(candidate.messageId)) invalidArgument('Stable messageId is required')
    if (!stableMessageId(candidate.messageId)) conflict()
    return { ...conversation, messageId: candidate.messageId }
}

const normalizeRoles = (value: unknown): Array<'user' | 'char'> => {
    if (value === undefined) return ['user', 'char']
    if (!Array.isArray(value) || value.length === 0
        || value.some((role) => role !== 'user' && role !== 'char')) {
        invalidArgument('roles must contain user and/or char')
    }
    return [...new Set(value as Array<'user' | 'char'>)]
}

const recognizedMarker = /\{\{(?:inlay|inlayed|inlayeddata)::([^{}]+)\}\}/gu

export const projectLogicalContent = (
    raw: string,
    recognized: ReadonlySet<string>,
): LogicalMessageProjection => {
    let rawCursor = 0
    let content = ''
    const markers: LogicalInlayMarker[] = []
    for (const match of raw.matchAll(recognizedMarker)) {
        const token = match[0]
        const id = match[1]
        const rawStart = match.index ?? 0
        if (!recognized.has(id)) continue
        content += raw.slice(rawCursor, rawStart)
        const rawEnd = rawStart + token.length
        markers.push({ id, rawStart, rawEnd, utf16Offset: content.length })
        rawCursor = rawEnd
    }
    content += raw.slice(rawCursor)
    return { content, markers }
}

export const resolveLogicalInsertionOffset = (
    raw: string,
    recognized: ReadonlySet<string>,
    placement: LogicalMessagePlacement,
): number | null => {
    const projection = projectLogicalContent(raw, recognized)
    const offset = placement.kind === 'end' ? projection.content.length : placement.offset
    if (!Number.isInteger(offset) || offset < 0 || offset > projection.content.length) return null
    const previous = offset > 0 ? projection.content.charCodeAt(offset - 1) : 0
    const next = offset < projection.content.length ? projection.content.charCodeAt(offset) : 0
    if (previous >= 0xd800 && previous <= 0xdbff && next >= 0xdc00 && next <= 0xdfff) return null
    const cluster = projection.markers.filter((marker) => marker.utf16Offset === offset)
    if (cluster.length > 0) return cluster[cluster.length - 1].rawEnd

    let rawCursor = 0
    let logicalCursor = 0
    for (const marker of projection.markers) {
        const literalLength = marker.rawStart - rawCursor
        if (offset <= logicalCursor + literalLength) return rawCursor + offset - logicalCursor
        logicalCursor += literalLength
        rawCursor = marker.rawEnd
    }
    return rawCursor + offset - logicalCursor
}

const cloneAttachmentMetadata = (value: unknown): PluginJsonValue | undefined => {
    if (value === undefined) return undefined
    try {
        return JSON.parse(validateJsonLimits(value, {
            maxDepth: 32, maxBytes: MAX_CALLER_METADATA_JSON_BYTES,
        })) as PluginJsonValue
    } catch {
        return undefined
    }
}

export const projectCallerAttachments = (
    raw: string,
    recognized: ReadonlySet<string>,
    attachments: unknown,
): MessageCallerAttachmentSnapshot[] => {
    if (!Array.isArray(attachments)) return []
    const managed = new Map<string, { metadata?: PluginJsonValue }>()
    for (const attachment of attachments) {
        if (!plainRecord(attachment) || !nonEmptyString(attachment.inlayId)
            || attachment.presentation !== 'inline' || !recognized.has(attachment.inlayId)
            || managed.has(attachment.inlayId)) continue
        if (attachment.metadata !== undefined && cloneAttachmentMetadata(attachment.metadata) === undefined) continue
        const metadata = cloneAttachmentMetadata(attachment.metadata)
        managed.set(attachment.inlayId, metadata === undefined ? {} : { metadata })
    }
    const result: MessageCallerAttachmentSnapshot[] = []
    const emitted = new Set<string>()
    for (const marker of projectLogicalContent(raw, recognized).markers) {
        const attachment = managed.get(marker.id)
        if (!attachment || emitted.has(marker.id)) continue
        emitted.add(marker.id)
        result.push({
            inlayId: marker.id,
            presentation: 'inline',
            utf16Offset: marker.utf16Offset,
            ...attachment,
        })
    }
    return result
}

const isCurrent = (adapter: MessageQueryHostAdapter, target: ConversationTarget) => {
    const current = adapter.current()
    return current?.characterId === target.characterId && current.conversationId === target.conversationId
}

const committed = (conversation: MessageQueryConversation, index: number) =>
    !(conversation.isStreaming === true
        && index === conversation.messages.length - 1
        && conversation.messages[index]?.role === 'char')

const finiteTimestamp = (value: unknown): value is number =>
    typeof value === 'number' && Number.isFinite(value)

const plainRecord = (value: unknown): value is Record<string, unknown> => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return false
    const prototype = Object.getPrototypeOf(value)
    return prototype === Object.prototype || prototype === null
}

const callerMetadata = (message: MessageQuerySourceMessage, principalId: string) => {
    const root = message.pluginMessageState
    if (root === undefined) return {} as Record<string, PluginJsonValue>
    if (!plainRecord(root)) throw new PluginApiError('INTERNAL', 'Plugin message state is invalid', { retryable: true })
    const state = Object.getOwnPropertyDescriptor(root, principalId)?.value
    if (state === undefined) return {} as Record<string, PluginJsonValue>
    if (!plainRecord(state) || !plainRecord(state.metadata)) {
        throw new PluginApiError('INTERNAL', 'Caller message state is invalid', { retryable: true })
    }
    const canonical = validateJsonLimits(state.metadata, {
        maxDepth: 32, maxBytes: MAX_CALLER_METADATA_JSON_BYTES,
    })
    return JSON.parse(canonical) as Record<string, PluginJsonValue>
}

const messageRevisionValue = (message: MessageQuerySourceMessage) => ({
    role: message.role,
    data: message.data,
    saying: typeof message.speakerSourceId === 'string' ? message.speakerSourceId : null,
    generationId: typeof message.generationId === 'string' ? message.generationId : null,
    pluginMessageState: message.pluginMessageState ?? {},
})

export class MessageQueryService {
    private readonly requirePermission: (
        context: PluginExecutionContext,
        permission: PluginPermissionId,
    ) => Promise<void>
    private readonly revision: (value: unknown) => Promise<string>

    constructor(
        private readonly context: PluginExecutionContext,
        private readonly adapter: MessageQueryHostAdapter,
        options: {
            requirePermission: (context: PluginExecutionContext, permission: PluginPermissionId) => Promise<void>
            createRevision?: (value: unknown) => Promise<string>
        },
    ) {
        this.requirePermission = options.requirePermission
        this.revision = options.createRevision ?? createRevision
    }

    private ensureActive() {
        if (this.context.signal.aborted) throw new PluginApiError('ABORTED', 'Operation aborted')
    }

    private ensureConversation(conversation: MessageQueryConversation) {
        if (!this.adapter.isConversationCurrent(conversation)) conflict()
    }

    private rejectDependency(error: unknown): never {
        this.ensureActive()
        if (error instanceof PluginApiError) throw error
        throw new PluginApiError('INTERNAL', 'Message query dependency failed', { retryable: true })
    }

    private async requestPermission(permission: ReadPermission) {
        try {
            await this.requirePermission(this.context, permission)
        } catch (error) {
            this.rejectDependency(error)
        }
        this.ensureActive()
    }

    private async authorize(target: ConversationTarget): Promise<ReadPermission> {
        this.ensureActive()
        let permission: ReadPermission = isCurrent(this.adapter, target) ? 'chatObserve' : 'chatObserveAll'
        await this.requestPermission(permission)
        if (permission === 'chatObserve' && !isCurrent(this.adapter, target)) {
            await this.requestPermission('chatObserveAll')
            permission = 'chatObserveAll'
        }
        return permission
    }

    private async ensureScope(
        target: ConversationTarget,
        permission: ReadPermission,
        conversation?: MessageQueryConversation,
    ): Promise<ReadPermission> {
        this.ensureActive()
        if (conversation) this.ensureConversation(conversation)
        if (permission === 'chatObserveAll' || isCurrent(this.adapter, target)) return permission
        try {
            await this.requestPermission('chatObserveAll')
        } catch (error) {
            this.ensureActive()
            if (conversation) this.ensureConversation(conversation)
            throw error
        }
        if (conversation) this.ensureConversation(conversation)
        return 'chatObserveAll'
    }

    private async open(target: ConversationTarget) {
        let permission = await this.authorize(target)
        try {
            await this.adapter.prepareConversation({
                characterId: target.characterId,
                conversationId: target.conversationId,
            })
        } catch (error) {
            this.ensureActive()
            if (error instanceof PluginApiError) throw error
            conflict()
        }
        this.ensureActive()
        permission = await this.ensureScope(target, permission)
        const conversation = this.adapter.resolveConversation(target)
        if (!conversation) notFound()
        this.ensureConversation(conversation)
        return { conversation, permission }
    }

    private exactIndex(conversation: MessageQueryConversation, messageId: string) {
        const matches = conversation.messages.flatMap((message, index) =>
            message.messageId === messageId ? [index] : [])
        if (matches.length === 0) notFound()
        if (matches.length !== 1) conflict()
        return matches[0]
    }

    private stableIndex(conversation: MessageQueryConversation, index: number): string {
        const id = conversation.messages[index]?.messageId
        if (!stableMessageId(id)) conflict()
        const messageId = id as string
        if (conversation.messages.filter((message) => message.messageId === messageId).length !== 1) conflict()
        return messageId
    }

    private validateSource(message: MessageQuerySourceMessage) {
        if ((message.role !== 'user' && message.role !== 'char') || typeof message.data !== 'string') conflict()
    }

    private speaker(
        conversation: MessageQueryConversation,
        message: MessageQuerySourceMessage,
    ) {
        if (message.role !== 'char') return undefined
        if (conversation.memberCharacterIds) {
            return nonEmptyString(message.speakerSourceId)
                && conversation.memberCharacterIds.includes(message.speakerSourceId)
                ? message.speakerSourceId
                : undefined
        }
        return nonEmptyString(conversation.currentCharacterId) ? conversation.currentCharacterId : undefined
    }

    private ensureSnapshotLimits(snapshot: MessageSnapshot) {
        const details = {
            contentUtf16: snapshot.content.length,
            callerAttachmentCount: snapshot.callerPluginState.attachments.length,
        }
        if (snapshot.content.length > MAX_SNAPSHOT_UTF16) {
            throw new PluginApiError('RESOURCE_LIMIT', 'Message content exceeds snapshot limit', { details })
        }
        if (new TextEncoder().encode(JSON.stringify(snapshot)).byteLength > MAX_SNAPSHOT_JSON_BYTES) {
            throw new PluginApiError('RESOURCE_LIMIT', 'Message snapshot exceeds serialized limit', { details })
        }
    }

    private async recognized(
        target: ConversationTarget,
        conversation: MessageQueryConversation,
        permission: ReadPermission,
    ) {
        let ids: ReadonlySet<string>
        try {
            ids = await this.adapter.recognizedInlayIds()
        } catch (error) {
            return this.rejectAfterAsyncFailure(target, conversation, permission, error)
        }
        this.ensureActive()
        this.ensureConversation(conversation)
        const nextPermission = await this.ensureScope(target, permission, conversation)
        this.ensureConversation(conversation)
        return { ids, permission: nextPermission }
    }

    private async rejectAfterAsyncFailure(
        target: ConversationTarget,
        conversation: MessageQueryConversation,
        permission: ReadPermission,
        error: unknown,
    ): Promise<never> {
        this.ensureActive()
        this.ensureConversation(conversation)
        await this.ensureScope(target, permission, conversation)
        this.ensureConversation(conversation)
        if (error instanceof PluginApiError) throw error
        throw new PluginApiError('INTERNAL', 'Message query dependency failed', { retryable: true })
    }

    private async snapshot(
        conversation: MessageQueryConversation,
        index: number,
        recognized: ReadonlySet<string>,
        permission: ReadPermission,
    ): Promise<{ snapshot: MessageSnapshot; permission: ReadPermission }> {
        this.ensureConversation(conversation)
        if (!committed(conversation, index)) conflict()
        const message = conversation.messages[index]
        this.validateSource(message)
        const messageId = this.stableIndex(conversation, index)
        const raw = message.data as string
        const role = message.role as 'user' | 'char'
        const generationId = nonEmptyString(message.generationId) ? message.generationId : null
        let revision: string
        try {
            revision = await this.revision(messageRevisionValue(message))
        } catch (error) {
            return this.rejectAfterAsyncFailure(conversation, conversation, permission, error)
        }
        this.ensureActive()
        this.ensureConversation(conversation)
        permission = await this.ensureScope(conversation, permission, conversation)
        this.ensureConversation(conversation)
        const createdAt = finiteTimestamp(message.createdAt) ? message.createdAt : undefined
        const stateRoot = plainRecord(message.pluginMessageState) ? message.pluginMessageState : undefined
        const callerState = stateRoot && plainRecord(Object.getOwnPropertyDescriptor(stateRoot, this.context.principalId)?.value)
            ? Object.getOwnPropertyDescriptor(stateRoot, this.context.principalId)!.value as Record<string, unknown>
            : undefined
        const updatedAt = Math.max(
            finiteTimestamp(message.updatedAt) ? message.updatedAt : createdAt ?? 0,
            finiteTimestamp(message.pluginMessageUpdatedAt) ? message.pluginMessageUpdatedAt : 0,
            finiteTimestamp(callerState?.updatedAt) ? callerState.updatedAt : 0,
        )
        const snapshot: MessageSnapshot = {
            characterId: conversation.characterId,
            conversationId: conversation.conversationId,
            messageId,
            role,
            content: projectLogicalContent(raw, recognized).content,
            revision,
            updatedAt,
            callerPluginState: {
                metadata: callerMetadata(message, this.context.principalId),
                attachments: projectCallerAttachments(
                    raw,
                    recognized,
                    callerState?.attachments,
                ),
            },
        }
        const speakerCharacterId = this.speaker(conversation, message)
        if (speakerCharacterId) snapshot.speakerCharacterId = speakerCharacterId
        if (generationId !== null) snapshot.generationId = generationId
        if (createdAt !== undefined) snapshot.createdAt = createdAt
        this.ensureSnapshotLimits(snapshot)
        return { snapshot, permission }
    }

    async getMessageSnapshot(rawTarget: MessageRef): Promise<MessageSnapshot> {
        const target = normalizeMessageRef(rawTarget)
        const opened = await this.open(target)
        const index = this.exactIndex(opened.conversation, target.messageId)
        const projection = await this.recognized(target, opened.conversation, opened.permission)
        const result = await this.snapshot(opened.conversation, index, projection.ids, projection.permission)
        return result.snapshot
    }

    async getLatestCommittedMessage(rawOptions: {
        characterId?: string
        conversationId?: string
        role?: 'user' | 'char'
    } = {}): Promise<MessageSnapshot | null> {
        if (!rawOptions || typeof rawOptions !== 'object') invalidArgument('Invalid latest-message options')
        const current = this.adapter.current()
        const target = normalizeConversationTarget({
            characterId: rawOptions.characterId ?? current?.characterId,
            conversationId: rawOptions.conversationId ?? current?.conversationId,
        })
        const role = rawOptions.role ?? 'char'
        if (role !== 'user' && role !== 'char') invalidArgument('Invalid message role')
        const opened = await this.open(target)
        let index = -1
        for (let candidate = opened.conversation.messages.length - 1; candidate >= 0; candidate--) {
            const message = opened.conversation.messages[candidate]
            if (message.role !== role || !committed(opened.conversation, candidate)) continue
            this.validateSource(message)
            this.stableIndex(opened.conversation, candidate)
            index = candidate
            break
        }
        if (index < 0) return null
        const projection = await this.recognized(target, opened.conversation, opened.permission)
        const result = await this.snapshot(opened.conversation, index, projection.ids, projection.permission)
        return result.snapshot
    }

    async getRecentCommittedMessages(rawOptions: {
        before: MessageRef
        roles?: Array<'user' | 'char'>
        limit?: number
        maxTotalUtf16?: number
    }): Promise<{ items: MessageSnapshot[]; truncatedBefore: boolean }> {
        if (!rawOptions || typeof rawOptions !== 'object') invalidArgument('Recent-message options are required')
        const before = normalizeMessageRef(rawOptions.before)
        const roles = normalizeRoles(rawOptions.roles)
        const limit = rawOptions.limit ?? DEFAULT_RECENT_LIMIT
        const maxTotalUtf16 = rawOptions.maxTotalUtf16 ?? DEFAULT_RECENT_UTF16
        if (!Number.isInteger(limit) || limit < 1) invalidArgument('limit must be a positive integer')
        if (limit > MAX_RECENT_LIMIT) throw new PluginApiError('RESOURCE_LIMIT', 'Recent message limit exceeds capability')
        if (!Number.isInteger(maxTotalUtf16) || maxTotalUtf16 < 1) invalidArgument('maxTotalUtf16 must be a positive integer')
        if (maxTotalUtf16 > MAX_RECENT_UTF16) throw new PluginApiError('RESOURCE_LIMIT', 'Recent UTF-16 budget exceeds capability')

        const opened = await this.open(before)
        const beforeIndex = this.exactIndex(opened.conversation, before.messageId)
        if (!committed(opened.conversation, beforeIndex)) conflict()
        const projection = await this.recognized(before, opened.conversation, opened.permission)
        let permission = projection.permission
        const nearest: MessageSnapshot[] = []
        let totalUtf16 = 0
        let truncatedBefore = false
        for (let index = beforeIndex - 1; index >= 0; index--) {
            const message = opened.conversation.messages[index]
            if (!roles.includes(message.role as 'user' | 'char') || !committed(opened.conversation, index)) continue
            this.validateSource(message)
            this.stableIndex(opened.conversation, index)
            if (nearest.length >= limit) {
                truncatedBefore = true
                break
            }
            const result = await this.snapshot(opened.conversation, index, projection.ids, permission)
            permission = result.permission
            if (result.snapshot.content.length > maxTotalUtf16 - totalUtf16) {
                truncatedBefore = true
                break
            }
            nearest.push(result.snapshot)
            totalUtf16 += result.snapshot.content.length
        }
        permission = await this.ensureScope(before, permission, opened.conversation)
        this.ensureConversation(opened.conversation)
        nearest.reverse()
        return { items: nearest, truncatedBefore }
    }
}

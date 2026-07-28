import type { Chat, Message } from '../../../storage/database.svelte'
import { safeStructuredClone } from '../../../polyfill'
import {
    captureMessageSnapshotSource,
    deriveMessageSnapshotRevision,
    projectCapturedMessageSnapshot,
    type MessageQuerySourceMessage,
} from './messageQuery'
import {
    CommittedMessageEventService,
    type InternalMessageCommit,
    type MessageCommitCause,
} from './messageEvents'
import { PluginApiError } from './errors'
import type { PluginExecutionContext, PluginPermissionId } from './permissions'
import { canonicalJson } from './revision'

type UnknownRecord = Record<string, any>

const clone = <T>(value: T): T => safeStructuredClone(value)
const nonEmptyString = (value: unknown): value is string => typeof value === 'string' && value.length > 0

const markerFor = (raw: string, inlayId: string) => {
    const escaped = inlayId.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    const match = raw.match(new RegExp(`\\{\\{(?:inlay|inlayed|inlayeddata)::${escaped}\\}\\}`, 'u'))
    return match?.[0] ?? `{{inlay::${inlayId}}}`
}

const attachmentIds = (message: UnknownRecord) => {
    const ids: string[] = []
    const seen = new Set<string>()
    const root = message.pluginMessageState
    if (!root || typeof root !== 'object' || Array.isArray(root)) return ids
    for (const state of Object.values(root)) {
        if (!state || typeof state !== 'object' || !Array.isArray((state as UnknownRecord).attachments)) continue
        for (const attachment of (state as UnknownRecord).attachments) {
            const id = attachment?.inlayId
            if (!nonEmptyString(id) || seen.has(id)) continue
            seen.add(id)
            ids.push(id)
        }
    }
    return ids
}

const clampOwnedMarkersToEnd = (before: UnknownRecord, replacementData: string) => {
    let data = replacementData
    for (const id of attachmentIds(before)) {
        const marker = markerFor(before.data ?? '', id)
        if (new RegExp(`\\{\\{(?:inlay|inlayed|inlayeddata)::${id.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\}\\}`, 'u').test(data)) {
            continue
        }
        data += marker
    }
    return data
}

const copyStableCallerState = (before: UnknownRecord, replacement: UnknownRecord, now: number) => {
    const corrected: UnknownRecord = {
        ...replacement,
        data: clampOwnedMarkersToEnd(before, typeof replacement.data === 'string' ? replacement.data : ''),
        chatId: before.chatId,
        time: before.time,
        pluginMessageUpdatedAt: now,
    }
    if (before.pluginMessageState === undefined) delete corrected.pluginMessageState
    else corrected.pluginMessageState = clone(before.pluginMessageState)
    return corrected
}

export function correctContinueMessageIdentity<TBefore extends UnknownRecord, TReplacement extends UnknownRecord>(
    before: TBefore,
    replacement: TReplacement,
    now = Date.now(),
): TReplacement & UnknownRecord {
    const corrected = copyStableCallerState(before, replacement, now)
    if (before.saying === undefined) delete corrected.saying
    else corrected.saying = before.saying
    const replacementGeneration = replacement.generationInfo && typeof replacement.generationInfo === 'object'
        ? replacement.generationInfo
        : undefined
    const originalGenerationId = before.generationInfo?.generationId
    if (replacementGeneration || nonEmptyString(originalGenerationId)) {
        corrected.generationInfo = {
            ...(replacementGeneration ?? {}),
            ...(nonEmptyString(originalGenerationId) ? { generationId: originalGenerationId } : {}),
        }
    }
    return corrected as TReplacement & UnknownRecord
}

export function correctRerollMessageIdentity<TBefore extends UnknownRecord, TReplacement extends UnknownRecord>(
    before: TBefore,
    replacement: TReplacement,
    now = Date.now(),
): TReplacement & UnknownRecord {
    return copyStableCallerState(before, replacement, now) as TReplacement & UnknownRecord
}

const sourceMessage = (message: UnknownRecord): MessageQuerySourceMessage => ({
    role: message.role,
    data: message.data,
    messageId: message.chatId,
    speakerSourceId: message.saying,
    generationId: message.generationInfo?.generationId,
    createdAt: message.time,
    updatedAt: Math.max(
        typeof message.time === 'number' && Number.isFinite(message.time) ? message.time : 0,
        typeof message.pluginMessageUpdatedAt === 'number' && Number.isFinite(message.pluginMessageUpdatedAt)
            ? message.pluginMessageUpdatedAt
            : 0,
    ),
    pluginMessageState: message.pluginMessageState,
    pluginMessageUpdatedAt: message.pluginMessageUpdatedAt,
})

const exactCharacter = (database: UnknownRecord, characterId: string) => {
    const characters = Array.isArray(database?.characters) ? database.characters : []
    const matches = characters.flatMap((character: UnknownRecord, index: number) =>
        character?.chaId === characterId ? [{ character, index }] : [])
    return matches.length === 1 ? { characters, ...matches[0] } : null
}

const exactConversation = (character: UnknownRecord, conversationId: string) => {
    const chats = Array.isArray(character?.chats) ? character.chats : []
    const matches = chats.flatMap((chat: UnknownRecord, index: number) =>
        chat?.id === conversationId ? [{ chat, index }] : [])
    return matches.length === 1 ? { chats, ...matches[0] } : null
}

const exactMessage = (chat: UnknownRecord, messageId: string) => {
    const messages = Array.isArray(chat?.message) ? chat.message : []
    const matches = messages.filter((message: UnknownRecord) => message?.chatId === messageId)
    return matches.length === 1 ? matches[0] : null
}

export interface PocketCommitInput {
    characterId: string
    conversationId: string
    commits: Array<{
        message: Message | UnknownRecord
        change: 'created' | 'updated'
        cause: Extract<MessageCommitCause, 'model' | 'continue' | 'reroll' | 'trigger'>
    }>
}

export type PocketMessageBaseline = Map<string, {
    index: number
    revisionKey: string
    message: Message
}>

export const pocketMessageRevisionKey = (message: Message | UnknownRecord) => canonicalJson({
    role: message.role,
    data: message.data,
    saying: typeof message.saying === 'string' ? message.saying : null,
    generationId: typeof message.generationInfo?.generationId === 'string'
        ? message.generationInfo.generationId
        : null,
    pluginMessageState: message.pluginMessageState ?? {},
})

export function capturePocketMessageBaseline(messages: readonly Message[]): PocketMessageBaseline {
    const result: PocketMessageBaseline = new Map()
    messages.forEach((message, index) => {
        if (message.role !== 'char' || !nonEmptyString(message.chatId) || result.has(message.chatId)) return
        result.set(message.chatId, {
            index,
            revisionKey: pocketMessageRevisionKey(message),
            message: clone(message),
        })
    })
    return result
}

export function collectPocketGeneratedCommits(input: {
    before: PocketMessageBaseline
    after: readonly Message[]
    mode: 'model' | 'continue' | 'reroll'
    continueMessageId?: string
    triggerMutatedMessageIds?: ReadonlySet<string>
}): PocketCommitInput['commits'] {
    const commits: PocketCommitInput['commits'] = []
    for (const message of input.after) {
        if (message.role !== 'char' || !nonEmptyString(message.chatId)) continue
        const baseline = input.before.get(message.chatId)
        if (baseline && baseline.revisionKey === pocketMessageRevisionKey(message)) continue
        const triggerMutated = input.triggerMutatedMessageIds?.has(message.chatId) === true
        const cause = triggerMutated || (!baseline && !nonEmptyString(message.generationInfo?.generationId))
            ? 'trigger'
            : input.mode === 'continue' && message.chatId === input.continueMessageId
                ? 'continue'
                : input.mode === 'reroll' && baseline
                    ? 'reroll'
                    : baseline
                        ? 'trigger'
                        : 'model'
        commits.push({ message, change: baseline ? 'updated' : 'created', cause })
    }
    return commits
}

export class PocketMessageEventRuntime {
    constructor(
        private readonly events: CommittedMessageEventService,
        private readonly dependencies: {
            getDatabase(): UnknownRecord
            listInlayKeys(): Promise<string[]>
            runExclusiveMutation<T>(operation: () => Promise<T>): Promise<T>
            saveChatToServer(characterId: string, chatIndex: number, conversationId: string, chat: Chat): Promise<void>
            createId?: () => string
            now?: () => number
        },
    ) {}

    async commitBatch(input: PocketCommitInput): Promise<void> {
        const commits = clone(input.commits)
        if (!nonEmptyString(input.characterId) || !nonEmptyString(input.conversationId) || commits.length === 0) return
        const candidates = commits.flatMap((entry) => nonEmptyString(entry.message?.chatId)
            && (entry.message.role === 'user' || entry.message.role === 'char')
            ? [{
                target: {
                    characterId: input.characterId,
                    conversationId: input.conversationId,
                    messageId: entry.message.chatId,
                },
                role: entry.message.role,
                cause: entry.cause,
            }]
            : [])
        if (candidates.length === 0 || !candidates.some((candidate) =>
            this.events.hasMatchingSubscriber(candidate, 'state')
            || this.events.hasMatchingSubscriber(candidate, 'persisted'))) return

        let recognized: string[]
        try {
            recognized = await this.dependencies.listInlayKeys()
        } catch {
            return
        }
        if (!Array.isArray(recognized) || recognized.some((id) => typeof id !== 'string')) return
        const root = this.dependencies.getDatabase()
        const locatedCharacter = exactCharacter(root, input.characterId)
        const memberCharacterIds = locatedCharacter?.character?.type === 'group'
            && Array.isArray(locatedCharacter.character.characters)
            ? locatedCharacter.character.characters.filter(nonEmptyString)
            : undefined
        const prepared: InternalMessageCommit[] = []
        const capturedRevisionKeys = new Map<string, string>()
        for (const entry of commits) {
            const message = sourceMessage(entry.message)
            if (!nonEmptyString(message.messageId) || (message.role !== 'user' && message.role !== 'char')) continue
            let source
            let revision: string
            try {
                source = captureMessageSnapshotSource({
                    characterId: input.characterId,
                    conversationId: input.conversationId,
                    currentCharacterId: input.characterId,
                    ...(memberCharacterIds ? { memberCharacterIds } : {}),
                    message,
                    recognizedInlayIds: recognized,
                })
                revision = await deriveMessageSnapshotRevision(source.message)
            } catch {
                continue
            }
            const eventId = this.dependencies.createId?.() ?? crypto.randomUUID()
            prepared.push({
                eventId,
                target: {
                    characterId: input.characterId,
                    conversationId: input.conversationId,
                    messageId: message.messageId,
                },
                revision,
                role: message.role,
                change: entry.change,
                cause: entry.cause,
                durability: 'state',
                snapshotSource: source,
            })
            capturedRevisionKeys.set(eventId, pocketMessageRevisionKey(entry.message))
        }
        if (prepared.length === 0) return

        for (const commit of prepared) {
            if (this.events.hasMatchingSubscriber(commit, 'state')) this.events.publish(commit)
        }
        if (!prepared.some((commit) => this.events.hasMatchingSubscriber(commit, 'persisted'))) return

        let persisted = false
        try {
            persisted = await this.dependencies.runExclusiveMutation(async () => {
                if (!prepared.some((commit) => this.events.hasMatchingSubscriber(commit, 'persisted'))) return false
                const liveRoot = this.dependencies.getDatabase()
                const character = exactCharacter(liveRoot, input.characterId)
                if (!character) return false
                const conversation = exactConversation(character.character, input.conversationId)
                if (!conversation || conversation.chat?._placeholder === true) return false
                for (const commit of prepared) {
                    const live = exactMessage(conversation.chat, commit.target.messageId)
                    if (!live || pocketMessageRevisionKey(live) !== capturedRevisionKeys.get(commit.eventId)) return false
                }
                await this.dependencies.saveChatToServer(
                    input.characterId,
                    conversation.index,
                    input.conversationId,
                    conversation.chat as Chat,
                )
                const afterRoot = this.dependencies.getDatabase()
                const afterCharacter = exactCharacter(afterRoot, input.characterId)
                const afterConversation = afterCharacter
                    ? exactConversation(afterCharacter.character, input.conversationId)
                    : null
                if (!afterConversation || afterConversation.chat !== conversation.chat) return false
                for (const commit of prepared) {
                    const live = exactMessage(afterConversation.chat, commit.target.messageId)
                    if (!live || pocketMessageRevisionKey(live) !== capturedRevisionKeys.get(commit.eventId)) return false
                }
                return true
            })
        } catch {
            return
        }
        if (!persisted) return
        for (const commit of prepared) {
            if (!this.events.hasMatchingSubscriber(commit, 'persisted')) continue
            this.events.publish({ ...commit, durability: 'persisted' })
        }
    }
}

export interface PocketMessageEventConfiguration {
    getDatabase(): UnknownRecord
    getCurrentCharacter(): UnknownRecord | undefined
    listInlayKeys(): Promise<string[]>
    runExclusiveMutation<T>(operation: () => Promise<T>): Promise<T>
    saveChatToServer(characterId: string, chatIndex: number, conversationId: string, chat: Chat): Promise<void>
    requirePermission(context: PluginExecutionContext, permission: PluginPermissionId): Promise<void>
}

let configured: PocketMessageEventConfiguration | undefined
let defaultRuntime: PocketMessageEventRuntime | undefined

export const pocketCommittedMessageEvents = new CommittedMessageEventService({
    current: () => {
        const character = configured?.getCurrentCharacter()
        const characterId = character?.chaId
        const chatPage = character?.chatPage
        const conversationId = Number.isInteger(chatPage) ? character?.chats?.[chatPage]?.id : undefined
        return nonEmptyString(characterId) && nonEmptyString(conversationId)
            ? { characterId, conversationId }
            : null
    },
    requirePermission: (context, permission) => {
        if (!configured) throw new PluginApiError('INTERNAL', 'Message events are not configured', { retryable: true })
        return configured.requirePermission(context, permission)
    },
    projectSnapshot: (context, commit) => projectCapturedMessageSnapshot(
        commit.snapshotSource,
        context.principalId,
    ),
})

export function configurePocketMessageEvents(configuration: PocketMessageEventConfiguration) {
    configured = configuration
    defaultRuntime = new PocketMessageEventRuntime(pocketCommittedMessageEvents, configuration)
}

export function commitPocketMessageBatch(input: PocketCommitInput) {
    return defaultRuntime?.commitBatch(input) ?? Promise.resolve()
}

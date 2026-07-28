import { PluginApiError } from './errors'
import type {
    MessageQueryConversation,
    MessageQueryHostAdapter,
    MessageQuerySourceMessage,
} from './messageQuery'
import { canonicalJson } from './revision'

type UnknownRecord = Record<string, any>

export interface PocketMessageQueryDependencies {
    getDatabase(): { characters?: UnknownRecord[] }
    getCurrentCharacter(): UnknownRecord | undefined
    ensureChatHydrated(chats: any[], index: number, chaId: string): Promise<UnknownRecord | null>
    listInlayKeys(): Promise<string[]>
}

type MessageFieldSnapshot = {
    source: UnknownRecord
    role: unknown
    data: unknown
    saying: unknown
    chatId: unknown
    time: unknown
    generationInfo: unknown
    generationId: unknown
    pluginMessageState: unknown
    pluginMessageStateCanonical: string
    pluginMessageUpdatedAt: unknown
}

type PocketValidationToken = {
    capture: MessageQueryConversation
    root: object
    characters: UnknownRecord[]
    character: UnknownRecord
    characterIndex: number
    characterType: unknown
    declaredMemberIds: unknown[] | undefined
    resolvedMembers: ResolvedMember[]
    chats: UnknownRecord[]
    conversation: UnknownRecord
    conversationIndex: number
    isStreaming: unknown
    messages: UnknownRecord[]
    fields: MessageFieldSnapshot[]
}

type ResolvedMember = { id: string; card: UnknownRecord }

const conflict = (): never => {
    throw new PluginApiError('CONFLICT', 'Conversation changed; retry the query', { retryable: true })
}

const notFound = (): never => {
    throw new PluginApiError('NOT_FOUND', 'Conversation was not found')
}

const nonEmptyString = (value: unknown): value is string => typeof value === 'string' && value.length > 0

const exactCharacter = (root: { characters?: UnknownRecord[] }, characterId: string) => {
    const characters = root.characters
    if (!Array.isArray(characters)) notFound()
    const matches = characters.flatMap((character, index) =>
        character?.chaId === characterId ? [{ character, index }] : [])
    if (matches.length === 0) notFound()
    if (matches.length !== 1) conflict()
    return { characters, ...matches[0] }
}

const exactConversation = (character: UnknownRecord, conversationId: string) => {
    const chats = character?.chats
    if (!Array.isArray(chats)) notFound()
    const matches = chats.flatMap((conversation, index) =>
        conversation?.id === conversationId ? [{ conversation, index }] : [])
    if (matches.length === 0) notFound()
    if (matches.length !== 1) conflict()
    return { chats, ...matches[0] }
}

const sourceMessage = (message: UnknownRecord): MessageQuerySourceMessage => ({
    role: message?.role,
    data: message?.data,
    messageId: message?.chatId,
    speakerSourceId: message?.saying,
    generationId: message?.generationInfo?.generationId,
    createdAt: message?.time,
    updatedAt: Math.max(
        typeof message?.time === 'number' && Number.isFinite(message.time) ? message.time : 0,
        typeof message?.pluginMessageUpdatedAt === 'number' && Number.isFinite(message.pluginMessageUpdatedAt)
            ? message.pluginMessageUpdatedAt
            : 0,
    ),
    pluginMessageState: message?.pluginMessageState,
    pluginMessageUpdatedAt: message?.pluginMessageUpdatedAt,
})

const snapshotFields = (messages: UnknownRecord[]): MessageFieldSnapshot[] => messages.map((message) => ({
    source: message,
    role: message?.role,
    data: message?.data,
    saying: message?.saying,
    chatId: message?.chatId,
    time: message?.time,
    generationInfo: message?.generationInfo,
    generationId: message?.generationInfo?.generationId,
    pluginMessageState: message?.pluginMessageState,
    pluginMessageStateCanonical: canonicalJson(message?.pluginMessageState ?? {}),
    pluginMessageUpdatedAt: message?.pluginMessageUpdatedAt,
}))

const sameMembers = (current: unknown, baseline: unknown[] | undefined) => {
    if (baseline === undefined) return current === undefined
    return Array.isArray(current)
        && current.length === baseline.length
        && current.every((value, index) => value === baseline[index])
}

const resolveOrdinaryMembers = (
    characters: UnknownRecord[],
    declared: unknown,
): ResolvedMember[] => {
    if (!Array.isArray(declared)) return []
    const resolved: ResolvedMember[] = []
    const seen = new Set<string>()
    for (const id of declared) {
        if (!nonEmptyString(id) || seen.has(id)) continue
        seen.add(id)
        const matches = characters.filter((candidate) => candidate?.chaId === id)
        if (matches.length === 1 && matches[0]?.type === 'character') {
            resolved.push({ id, card: matches[0] })
        }
    }
    return resolved
}

const sameResolvedMembers = (current: ResolvedMember[], baseline: ResolvedMember[]) =>
    current.length === baseline.length
    && current.every((member, index) =>
        member.id === baseline[index].id && member.card === baseline[index].card)

export function createPocketMessageQueryAdapter(
    dependencies: PocketMessageQueryDependencies,
): MessageQueryHostAdapter {
    const ownedTokens = new WeakSet<object>()

    return {
        current() {
            const character = dependencies.getCurrentCharacter()
            const characterId = character?.chaId
            const chatPage = character?.chatPage
            if (!nonEmptyString(characterId) || !Number.isInteger(chatPage)) return null
            const conversationId = character?.chats?.[chatPage]?.id
            if (!nonEmptyString(conversationId)) return null
            return { characterId, conversationId }
        },

        async prepareConversation(target) {
            const root = dependencies.getDatabase()
            if (!root || typeof root !== 'object') notFound()
            const locatedCharacter = exactCharacter(root, target.characterId)
            const locatedConversation = exactConversation(locatedCharacter.character, target.conversationId)
            const initialIndex = locatedConversation.index
            let hydrated: UnknownRecord | null
            try {
                hydrated = await dependencies.ensureChatHydrated(
                    locatedConversation.chats,
                    initialIndex,
                    target.characterId,
                )
            } catch (error) {
                if (error instanceof PluginApiError) throw error
                conflict()
            }
            if (dependencies.getDatabase() !== root
                || root.characters !== locatedCharacter.characters
                || locatedCharacter.characters[locatedCharacter.index] !== locatedCharacter.character
                || locatedCharacter.character.chats !== locatedConversation.chats) conflict()
            let currentConversation: ReturnType<typeof exactConversation>
            try {
                currentConversation = exactConversation(locatedCharacter.character, target.conversationId)
            } catch {
                conflict()
            }
            if (currentConversation.index !== initialIndex
                || currentConversation.conversation !== hydrated
                || !hydrated
                || hydrated._placeholder === true
                || !Array.isArray(hydrated.message)) conflict()
        },

        resolveConversation(target) {
            const root = dependencies.getDatabase()
            if (!root || typeof root !== 'object') return null
            let locatedCharacter: ReturnType<typeof exactCharacter>
            let locatedConversation: ReturnType<typeof exactConversation>
            try {
                locatedCharacter = exactCharacter(root, target.characterId)
                locatedConversation = exactConversation(locatedCharacter.character, target.conversationId)
            } catch (error) {
                if (error instanceof PluginApiError && error.code === 'NOT_FOUND') return null
                throw error
            }
            const conversation = locatedConversation.conversation
            if (conversation?._placeholder === true || !Array.isArray(conversation?.message)) return null
            const rawMessages = conversation.message as UnknownRecord[]
            const declaredMemberIds = locatedCharacter.character.type === 'group'
                && Array.isArray(locatedCharacter.character.characters)
                ? [...locatedCharacter.character.characters]
                : undefined
            const resolvedMembers = declaredMemberIds
                ? resolveOrdinaryMembers(locatedCharacter.characters, declaredMemberIds)
                : []
            const memberCharacterIds = declaredMemberIds
                ? resolvedMembers.map((member) => member.id)
                : undefined
            const capture: MessageQueryConversation = {
                characterId: target.characterId,
                conversationId: target.conversationId,
                currentCharacterId: target.characterId,
                ...(memberCharacterIds ? { memberCharacterIds } : {}),
                isStreaming: conversation.isStreaming === true,
                messages: rawMessages.map(sourceMessage),
                validationToken: {},
            }
            const token: PocketValidationToken = {
                capture,
                root,
                characters: locatedCharacter.characters,
                character: locatedCharacter.character,
                characterIndex: locatedCharacter.index,
                characterType: locatedCharacter.character.type,
                declaredMemberIds,
                resolvedMembers,
                chats: locatedConversation.chats,
                conversation,
                conversationIndex: locatedConversation.index,
                isStreaming: conversation.isStreaming,
                messages: rawMessages,
                fields: snapshotFields(rawMessages),
            }
            capture.validationToken = token
            ownedTokens.add(token)
            return capture
        },

        isConversationCurrent(capture) {
            try {
                const token = capture.validationToken as PocketValidationToken
                if (!token || typeof token !== 'object' || !ownedTokens.has(token) || token.capture !== capture) return false
                const root = dependencies.getDatabase()
                if (root !== token.root || root.characters !== token.characters
                    || token.characters[token.characterIndex] !== token.character
                    || token.character.chaId !== capture.characterId
                    || token.character.type !== token.characterType
                    || !sameMembers(token.character.characters, token.declaredMemberIds)
                    || !sameResolvedMembers(
                        resolveOrdinaryMembers(token.characters, token.character.characters),
                        token.resolvedMembers,
                    )
                    || token.character.chats !== token.chats
                    || token.chats[token.conversationIndex] !== token.conversation
                    || token.conversation.id !== capture.conversationId
                    || token.conversation.isStreaming !== token.isStreaming
                    || token.conversation.message !== token.messages
                    || token.messages.length !== token.fields.length) return false
                for (let index = 0; index < token.fields.length; index++) {
                    const baseline = token.fields[index]
                    const message = token.messages[index]
                    if (message !== baseline.source
                        || message?.role !== baseline.role
                        || message?.data !== baseline.data
                        || message?.saying !== baseline.saying
                        || message?.chatId !== baseline.chatId
                        || message?.time !== baseline.time
                        || message?.generationInfo !== baseline.generationInfo
                        || message?.generationInfo?.generationId !== baseline.generationId
                        || message?.pluginMessageState !== baseline.pluginMessageState
                        || canonicalJson(message?.pluginMessageState ?? {}) !== baseline.pluginMessageStateCanonical
                        || message?.pluginMessageUpdatedAt !== baseline.pluginMessageUpdatedAt) return false
                }
                return true
            } catch {
                return false
            }
        },

        async recognizedInlayIds() {
            let keys: unknown
            try {
                keys = await dependencies.listInlayKeys()
            } catch {
                throw new PluginApiError('INTERNAL', 'Unable to enumerate Inlays', { retryable: true })
            }
            if (!Array.isArray(keys) || keys.some((key) => typeof key !== 'string')) {
                throw new PluginApiError('INTERNAL', 'Unable to enumerate Inlays', { retryable: true })
            }
            return new Set(keys)
        },
    }
}

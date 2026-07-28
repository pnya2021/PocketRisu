import type {
    InlayAssetRecord,
    InlayLifecycleMetadata as StoredInlayLifecycleMetadata,
} from 'src/ts/process/files/inlays'
import { PluginApiError } from './errors'
import type {
    InlayLifecycleAdapter,
    InlayLifecycleMetadata,
    InlayReadableRecord,
} from './inlayLifecycle'

type UnknownRecord = Record<string, any>

export interface PocketInlayLifecycleDependencies {
    getDatabase(): { characters?: UnknownRecord[] }
    getCurrentCharacter(): UnknownRecord | undefined
    fetchChatContent(chaId: string, chatIndex: number, chatId: string): Promise<unknown | null>
    getInlayAssetRecord(id: string): Promise<InlayAssetRecord | null>
    writeInlayImageFromBytes(data: Uint8Array, options: {
        id: string
        name: string
        lifecycle: StoredInlayLifecycleMetadata
        maxDecodedPixels: number
        beforeStore(): void | Promise<void>
    }): Promise<string>
    removeInlayAsset(id: string): Promise<boolean>
}

const exactTokens = (id: string) => [
    `{{inlay::${id}}}`,
    `{{inlayed::${id}}}`,
    `{{inlayeddata::${id}}}`,
]
const COLD_STORAGE_MARKER = '\uEF01COLDSTORAGE\uEF01'
const containsToken = (value: string, tokens: readonly string[]) => tokens.some((token) => value.includes(token))

const messagesContain = (messages: unknown, tokens: readonly string[], strict: boolean) => {
    if (!Array.isArray(messages)) {
        if (strict) throw new Error('Lazy chat message list is malformed')
        return false
    }
    for (const message of messages) {
        if (!message || typeof message !== 'object' || typeof message.data !== 'string') {
            if (strict) throw new Error('Lazy chat message is malformed')
            continue
        }
        if (strict && message.data.includes(COLD_STORAGE_MARKER)) {
            throw new Error('Lazy chat still contains a cold-storage marker')
        }
        if (containsToken(message.data, tokens)) return true
    }
    return false
}

const storageFailure = (message: string) => new PluginApiError('INTERNAL', message, { retryable: true })
const unreadableOwnedInlay = () => new PluginApiError(
    'PERMISSION_DENIED',
    'Stored Inlay is not a readable owned image',
)
const MAX_OUTPUT_BYTES = 33_554_432

const normalizeImageMediaType = (value: string) => {
    const mediaType = value.split(';', 1)[0]?.trim().toLowerCase()
    if (!mediaType || !/^image\/[a-z0-9][a-z0-9.+-]*$/u.test(mediaType)) return null
    return mediaType === 'image/jpg' ? 'image/jpeg' : mediaType
}

export function createPocketInlayLifecycleAdapter(
    dependencies: PocketInlayLifecycleDependencies,
): InlayLifecycleAdapter {
    return {
        getCurrentCharacterId() {
            const id = dependencies.getCurrentCharacter()?.chaId
            return typeof id === 'string' && id.length > 0 ? id : null
        },
        async getInlay(id) {
            let record: InlayAssetRecord | null
            try {
                record = await dependencies.getInlayAssetRecord(id)
            } catch {
                throw storageFailure('Unable to read Inlay storage')
            }
            if (!record) return null
            const lifecycle = record.lifecycle as InlayLifecycleMetadata | undefined
            return {
                id,
                name: typeof record.name === 'string' ? record.name : '',
                revision: typeof lifecycle?.revision === 'string' ? lifecycle.revision : '',
                ...(lifecycle ? { lifecycle } : {}),
            }
        },
        async getReadableInlay(id) {
            try {
                const record = await dependencies.getInlayAssetRecord(id)
                if (!record) return null
                if (record.type !== 'image' || !(record.data instanceof Blob)) {
                    throw unreadableOwnedInlay()
                }
                const mediaType = normalizeImageMediaType(record.data.type)
                if (!mediaType) throw unreadableOwnedInlay()
                const lifecycle = record.lifecycle as InlayLifecycleMetadata | undefined
                return {
                    id,
                    name: typeof record.name === 'string' ? record.name : '',
                    revision: typeof lifecycle?.revision === 'string' ? lifecycle.revision : '',
                    ...(lifecycle ? { lifecycle } : {}),
                    blob: record.data,
                    mediaType,
                }
            } catch (error) {
                if (error instanceof PluginApiError) throw error
                throw storageFailure('Unable to read Inlay storage')
            }
        },
        async readInlayBytes(record: InlayReadableRecord, maxBytes: number) {
            if (!(record?.blob instanceof Blob)) throw storageFailure('Stored Inlay is not a readable image Blob')
            if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0 || maxBytes > MAX_OUTPUT_BYTES) {
                throw new PluginApiError('INVALID_ARGUMENT', 'Invalid owned Inlay byte limit')
            }
            if (record.blob.size > maxBytes || record.blob.size > MAX_OUTPUT_BYTES) {
                throw new PluginApiError('RESOURCE_LIMIT', 'Owned Inlay exceeds maxBytes')
            }
            let buffer: ArrayBuffer
            try {
                buffer = await record.blob.arrayBuffer()
            } catch {
                throw storageFailure('Unable to read Inlay bytes')
            }
            if (!(buffer instanceof ArrayBuffer) || buffer.byteLength !== record.blob.size) {
                throw storageFailure('Inlay byte length changed while reading')
            }
            return Uint8Array.from(new Uint8Array(buffer))
        },
        async writeImage(data, request) {
            try {
                await dependencies.writeInlayImageFromBytes(data.slice(), {
                    id: request.id,
                    name: request.name,
                    lifecycle: { ...request.lifecycle, context: { ...request.lifecycle.context } },
                    maxDecodedPixels: 64_000_000,
                    beforeStore: request.beforeMutation,
                })
            } catch (error) {
                if (error instanceof PluginApiError) throw error
                if (error instanceof Error && error.name === 'InlayImageDecodeError') {
                    throw new PluginApiError('DECODE_FAILED', 'Unable to decode Inlay image')
                }
                throw storageFailure('Unable to store Inlay image')
            }
        },
        async hasReference(id) {
            const tokens = exactTokens(id)
            const characters = dependencies.getDatabase().characters ?? []
            try {
                for (const character of characters) {
                    if (!Array.isArray(character?.chats)) continue
                    for (let index = 0; index < character.chats.length; index++) {
                        const chat = character.chats[index]
                        if (!chat?._placeholder) {
                            if (messagesContain(chat?.message, tokens, false)) return true
                            continue
                        }
                        const chaId = character?.chaId
                        const chatId = chat?.id
                        if (typeof chaId !== 'string' || chaId.length === 0
                            || typeof chatId !== 'string' || chatId.length === 0) {
                            throw new Error('Lazy chat identity is malformed')
                        }
                        const loaded = await dependencies.fetchChatContent(chaId, index, chatId)
                        if (!loaded || typeof loaded !== 'object') throw new Error('Lazy chat is unavailable')
                        if (messagesContain((loaded as UnknownRecord).message, tokens, true)) return true
                    }
                }
                return false
            } catch (error) {
                if (error instanceof PluginApiError) throw error
                throw storageFailure('Unable to verify lazy-chat Inlay references')
            }
        },
        async removeInlay(id) {
            try {
                return await dependencies.removeInlayAsset(id)
            } catch {
                throw storageFailure('Unable to remove Inlay from storage')
            }
        },
    }
}

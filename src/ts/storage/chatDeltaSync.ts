import type { Chat } from './database.svelte'
import { messageFingerprints, prefixFingerprint } from './chatFingerprint'

// Chat delta sync — transfer only what changed for long chats.
//
// Loading: the browser keeps a copy of recently opened long chats in
// IndexedDB. Opening one sends the copy's message count and prefix
// fingerprint; the server returns only the messages after it when its own
// first messages fingerprint the same, otherwise the whole chat as before.
//
// Saving: the messages the server held after the last sync are remembered as
// fingerprints (memory only). A save sends only the messages after the
// longest unchanged prefix. The server splices them onto its stored chat
// ONLY after verifying that prefix against its own data; on mismatch it
// answers 409 and the full chat is sent. The remembered base only picks how
// much to send — the stored result always equals the client's chat, exactly
// like a full save.
//
// Nothing here puts a partial chat into memory: a chat is either assembled
// complete (verified prefix + fetched rest) or fetched whole.

export interface ChatDeltaTransport {
    fetchChatContentDelta(chaId: string, chatIndex: number, chatId: string, base: { count: number, fp: string } | null): Promise<{ chat: any, deltaBase: number | null } | null>
    saveChatContentDelta(chaId: string, chatIndex: number, chatId: string, chat: any, base: { count: number, fp: string } | null): Promise<'ok' | 'base-mismatch'>
}

export interface ChatCopyStore {
    get(key: string): Promise<Chat | null>
    put(key: string, chat: Chat): Promise<void>
}

// Only long chats are worth a local copy; short ones load fast anyway.
export const CACHE_MIN_MESSAGES = 40
export const CACHE_MAX_ENTRIES = 24

function chatCopyKey(chaId: string, chatId: string) {
    return `${chaId}|${chatId}`
}

function isUsableCopy(chat: any): chat is Chat {
    return !!chat && typeof chat === 'object' && Array.isArray(chat.message) && chat.message.length > 0 && !chat._placeholder
}

export function createChatDeltaSync(transport: ChatDeltaTransport, copies: ChatCopyStore) {
    const serverFingerprints = new Map<string, string[]>()

    async function fetchChat(chaId: string, chatIndex: number, chatId: string): Promise<Chat | null> {
        const key = chatCopyKey(chaId, chatId)
        let copy: Chat | null = null
        try {
            const stored = await copies.get(key)
            if (isUsableCopy(stored)) copy = stored
        } catch {
            copy = null
        }
        const copyFingerprints = copy ? messageFingerprints(copy.message) : null
        const base = copy && copyFingerprints
            ? { count: copy.message.length, fp: prefixFingerprint(copyFingerprints, copy.message.length) }
            : null

        const result = await transport.fetchChatContentDelta(chaId, chatIndex, chatId, base)
        if (!result) return null

        let full: Chat = result.chat
        let fingerprints: string[]
        if (result.deltaBase !== null && copy && copyFingerprints && result.deltaBase === copy.message.length) {
            full = { ...result.chat, message: copy.message.concat(result.chat.message) }
            fingerprints = copyFingerprints.concat(messageFingerprints(result.chat.message))
        } else {
            fingerprints = messageFingerprints(full.message ?? [])
        }
        serverFingerprints.set(key, fingerprints)

        if ((full.message?.length ?? 0) >= CACHE_MIN_MESSAGES) {
            // Clone now, while `full` is still a plain object (it becomes
            // reactive state once the caller applies it).
            let snapshot: Chat | null = null
            try {
                snapshot = structuredClone(full)
            } catch {
                snapshot = null
            }
            if (snapshot) void copies.put(key, snapshot).catch(() => {})
        }
        return full
    }

    async function saveChat(chaId: string, chatIndex: number, chatId: string, chat: Chat): Promise<void> {
        const key = chatCopyKey(chaId, chatId)
        const messages = chat.message ?? []
        // Fingerprints, delta body and encoding are all taken synchronously
        // below, so they describe the same chat content even if it keeps
        // changing (streaming) while the request is in flight.
        const fingerprints = messageFingerprints(messages)
        const known = serverFingerprints.get(key)
        let shared = 0
        if (known) {
            const max = Math.min(known.length, fingerprints.length)
            while (shared < max && known[shared] === fingerprints[shared]) shared++
        }
        if (shared > 0) {
            const delta = { ...chat, message: messages.slice(shared) }
            const outcome = await transport.saveChatContentDelta(chaId, chatIndex, chatId, delta, {
                count: shared,
                fp: prefixFingerprint(fingerprints, shared),
            })
            if (outcome === 'ok') {
                serverFingerprints.set(key, fingerprints)
                return
            }
            // The server holds something else (another device, a server-side
            // write): fall through to a full save, as before delta sync.
        }
        await transport.saveChatContentDelta(chaId, chatIndex, chatId, chat, null)
        serverFingerprints.set(key, fingerprints)
    }

    return { fetchChat, saveChat }
}

// ── IndexedDB copy store ────────────────────────────────────────────────────

const DB_NAME = 'pocketrisu-chat-copies'
const STORE = 'chats'

let dbPromise: Promise<IDBDatabase> | null = null

function openCopyDb(): Promise<IDBDatabase> {
    if (dbPromise) return dbPromise
    dbPromise = new Promise<IDBDatabase>((resolve, reject) => {
        if (typeof indexedDB === 'undefined') {
            reject(new Error('IndexedDB unavailable'))
            return
        }
        const request = indexedDB.open(DB_NAME, 1)
        request.onupgradeneeded = () => {
            const db = request.result
            if (!db.objectStoreNames.contains(STORE)) {
                const store = db.createObjectStore(STORE, { keyPath: 'key' })
                store.createIndex('usedAt', 'usedAt')
            }
        }
        request.onsuccess = () => resolve(request.result)
        request.onerror = () => reject(request.error)
    })
    dbPromise.catch(() => { dbPromise = null })
    return dbPromise
}

function done(tx: IDBTransaction): Promise<void> {
    return new Promise((resolve, reject) => {
        tx.oncomplete = () => resolve()
        tx.onerror = () => reject(tx.error)
        tx.onabort = () => reject(tx.error)
    })
}

export const indexedDbChatCopies: ChatCopyStore = {
    async get(key) {
        const db = await openCopyDb()
        const tx = db.transaction(STORE, 'readwrite')
        const store = tx.objectStore(STORE)
        const record = await new Promise<any>((resolve, reject) => {
            const request = store.get(key)
            request.onsuccess = () => resolve(request.result)
            request.onerror = () => reject(request.error)
        })
        if (record) store.put({ ...record, usedAt: Date.now() })
        await done(tx)
        return record?.chat ?? null
    },
    async put(key, chat) {
        const db = await openCopyDb()
        const tx = db.transaction(STORE, 'readwrite')
        const store = tx.objectStore(STORE)
        store.put({ key, chat, usedAt: Date.now() })
        // Evict least recently used copies beyond the cap.
        const countRequest = store.count()
        countRequest.onsuccess = () => {
            let excess = countRequest.result - CACHE_MAX_ENTRIES
            if (excess <= 0) return
            const cursorRequest = store.index('usedAt').openCursor()
            cursorRequest.onsuccess = () => {
                const cursor = cursorRequest.result
                if (!cursor || excess <= 0) return
                if (cursor.primaryKey !== key) {
                    cursor.delete()
                    excess--
                }
                cursor.continue()
            }
        }
        await done(tx)
    },
}

import { v4 } from 'uuid'
import type { Chat } from './storage/database.svelte'

/**
 * Gives a copied or branched chat its own message ids.
 *
 * `$state.snapshot` copies keep every `message.chatId`, so two chats end up
 * sharing ids — anything keyed by message id (HypaV3 summaries, bookmarks,
 * server-side edit detection) then cannot tell them apart. This re-keys every
 * message and rewrites the in-chat references to follow.
 *
 * `sourceMessageIds` are the ids of the source chat *before* any truncation.
 * A HypaV3 summary that refers to a source message no longer present in the
 * clone (a branch cut it off) is dropped: it describes a future this branch
 * does not have. A summary whose message was already missing in the source
 * is kept untouched — that orphan predates the clone and `preserveOrphanedMemory`
 * may be relying on it.
 *
 * Mutates and returns `chat`. Does not touch `chat.id`.
 */
export function reissueMessageIds(chat: Chat, sourceMessageIds: Iterable<string | undefined>): Chat {
    const idMap = new Map<string, string>()
    for (const message of chat.message) {
        const next = v4()
        if (message.chatId) idMap.set(message.chatId, next)
        message.chatId = next
    }
    const source = new Set<string>()
    for (const id of sourceMessageIds) if (id) source.add(id)

    if (chat.hypaV3Data?.summaries) {
        const before = chat.hypaV3Data.summaries.length
        chat.hypaV3Data.summaries = chat.hypaV3Data.summaries.flatMap(summary => {
            const memos: string[] = []
            for (const memo of summary.chatMemos ?? []) {
                // null marks the character's first message, which is not in `message`
                if (memo == null) { memos.push(memo); continue }
                const mapped = idMap.get(memo)
                if (mapped) memos.push(mapped)
                else if (source.has(memo)) return []
                else memos.push(memo)
            }
            return [{ ...summary, chatMemos: memos }]
        })
        if (chat.hypaV3Data.summaries.length !== before) {
            // metrics index into `summaries`; stale after a drop
            delete chat.hypaV3Data.metrics
            delete chat.hypaV3Data.lastSelectedSummaries
        }
    }

    if (chat.bookmarks) {
        chat.bookmarks = chat.bookmarks.flatMap(id => idMap.has(id) ? [idMap.get(id)] : [])
    }
    if (chat.bookmarkNames) {
        const names: Record<string, string> = {}
        for (const [id, name] of Object.entries(chat.bookmarkNames)) {
            const mapped = idMap.get(id)
            if (mapped) names[mapped] = name
        }
        chat.bookmarkNames = names
    }
    return chat
}

import { describe, expect, it } from 'vitest'
import { reissueMessageIds } from './chatClone'
import type { Chat } from './storage/database.svelte'

function makeChat(): Chat {
    return {
        name: 'src', note: '', localLore: [],
        message: [
            { role: 'user', data: 'a', chatId: 'm1' },
            { role: 'char', data: 'b', chatId: 'm2' },
            { role: 'user', data: 'c', chatId: 'm3' },
            { role: 'char', data: 'd' },
        ],
        hypaV3Data: {
            summaries: [
                { text: 's-first', chatMemos: [null, 'm1'], isImportant: false },
                { text: 's-mid', chatMemos: ['m2'], isImportant: true },
                { text: 's-late', chatMemos: ['m3'], isImportant: false },
                { text: 's-orphan', chatMemos: ['gone'], isImportant: false },
            ],
            metrics: { lastImportantSummaries: [1], lastRecentSummaries: [], lastSimilarSummaries: [], lastRandomSummaries: [] },
        } as any,
        bookmarks: ['m1', 'm3'],
        bookmarkNames: { m1: 'one', m3: 'three' },
    }
}

describe('reissueMessageIds', () => {
    it('re-keys every message and remaps references (plain copy)', () => {
        const source = makeChat()
        const sourceIds = source.message.map(m => m.chatId)
        const chat = reissueMessageIds(structuredClone(source), sourceIds)

        const ids = chat.message.map(m => m.chatId)
        expect(ids.every(id => typeof id === 'string' && id.length > 0)).toBe(true)
        expect(new Set(ids).size).toBe(4)
        expect(ids.some(id => sourceIds.includes(id))).toBe(false)

        const summaries = chat.hypaV3Data.summaries
        expect(summaries.map(s => s.text)).toEqual(['s-first', 's-mid', 's-late', 's-orphan'])
        expect(summaries[0].chatMemos).toEqual([null, ids[0]])
        expect(summaries[1].chatMemos).toEqual([ids[1]])
        expect(summaries[3].chatMemos).toEqual(['gone'])
        expect(chat.hypaV3Data.metrics).toBeDefined()

        expect(chat.bookmarks).toEqual([ids[0], ids[2]])
        expect(chat.bookmarkNames).toEqual({ [ids[0]]: 'one', [ids[2]]: 'three' })
        // source untouched
        expect(source.message[0].chatId).toBe('m1')
    })

    it('drops summaries and bookmarks that point past a branch cut, keeps pre-existing orphans', () => {
        const source = makeChat()
        const sourceIds = source.message.map(m => m.chatId)
        const branch = structuredClone(source)
        branch.message = branch.message.slice(0, 2)
        reissueMessageIds(branch, sourceIds)

        expect(branch.hypaV3Data.summaries.map(s => s.text)).toEqual(['s-first', 's-mid', 's-orphan'])
        expect(branch.hypaV3Data.metrics).toBeUndefined()
        expect(branch.bookmarks).toEqual([branch.message[0].chatId])
        expect(Object.keys(branch.bookmarkNames)).toEqual([branch.message[0].chatId])
    })

    it('tolerates chats without memory data or bookmarks', () => {
        const chat: Chat = { name: '', note: '', localLore: [], message: [{ role: 'user', data: 'x' }] }
        expect(() => reissueMessageIds(chat, [])).not.toThrow()
        expect(chat.message[0].chatId).toBeTruthy()
    })
})

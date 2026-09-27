import { describe, expect, test, vi } from 'vitest'
import { CACHE_MIN_MESSAGES, createChatDeltaSync, type ChatCopyStore, type ChatDeltaTransport } from './chatDeltaSync'
import { messageFingerprints, prefixFingerprint } from './chatFingerprint'

const msg = (i: number, data = `message ${i}`) => ({ role: (i % 2 ? 'char' : 'user') as 'char' | 'user', data, chatId: `m${i}`, time: i })
const chatOf = (n: number, extra: Record<string, unknown> = {}) => ({ id: 'chat', name: 'Chat', note: '', localLore: [], fmIndex: -1, message: Array.from({ length: n }, (_, i) => msg(i)), ...extra }) as any

// A fake server holding one chat that verifies prefixes exactly like server.cjs.
function fakeServer(initial: any) {
    let stored = structuredClone(initial)
    const matches = (base: { count: number, fp: string }) =>
        base.count <= stored.message.length && prefixFingerprint(messageFingerprints(stored.message.slice(0, base.count)), base.count) === base.fp
    const transport: ChatDeltaTransport = {
        fetchChatContentDelta: vi.fn(async (_a, _i, _c, base) => {
            if (base && matches(base)) return { chat: structuredClone({ ...stored, message: stored.message.slice(base.count) }), deltaBase: base.count }
            return { chat: structuredClone(stored), deltaBase: null }
        }),
        saveChatContentDelta: vi.fn(async (_a, _i, _c, chat, base) => {
            const body = structuredClone(chat)
            if (base) {
                if (!matches(base)) return 'base-mismatch' as const
                body.message = stored.message.slice(0, base.count).concat(body.message)
            }
            stored = body
            return 'ok' as const
        }),
    }
    return { transport, get stored() { return stored }, set stored(v) { stored = v } }
}

function memoryCopies(): ChatCopyStore & { map: Map<string, any> } {
    const map = new Map<string, any>()
    return { map, get: async (k) => (map.has(k) ? structuredClone(map.get(k)) : null), put: async (k, c) => { map.set(k, structuredClone(c)) } }
}

const settle = () => new Promise((r) => setTimeout(r, 0))

describe('chat delta sync — loading', () => {
    test('first open fetches the whole chat and keeps a copy of long chats', async () => {
        const server = fakeServer(chatOf(CACHE_MIN_MESSAGES + 10))
        const copies = memoryCopies()
        const sync = createChatDeltaSync(server.transport, copies)
        const chat = await sync.fetchChat('char', 0, 'chat')
        expect(chat).toEqual(server.stored)
        expect((server.transport.fetchChatContentDelta as any).mock.calls[0][3]).toBeNull()
        await settle()
        expect(copies.map.get('char|chat')).toEqual(server.stored)
    })

    test('reopening with a copy receives only the new messages and assembles the full chat', async () => {
        const server = fakeServer(chatOf(60))
        const copies = memoryCopies()
        const sync = createChatDeltaSync(server.transport, copies)
        await sync.fetchChat('char', 0, 'chat'); await settle()
        server.stored = { ...server.stored, note: 'changed note', message: [...server.stored.message, msg(60), msg(61)] }
        const fetched = await createChatDeltaSync(server.transport, copies).fetchChat('char', 0, 'chat')
        const lastCall = (server.transport.fetchChatContentDelta as any).mock.results.at(-1).value
        expect((await lastCall).deltaBase).toBe(60)
        expect((await lastCall).chat.message).toHaveLength(2)
        expect(fetched).toEqual(server.stored)
    })

    test('a copy that no longer matches (older message edited elsewhere) falls back to the whole chat', async () => {
        const server = fakeServer(chatOf(60))
        const copies = memoryCopies()
        await createChatDeltaSync(server.transport, copies).fetchChat('char', 0, 'chat'); await settle()
        server.stored.message[3] = msg(3, 'edited on another device')
        const fetched = await createChatDeltaSync(server.transport, copies).fetchChat('char', 0, 'chat')
        expect(fetched).toEqual(server.stored)
        expect(fetched!.message[3].data).toBe('edited on another device')
    })

    test('a broken local store never blocks loading', async () => {
        const server = fakeServer(chatOf(60))
        const broken: ChatCopyStore = { get: async () => { throw new Error('quota') }, put: async () => { throw new Error('quota') } }
        expect(await createChatDeltaSync(server.transport, broken).fetchChat('char', 0, 'chat')).toEqual(server.stored)
    })
})

describe('chat delta sync — saving', () => {
    async function opened(n = 60) {
        const server = fakeServer(chatOf(n))
        const sync = createChatDeltaSync(server.transport, memoryCopies())
        const chat = await sync.fetchChat('char', 0, 'chat')
        return { server, sync, chat: structuredClone(chat)! }
    }
    const lastSave = (server: ReturnType<typeof fakeServer>) => (server.transport.saveChatContentDelta as any).mock.calls.at(-1)

    test('appended messages go out alone and the server ends up with the whole chat', async () => {
        const { server, sync, chat } = await opened()
        chat.message.push(msg(60), msg(61))
        await sync.saveChat('char', 0, 'chat', chat)
        const [, , , body, base] = lastSave(server)
        expect(base.count).toBe(60)
        expect(body.message).toHaveLength(2)
        expect(server.stored).toEqual(chat)
    })

    test('a reroll (last message replaced) sends only from the changed message', async () => {
        const { server, sync, chat } = await opened()
        chat.message[59] = msg(59, 'rerolled answer')
        await sync.saveChat('char', 0, 'chat', chat)
        const [, , , body, base] = lastSave(server)
        expect(base.count).toBe(59)
        expect(body.message.map((m: any) => m.data)).toEqual(['rerolled answer'])
        expect(server.stored).toEqual(chat)
    })

    test('deleting and editing older messages still leaves the server identical to the client', async () => {
        const { server, sync, chat } = await opened()
        chat.message.splice(10, 5)
        chat.message[2] = msg(2, 'edited early message')
        chat.scriptstate = { hp: 3 }
        await sync.saveChat('char', 0, 'chat', chat)
        expect(lastSave(server)[4].count).toBe(2)
        expect(server.stored).toEqual(chat)
    })

    test('a server that changed underneath (another device) gets a full save instead', async () => {
        const { server, sync, chat } = await opened()
        server.stored = { ...server.stored, message: server.stored.message.map((m: any, i: number) => (i === 0 ? msg(0, 'other device') : m)) }
        chat.message.push(msg(60))
        await sync.saveChat('char', 0, 'chat', chat)
        const calls = (server.transport.saveChatContentDelta as any).mock.calls
        expect(calls.at(-2)[4].count).toBe(60)
        expect(calls.at(-1)[4]).toBeNull()
        expect(server.stored).toEqual(chat)
    })

    test('a chat never loaded from the server is saved in full, then as deltas', async () => {
        const server = fakeServer({ ...chatOf(0) })
        const sync = createChatDeltaSync(server.transport, memoryCopies())
        const chat = chatOf(3)
        await sync.saveChat('char', 0, 'chat', chat)
        expect(lastSave(server)[4]).toBeNull()
        chat.message.push(msg(3))
        await sync.saveChat('char', 0, 'chat', chat)
        expect(lastSave(server)[4].count).toBe(3)
        expect(server.stored).toEqual(chat)
    })

    test('clearing the chat saves in full', async () => {
        const { server, sync, chat } = await opened()
        chat.message = []
        await sync.saveChat('char', 0, 'chat', chat)
        expect(lastSave(server)[4]).toBeNull()
        expect(server.stored.message).toEqual([])
    })
})

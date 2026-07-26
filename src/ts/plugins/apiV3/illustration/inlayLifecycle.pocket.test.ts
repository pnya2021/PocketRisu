import { describe, expect, it, vi } from 'vitest'
import type { InlayAssetRecord } from 'src/ts/process/files/inlays'
import { createPocketInlayLifecycleAdapter } from './inlayLifecycle.pocket'

const lifecycle = {
    version: 1 as const,
    ownerPrincipalId: 'principal-1',
    operation: 'inlay.create.v1' as const,
    idempotencyKey: 'create-1',
    argumentDigest: 'a'.repeat(64),
    revision: `sha256:${'b'.repeat(64)}`,
    context: { kind: 'character' as const, characterId: 'character-1' },
}

function harness(overrides: Record<string, unknown> = {}) {
    const stored = new Map<string, InlayAssetRecord>()
    const database = {
        characters: [{
            chaId: 'character-1',
            chats: [{ id: 'chat-1', message: [{ data: 'plain text' }] }],
        }],
    }
    const dependencies = {
        getDatabase: vi.fn(() => database),
        getCurrentCharacter: vi.fn(() => ({ chaId: 'character-1' })),
        fetchChatContent: vi.fn(async () => null as unknown),
        getInlayAssetRecord: vi.fn(async (id: string) => stored.get(id) ?? null),
        writeInlayImageFromBytes: vi.fn(async (_data: Uint8Array, request: any) => {
            await request.beforeStore()
            stored.set(request.id, {
                data: new Blob(['png']), ext: 'png', name: request.name, type: 'image', lifecycle: request.lifecycle,
            })
            return request.id
        }),
        removeInlayAsset: vi.fn(async (id: string) => stored.delete(id)),
        ...overrides,
    }
    return { adapter: createPocketInlayLifecycleAdapter(dependencies as any), database, dependencies, stored }
}

describe('Pocket owned Inlay adapter', () => {
    it('projects current character identity and private stored lifecycle metadata', async () => {
        const { adapter, stored } = harness()
        stored.set('inlay-1', { data: new Blob(['png']), ext: 'png', name: 'image.png', type: 'image', lifecycle })

        expect(adapter.getCurrentCharacterId()).toBe('character-1')
        await expect(adapter.getInlay('inlay-1')).resolves.toEqual({
            id: 'inlay-1', name: 'image.png', revision: lifecycle.revision, lifecycle,
        })
    })

    it('passes copied bytes, lifecycle metadata, and immediate authorization through the Pocket image path', async () => {
        const order: string[] = []
        const writeInlayImageFromBytes = vi.fn(async (data: Uint8Array, request: any) => {
            order.push('decoded')
            data.fill(0)
            await request.beforeStore()
            order.push('stored')
            return request.id
        })
        const { adapter } = harness({ writeInlayImageFromBytes })
        const bytes = new Uint8Array([1, 2])

        await adapter.writeImage(bytes, {
            id: 'inlay-1', name: 'image.png', lifecycle,
            beforeMutation: async () => { order.push('authorized') },
        })

        expect(order).toEqual(['decoded', 'authorized', 'stored'])
        expect(bytes).toEqual(new Uint8Array([1, 2]))
        expect(writeInlayImageFromBytes.mock.calls[0][1].maxDecodedPixels).toBe(64_000_000)
    })

    it('finds exact hydrated token variants without prefix or suffix confusion', async () => {
        const id = 'inlay_' + 'a'.repeat(64)
        for (const kind of ['inlay', 'inlayed', 'inlayeddata']) {
            const { adapter } = harness({
                getDatabase: vi.fn(() => ({ characters: [{ chaId: 'c', chats: [{ message: [{ data: `before {{${kind}::${id}}} after` }] }] }] })),
            })
            await expect(adapter.hasReference(id)).resolves.toBe(true)
        }
        const { adapter } = harness({
            getDatabase: vi.fn(() => ({ characters: [{ chaId: 'c', chats: [{ message: [{ data: `{{inlayed::${id}extra}} {{inlay::prefix${id}}}` }] }] }] })),
        })
        await expect(adapter.hasReference(id)).resolves.toBe(false)
    })

    it('reads placeholder chat content lazily without hydrating or mutating database state', async () => {
        const id = 'inlay_' + 'a'.repeat(64)
        const placeholder = { id: 'chat-1', name: 'Lazy', message: [], _placeholder: true }
        const database = { characters: [{ chaId: 'character-1', chats: [placeholder] }] }
        const fetchChatContent = vi.fn(async () => ({ id: 'chat-1', message: [{ data: `{{inlay::${id}}}` }] }))
        const before = structuredClone(database)
        const { adapter } = harness({ getDatabase: vi.fn(() => database), fetchChatContent })

        await expect(adapter.hasReference(id)).resolves.toBe(true)

        expect(fetchChatContent).toHaveBeenCalledWith('character-1', 0, 'chat-1')
        expect(database).toEqual(before)
        expect(database.characters[0].chats[0]).toBe(placeholder)
    })

    it.each([
        ['null', vi.fn(async () => null)],
        ['throw', vi.fn(async () => { throw new Error('409 moved') })],
        ['cold marker', vi.fn(async () => ({ message: [{ data: '\uEF01COLDSTORAGE\uEF01' }] }))],
    ])('fails closed when lazy chat loading returns %s', async (_label, fetchChatContent) => {
        const database = { characters: [{ chaId: 'character-1', chats: [{ id: 'chat-1', message: [], _placeholder: true }] }] }
        const { adapter } = harness({ getDatabase: vi.fn(() => database), fetchChatContent })

        await expect(adapter.hasReference('inlay_' + 'a'.repeat(64)))
            .rejects.toMatchObject({ name: 'PluginApiError', code: 'INTERNAL', retryable: true })
    })
})

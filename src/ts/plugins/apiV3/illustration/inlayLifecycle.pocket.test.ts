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
        fetchInlayReferences: vi.fn(async () => ({
            scannedAt: 1,
            totalMessages: 1,
            refCounts: Object.create(null) as Record<string, number>,
        })),
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

    it('finds a reference that exists only in the authoritative server archive scan', async () => {
        const id = 'inlay_' + 'a'.repeat(64)
        const fetchInlayReferences = vi.fn(async () => ({
            scannedAt: 10,
            totalMessages: 3,
            refCounts: Object.assign(Object.create(null), { [id]: 1 }) as Record<string, number>,
        }))
        const { adapter } = harness({ fetchInlayReferences })

        await expect(adapter.hasReference(id)).resolves.toBe(true)
        expect(fetchInlayReferences).toHaveBeenCalledOnce()
    })

    it('allows an Inlay absent from both active chats and the authoritative server scan', async () => {
        const id = 'inlay_' + 'a'.repeat(64)
        const { adapter } = harness()

        await expect(adapter.hasReference(id)).resolves.toBe(false)
    })

    it.each([
        ['server unavailable', vi.fn(async () => { throw new Error('private server path') })],
        ['missing refCounts', vi.fn(async () => ({ scannedAt: 10, totalMessages: 3 }))],
        ['array refCounts', vi.fn(async () => ({ scannedAt: 10, totalMessages: 3, refCounts: [] }))],
        ['invalid reference count', vi.fn(async () => ({ scannedAt: 10, totalMessages: 3, refCounts: { other: -1 } }))],
    ])('fails closed without exposing raw details when the authoritative scan is %s', async (_label, fetchInlayReferences) => {
        const { adapter } = harness({ fetchInlayReferences })

        await expect(adapter.hasReference('inlay_' + 'a'.repeat(64))).rejects.toMatchObject({
            name: 'PluginApiError',
            code: 'INTERNAL',
            message: 'Unable to verify Inlay references',
            retryable: true,
        })
    })

    it('retains an unsaved live reference without depending on server availability', async () => {
        const id = 'inlay_' + 'a'.repeat(64)
        const fetchInlayReferences = vi.fn(async () => { throw new Error('offline') })
        const { adapter } = harness({
            getDatabase: vi.fn(() => ({
                characters: [{ chaId: 'c', chats: [{ message: [{ data: `{{inlay::${id}}}` }] }] }],
            })),
            fetchInlayReferences,
        })

        await expect(adapter.hasReference(id)).resolves.toBe(true)
        expect(fetchInlayReferences).not.toHaveBeenCalled()
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

    it('reads a fresh raw owned image record and normalizes its MIME without exposing storage fields', async () => {
        const { adapter, stored } = harness()
        const blob = new Blob([Uint8Array.of(1, 2, 3)], { type: 'IMAGE/JPG; Charset=UTF-8' })
        stored.set('owned', {
            data: blob, ext: 'jpg', name: 'portrait.jpg', type: 'image', lifecycle,
        })

        await expect(adapter.getReadableInlay('owned')).resolves.toEqual({
            id: 'owned',
            name: 'portrait.jpg',
            revision: lifecycle.revision,
            lifecycle,
            blob,
            mediaType: 'image/jpeg',
        })
    })

    it('returns null for missing storage and sanitizes raw backend failures', async () => {
        const missing = harness()
        await expect(missing.adapter.getReadableInlay('missing')).resolves.toBeNull()

        const failed = harness({
            getInlayAssetRecord: vi.fn(async () => { throw new Error('C:\\private\\inlay.json') }),
        })
        await expect(failed.adapter.getReadableInlay('owned'))
            .rejects.toMatchObject({ code: 'INTERNAL', retryable: true })
    })

    it.each([
        ['string data', { data: 'data:image/png;base64,AA==', type: 'image', name: 'x.png' }],
        ['non-image record', { data: new Blob(['x'], { type: 'image/png' }), type: 'audio', name: 'x.png' }],
        ['non-image MIME', { data: new Blob(['x'], { type: 'text/plain' }), type: 'image', name: 'x.png' }],
        ['empty MIME', { data: new Blob(['x']), type: 'image', name: 'x.png' }],
    ])('fails closed for %s instead of migrating or returning it', async (_label, partial) => {
        const { adapter, stored } = harness()
        stored.set('bad', {
            ext: 'png', lifecycle, ...partial,
        } as InlayAssetRecord)

        await expect(adapter.getReadableInlay('bad'))
            .rejects.toMatchObject({ code: 'PERMISSION_DENIED', retryable: false })
    })

    it('checks exact and one-over maxBytes before arrayBuffer and returns an isolated byte copy', async () => {
        const { adapter, stored } = harness()
        const blob = new Blob([Uint8Array.of(1, 2, 3)], { type: 'image/png' })
        const arrayBuffer = vi.spyOn(blob, 'arrayBuffer')
        stored.set('owned', {
            data: blob, ext: 'png', name: 'portrait.png', type: 'image', lifecycle,
        })
        const record = await adapter.getReadableInlay('owned')

        const bytes = await adapter.readInlayBytes(record!, 3)
        expect(bytes).toEqual(Uint8Array.of(1, 2, 3))
        bytes.fill(0)
        expect(new Uint8Array(await blob.arrayBuffer())).toEqual(Uint8Array.of(1, 2, 3))

        arrayBuffer.mockClear()
        await expect(adapter.readInlayBytes(record!, 2))
            .rejects.toMatchObject({ code: 'RESOURCE_LIMIT' })
        expect(arrayBuffer).not.toHaveBeenCalled()
    })

    it('returns fresh descriptor and Blob race evidence on every raw read', async () => {
        const { adapter, stored } = harness()
        stored.set('owned', {
            data: new Blob(['a'], { type: 'image/png' }), ext: 'png',
            name: 'before.png', type: 'image', lifecycle,
        })
        const before = await adapter.getReadableInlay('owned')
        stored.set('owned', {
            data: new Blob(['bb'], { type: 'image/webp' }), ext: 'webp',
            name: 'after.webp', type: 'image',
            lifecycle: { ...lifecycle, revision: `sha256:${'c'.repeat(64)}` },
        })
        const after = await adapter.getReadableInlay('owned')

        expect(before).toMatchObject({ name: 'before.png', mediaType: 'image/png' })
        expect(before!.blob.size).toBe(1)
        expect(after).toMatchObject({ name: 'after.webp', mediaType: 'image/webp' })
        expect(after!.blob.size).toBe(2)
    })
})

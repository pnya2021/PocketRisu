import { beforeEach, describe, expect, test, vi } from 'vitest'

vi.mock('../alert', () => ({
    alertInput: vi.fn(),
    waitAlert: vi.fn(),
    notifyError: vi.fn(),
}))

vi.mock('./risuSave', () => ({
    decodeRisuSave: vi.fn(),
    encodeRisuSaveLegacy: vi.fn(),
}))

vi.mock('./database.svelte', () => ({
    normalizeChat: (chat: any) => chat,
}))

const { NodeStorage, StorageRequestError } = await import('./nodeStorage')

function jsonResponse(status: number, body: any = {}) {
    return new Response(JSON.stringify(body), {
        status,
        headers: { 'content-type': 'application/json' },
    })
}

function setUpStorage(fetchMock: ReturnType<typeof vi.fn>) {
    ;(NodeStorage as any).sessionInitialized = true
    ;(NodeStorage as any).sessionPending = null

    const delay = vi.fn(async () => {})
    const storage = new NodeStorage(fetchMock as any, {
        baseDelayMs: 0,
        delay,
        random: () => 1,
    })
    storage.authChecked = true
    vi.spyOn(storage, 'createAuth').mockResolvedValue('token')

    return { storage, delay }
}

describe('NodeStorage authFetch transient retry', () => {
    beforeEach(() => {
        vi.restoreAllMocks()
    })

    test('502 -> 502 -> 200 succeeds after two retries', async () => {
        const fetchMock = vi.fn()
            .mockResolvedValueOnce(jsonResponse(502, { error: 'bad gateway' }))
            .mockResolvedValueOnce(jsonResponse(502, { error: 'bad gateway' }))
            .mockResolvedValueOnce(jsonResponse(200, { etag: 'etag-1' }))
        const { storage, delay } = setUpStorage(fetchMock)

        await expect(storage.setItem('database/database.bin', new Uint8Array([1]))).resolves.toBeUndefined()

        expect(fetchMock).toHaveBeenCalledTimes(3)
        expect(delay).toHaveBeenCalledTimes(2)
    })

    test('413 fails immediately without retry as StorageRequestError', async () => {
        const fetchMock = vi.fn()
            .mockResolvedValueOnce(jsonResponse(413, { error: 'body too large' }))
        const { storage, delay } = setUpStorage(fetchMock)

        let caught: unknown
        try {
            await storage.setItem('database/database.bin', new Uint8Array([1]))
        } catch (error) {
            caught = error
        }

        expect(caught).toBeInstanceOf(StorageRequestError)
        expect((caught as Error).message).toContain('Save request failed because it is too large (HTTP 413)')
        expect((caught as Error).message).toContain('body too large')
        expect(caught).toMatchObject({
            name: 'StorageRequestError',
            op: 'setItem',
            status: 413,
            serverMessage: 'body too large',
        })

        expect(fetchMock).toHaveBeenCalledTimes(1)
        expect(delay).not.toHaveBeenCalled()
    })

    test('network reject retries and then succeeds', async () => {
        const fetchMock = vi.fn()
            .mockRejectedValueOnce(new TypeError('network dropped'))
            .mockResolvedValueOnce(jsonResponse(200, { etag: 'etag-1' }))
        const { storage, delay } = setUpStorage(fetchMock)

        await expect(storage.setItem('database/database.bin', new Uint8Array([1]))).resolves.toBeUndefined()

        expect(fetchMock).toHaveBeenCalledTimes(2)
        expect(delay).toHaveBeenCalledTimes(1)
    })

    test('fourth 502 exceeds retry budget and preserves final HTTP status', async () => {
        const fetchMock = vi.fn()
            .mockResolvedValueOnce(jsonResponse(502, { error: 'bad gateway 1' }))
            .mockResolvedValueOnce(jsonResponse(502, { error: 'bad gateway 2' }))
            .mockResolvedValueOnce(jsonResponse(502, { error: 'bad gateway 3' }))
            .mockResolvedValueOnce(jsonResponse(502, { error: 'bad gateway 4' }))
        const { storage, delay } = setUpStorage(fetchMock)

        await expect(storage.setItem('database/database.bin', new Uint8Array([1]))).rejects.toMatchObject({
            name: 'StorageRequestError',
            op: 'setItem',
            status: 502,
            serverMessage: 'bad gateway 4',
        })

        expect(fetchMock).toHaveBeenCalledTimes(4)
        expect(delay).toHaveBeenCalledTimes(3)
    })

    test('AbortError propagates without retry', async () => {
        const abortError = new DOMException('The operation was aborted.', 'AbortError')
        const fetchMock = vi.fn().mockRejectedValueOnce(abortError)
        const { storage, delay } = setUpStorage(fetchMock)

        await expect(storage.setItem('database/database.bin', new Uint8Array([1]))).rejects.toBe(abortError)

        expect(fetchMock).toHaveBeenCalledTimes(1)
        expect(delay).not.toHaveBeenCalled()
    })
})

describe('NodeStorage manifest revision recovery', () => {
    beforeEach(() => {
        vi.restoreAllMocks()
    })

    test('refreshes an asset owner descriptor after a pruned revision returns 404', async () => {
        const fetchMock = vi.fn()
            .mockResolvedValueOnce(jsonResponse(404, { error: 'not found' }))
            .mockResolvedValueOnce(jsonResponse(200, {
                id: 'live-id', version: 1, count: 1, sha256: 'live-hash',
                ownerKind: 'module', ownerId: 'module-a',
            }))
            .mockResolvedValueOnce(jsonResponse(200, {
                total: 1, offset: 0, limit: 100, items: [['new', 'assets/new.png', 'png']],
            }))
        const { storage } = setUpStorage(fetchMock)
        const descriptor = {
            id: 'stale-id', version: 1, count: 1, sha256: 'stale-hash',
            ownerKind: 'module' as const, ownerId: 'module-a',
        }

        await expect(storage.getAssetManifestPage(descriptor)).resolves.toMatchObject({ total: 1 })
        expect(descriptor.id).toBe('live-id')
        expect(String(fetchMock.mock.calls[1][0])).toContain('/api/asset-manifests/owner/module/module-a')
    })

    test('forwards the configured fuzzy distance to the resolver', async () => {
        const fetchMock = vi.fn().mockResolvedValueOnce(jsonResponse(200, { resolved: {} }))
        const { storage } = setUpStorage(fetchMock)

        await storage.resolveAssetManifestNames([{ manifestId: 'id' }], ['name'], 9)
        const init = fetchMock.mock.calls[0][1] as RequestInit
        expect(JSON.parse(String(init.body))).toMatchObject({ maxDistance: 9 })
    })

})

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('src/lang', () => ({ language: {} }))
vi.mock('../alert', () => ({
    alertInput: vi.fn(),
    waitAlert: vi.fn(),
    notifyError: vi.fn(),
}))
vi.mock('./database.svelte', () => ({ normalizeChat: (value: unknown) => value }))
vi.mock('./risuSave', () => ({
    decodeRisuSave: vi.fn(),
    encodeRisuSaveLegacy: vi.fn(),
}))

import { NodeStorage } from './nodeStorage'

const PRINCIPAL = '11111111-1111-4111-8111-111111111111'
const PROFILE = 'pixai-tagger-v0.9-onnx'

function readyStorage() {
    const storage = new NodeStorage()
    storage.authChecked = true
    vi.spyOn(storage, 'createAuth').mockResolvedValue('jwt-one')
    vi.spyOn(storage as any, 'checkAuth').mockResolvedValue(undefined)
    return storage
}

function requestHeaders(call: unknown[]) {
    return new Headers((call[1] as RequestInit | undefined)?.headers)
}

beforeEach(() => {
    ;(NodeStorage as any).sessionInitialized = true
    ;(NodeStorage as any).sessionPending = null
})

afterEach(() => {
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
})

describe('NodeStorage Pocket plugin-model bridge', () => {
    it('uses only the four fixed routes and injects auth, session, and Host principal headers', async () => {
        const fetchMock = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) =>
            new Response('{}', { status: 200 }))
        vi.stubGlobal('fetch', fetchMock)
        const storage = readyStorage()
        const controller = new AbortController()

        await storage.pluginModelStatus()
        await storage.pluginModelDownload(PRINCIPAL, controller.signal)
        await storage.pluginModelCancel(PRINCIPAL)
        await storage.pluginModelRemove(PRINCIPAL, false)

        expect(fetchMock.mock.calls.map(([url, init]) => [url, (init as RequestInit).method ?? 'GET']))
            .toEqual([
                [`/api/plugin-models/${PROFILE}/status`, 'GET'],
                [`/api/plugin-models/${PROFILE}/download`, 'POST'],
                [`/api/plugin-models/${PROFILE}/download`, 'DELETE'],
                [`/api/plugin-models/${PROFILE}`, 'DELETE'],
            ])
        for (const call of fetchMock.mock.calls) {
            const headers = requestHeaders(call)
            expect(headers.get('risu-auth')).toBe('jwt-one')
            expect(headers.get('x-session-id')).toMatch(/\S/)
        }
        expect(requestHeaders(fetchMock.mock.calls[0]).has('x-risu-plugin-principal-id')).toBe(false)
        for (const index of [1, 2, 3]) {
            expect(requestHeaders(fetchMock.mock.calls[index]).get('x-risu-plugin-principal-id'))
                .toBe(PRINCIPAL)
        }
        expect((fetchMock.mock.calls[1][1] as RequestInit).signal).toBe(controller.signal)
        expect((fetchMock.mock.calls[1][1] as RequestInit).body).toBeUndefined()
        expect((fetchMock.mock.calls[2][1] as RequestInit).body).toBeUndefined()
        expect(requestHeaders(fetchMock.mock.calls[3]).get('content-type')).toBe('application/json')
        expect((fetchMock.mock.calls[3][1] as RequestInit).body).toBe('{"includePartial":false}')
    })

    it('preserves the Host principal and signal across the existing auth retry', async () => {
        const fetchMock = vi.fn<(input: RequestInfo | URL, init?: RequestInit) => Promise<Response>>()
            .mockResolvedValueOnce(new Response(JSON.stringify({ error: 'Token Expired' }), {
                status: 401,
                headers: { 'content-type': 'application/json' },
            }))
            .mockResolvedValueOnce(new Response('', { status: 200 }))
        vi.stubGlobal('fetch', fetchMock)
        const storage = readyStorage()
        vi.mocked(storage.createAuth)
            .mockResolvedValueOnce('jwt-old')
            .mockResolvedValueOnce('jwt-new')
        const controller = new AbortController()

        await storage.pluginModelDownload(PRINCIPAL, controller.signal)

        expect(fetchMock).toHaveBeenCalledTimes(2)
        for (const call of fetchMock.mock.calls) {
            expect(call[0]).toBe(`/api/plugin-models/${PROFILE}/download`)
            expect((call[1] as RequestInit).method).toBe('POST')
            expect((call[1] as RequestInit).signal).toBe(controller.signal)
            expect(requestHeaders(call).get('x-risu-plugin-principal-id')).toBe(PRINCIPAL)
        }
        expect(requestHeaders(fetchMock.mock.calls[0]).get('risu-auth')).toBe('jwt-old')
        expect(requestHeaders(fetchMock.mock.calls[1]).get('risu-auth')).toBe('jwt-new')
    })

    it('forwards the session-conflict response and rejects non-Host wire values before fetch', async () => {
        const fetchMock = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) =>
            new Response('{}', { status: 423 }))
        vi.stubGlobal('fetch', fetchMock)
        const storage = readyStorage()
        const deactivated = vi.fn()
        window.addEventListener('risu-session-deactivated', deactivated)

        await expect(storage.pluginModelCancel(PRINCIPAL)).resolves.toHaveProperty('status', 423)
        expect(deactivated).toHaveBeenCalledTimes(1)

        await expect(storage.pluginModelCancel('not-a-principal')).rejects.toThrow(/principal/i)
        await expect(storage.pluginModelRemove(PRINCIPAL, 'false' as never)).rejects.toThrow(/includePartial/i)
        expect(fetchMock).toHaveBeenCalledTimes(1)
        window.removeEventListener('risu-session-deactivated', deactivated)
    })
})

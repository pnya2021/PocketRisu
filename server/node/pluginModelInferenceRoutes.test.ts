import { createRequire } from 'node:module'
import { EventEmitter } from 'node:events'
import { describe, expect, it, vi } from 'vitest'

const require = createRequire(import.meta.url)
const PROFILE = 'pixai-tagger-v0.9-onnx'
const PRINCIPAL = '11111111-1111-4111-8111-111111111111'
const INSTANCE = '33333333-3333-4333-8333-333333333333'
type Handler = (req: any, res: any) => Promise<void>

function harness(auth = true, active = true) {
    const routes = new Map<string, Handler>()
    const order: string[] = []
    const broker = { probe: vi.fn(async () => ({ backendAvailable: true, modelReady: true })), acquire: vi.fn(async () => ({ sessionId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', provider: 'node' })), run: vi.fn(async () => ({ provider: 'node', tags: [], warnings: [] })), release: vi.fn(async () => {}) }
    const app = { get: (path: string, fn: Handler) => routes.set(`GET ${path}`, fn), post: (path: string, fn: Handler) => routes.set(`POST ${path}`, fn), delete: (path: string, fn: Handler) => routes.set(`DELETE ${path}`, fn) }
    require('./pluginModelInferenceRoutes.cjs').registerPluginModelInferenceRoutes({ app, broker, checkAuth: async () => { order.push('auth'); return auth }, checkActiveSession: () => { order.push('active'); return active } })
    return { routes, broker, order }
}

function response() {
    const out: any = { headers: {}, statusCode: 200, setHeader(k: string, v: string) { this.headers[k.toLowerCase()] = v }, status(code: number) { this.statusCode = code; return this }, json(value: unknown) { this.value = value; return this } }
    return out
}

function request(headers: Record<string, string>, body: Buffer[] = []) {
    const req = Object.assign(new EventEmitter(), { headers, params: { profileId: PROFILE, sessionId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' }, async *[Symbol.asyncIterator]() { yield* body } })
    return req
}

describe('Pocket PixAI private inference routes', () => {
    it('authenticates then checks active session before touching params, headers, or broker', async () => {
        const h = harness(false)
        const hostile = Object.defineProperty({}, 'profileId', { enumerable: true, get() { throw new Error('must not read') } })
        const res = response()
        await h.routes.get('GET /api/plugin-model-inference/:profileId/capabilities')!({ params: hostile, headers: {} }, res)
        expect(h.order).toEqual(['auth'])
        expect(h.broker.probe).not.toHaveBeenCalled()
    })

    it('requires owner UUIDs, empty acquire body, strict provider, and returns no-store JSON', async () => {
        const h = harness()
        const acquire = h.routes.get('POST /api/plugin-model-inference/:profileId/sessions')!
        const invalid = response()
        await acquire(request({ 'x-risu-plugin-principal-id': 'bad', 'x-risu-plugin-instance-id': INSTANCE }), invalid)
        expect(invalid.statusCode).toBe(400)
        const ok = response()
        await acquire(request({ 'x-risu-plugin-principal-id': PRINCIPAL, 'x-risu-plugin-instance-id': INSTANCE, 'x-risu-local-model-provider': 'auto', 'content-length': '0' }), ok)
        expect(ok.headers['cache-control']).toBe('no-store')
        expect(h.broker.acquire).toHaveBeenCalledWith(expect.objectContaining({ principalId: PRINCIPAL, instanceId: INSTANCE, provider: 'auto' }))
    })

    it('accepts only exact raw-image wire headers and bounded body before dispatch', async () => {
        const h = harness()
        const run = h.routes.get('POST /api/plugin-model-inference/:profileId/sessions/:sessionId/run')!
        const headers = { 'x-risu-plugin-principal-id': PRINCIPAL, 'x-risu-plugin-instance-id': INSTANCE, 'content-type': 'application/x-risu-local-model-image', 'x-risu-local-model-media-type': 'image/png', 'content-length': '1' }
        const ok = response()
        await run(request(headers, [Buffer.of(7)]), ok)
        expect(h.broker.run).toHaveBeenCalledWith(expect.objectContaining({ image: expect.any(Buffer) }))
        const wrong = response()
        await run(request({ ...headers, 'content-type': 'application/octet-stream' }, [Buffer.of(7)]), wrong)
        expect(wrong.statusCode).toBe(400)
    })
})

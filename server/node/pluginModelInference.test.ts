import { createRequire } from 'node:module'
import { describe, expect, it } from 'vitest'

const require = createRequire(import.meta.url)
const LABEL_COUNT = 13_461
const requireCore = () => require('./pluginModelInference.cjs') as {
    createPluginModelInference(options: Record<string, unknown>): {
        initialize(): Promise<void>
        run(image: Uint8Array, options?: Record<string, unknown>): Promise<Record<string, unknown>>
        dispose(): Promise<void>
    }
}

const preprocess = JSON.stringify({
    stages: [
        { type: 'resize', size: [448, 448], interpolation: 'bilinear', antialias: null, max_size: null },
        { type: 'to_tensor' },
        { type: 'normalize', mean: [0.5, 0.5, 0.5], std: [0.5, 0.5, 0.5] },
    ],
})

function tagsCsv() {
    const rows = ['id,tag_id,name,category,count,ips']
    for (let id = 0; id < LABEL_COUNT; id += 1) {
        rows.push(`${id},${id},"tag ${id}",${id < 9741 ? 0 : 4},1,0`)
    }
    return rows.join('\n')
}

function makeStore(overrides: Record<string, string> = {}) {
    const files = {
        'preprocess.json': preprocess,
        'selected_tags.csv': tagsCsv(),
        ...overrides,
    }
    return {
        async openVerified(name: keyof typeof files) {
            const value = files[name]
            if (typeof value !== 'string') throw new Error('missing fixture')
            return {
                size: Buffer.byteLength(value),
                async *chunks() { yield Buffer.from(value) },
            }
        },
        async openVerifiedFile(name: string) {
            if (name !== 'model.onnx') throw new Error('missing fixture')
            return { path: 'C:\\private\\model.onnx', size: 1_271_365_854 }
        },
    }
}

async function png() {
    const sharp = require('sharp') as typeof import('sharp')
    return sharp({ create: { width: 1, height: 1, channels: 3, background: 'white' } }).png().toBuffer()
}

function fakeOrt(scores = new Float32Array(LABEL_COUNT)) {
    let creates = 0
    let runs = 0
    let released = 0
    let lastTensor: { type: string; data: Float32Array; dims: number[] } | undefined
    const session = {
        inputNames: ['input'],
        outputNames: ['scores'],
        async run(inputs: Record<string, unknown>) {
            runs += 1
            lastTensor = inputs.input as typeof lastTensor
            return { scores: { type: 'float32', data: scores, dims: [1, LABEL_COUNT] } }
        },
        async release() { released += 1 },
    }
    return {
        ort: {
            Tensor: class {
                type: string
                data: Float32Array
                dims: number[]
                constructor(type: string, data: Float32Array, dims: number[]) {
                    this.type = type; this.data = data; this.dims = dims
                }
            },
            InferenceSession: { async create(modelPath: string) {
                creates += 1
                if (modelPath !== 'C:\\private\\model.onnx') throw new Error('wrong model boundary')
                return session
            } },
        },
        counts: () => ({ creates, runs, released, lastTensor }),
    }
}

describe('Pocket PixAI Node inference core', () => {
    it('keeps native packages directly resolvable without loading them at module import', () => {
        expect(require.resolve('onnxruntime-node')).toContain('onnxruntime-node')
        expect(require.resolve('sharp')).toContain('sharp')
        expect(requireCore().createPluginModelInference).toBeTypeOf('function')
    })

    it('coalesces one CPU session, passes only the verified model path, and preprocesses RGB NCHW', async () => {
        const runtime = fakeOrt()
        const core = requireCore().createPluginModelInference({ store: makeStore(), ort: runtime.ort, sharp: require('sharp') })
        const image = await png()
        await Promise.all([core.run(image), core.run(image)])
        const counts = runtime.counts()
        expect(counts.creates).toBe(1)
        expect(counts.runs).toBe(2)
        expect(counts.lastTensor).toMatchObject({ type: 'float32', dims: [1, 3, 448, 448] })
        expect(counts.lastTensor?.data[0]).toBeCloseTo(1, 5)
        await core.dispose()
        await core.dispose()
        expect(runtime.counts().released).toBe(1)
        await expect(core.run(image)).rejects.toThrow(/unavailable|disposed/i)
    })

    it('uses inclusive category thresholds, filters before truncation, and has stable ties', async () => {
        const scores = new Float32Array(LABEL_COUNT)
        scores[4] = 0.3; scores[5] = 0.3; scores[9741] = 0.85; scores[9742] = 0.9
        const runtime = fakeOrt(scores)
        const core = requireCore().createPluginModelInference({ store: makeStore(), ort: runtime.ort, sharp: require('sharp') })
        const result = await core.run(await png(), { categories: ['general'], maxResults: 1 })
        expect(result).toMatchObject({ provider: 'node', truncated: true, warnings: [], thresholds: { general: 0.3, character: 0.85 } })
        expect(result.tags).toEqual([{ index: 4, name: 'tag 4', score: expect.any(Number), category: 'general' }])
        const characters = await core.run(await png(), { categories: ['character'], maxResults: 2 })
        expect(characters.tags).toEqual([
            { index: 9742, name: 'tag 9742', score: expect.any(Number), category: 'character' },
            { index: 9741, name: 'tag 9741', score: expect.any(Number), category: 'character' },
        ])
    })

    it('uses the 500-result fixed ceiling by default', async () => {
        const scores = new Float32Array(LABEL_COUNT).fill(0.3)
        const runtime = fakeOrt(scores)
        const core = requireCore().createPluginModelInference({ store: makeStore(), ort: runtime.ort, sharp: require('sharp') })
        const result = await core.run(await png())
        expect(result.tags).toHaveLength(500)
        expect(result.truncated).toBe(true)
    })

    it('releases a session created after dispose exactly once', async () => {
        let resolveSession!: (session: Record<string, unknown>) => void
        let releases = 0
        const session = {
            inputNames: ['input'], outputNames: ['scores'], async run() { return {} }, async release() { releases += 1 },
        }
        const core = requireCore().createPluginModelInference({
            store: makeStore(), sharp: require('sharp'),
            ort: { Tensor: class {}, InferenceSession: { create: () => new Promise((resolve) => { resolveSession = resolve }) } },
        })
        const initializing = core.initialize()
        while (!resolveSession) await new Promise<void>((resolve) => setImmediate(resolve))
        const disposing = core.dispose()
        resolveSession(session)
        await expect(initializing).rejects.toThrow(/unavailable/i)
        await disposing
        expect(releases).toBe(1)
    })

    it.each([
        ['bad preprocess', { 'preprocess.json': JSON.stringify({ stages: [] }) }],
        ['duplicate preprocess field', { 'preprocess.json': preprocess.replace('"stages":', '"stages":[],"stages":') }],
        ['bad CSV header', { 'selected_tags.csv': `id,name\n0,nope` }],
    ])('fails closed before session creation for %s sidecars', async (_label, fixture) => {
        const runtime = fakeOrt()
        const core = requireCore().createPluginModelInference({ store: makeStore(fixture), ort: runtime.ort, sharp: require('sharp') })
        await expect(core.initialize()).rejects.toThrow(/inference unavailable/i)
        expect(runtime.counts().creates).toBe(0)
    })

    it('sanitizes invalid image, runtime, and abort errors', async () => {
        const runtime = fakeOrt()
        const core = requireCore().createPluginModelInference({ store: makeStore(), ort: runtime.ort, sharp: require('sharp') })
        await expect(core.run(Buffer.alloc(32 * 1024 * 1024 + 1))).rejects.toThrow(/inference failed/i)
        await expect(core.run(Buffer.from('not an image'))).rejects.toThrow(/inference failed/i)
        await expect(core.run(await png(), { signal: AbortSignal.abort() })).rejects.toThrow(/aborted/i)
        await expect(core.run(await png(), { maxResults: 501 })).rejects.toThrow(/inference failed/i)
    })
})

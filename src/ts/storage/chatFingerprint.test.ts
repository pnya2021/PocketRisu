import { describe, expect, test } from 'vitest'
import { createRequire } from 'node:module'
import * as client from './chatFingerprint'

const server = createRequire(import.meta.url)('../../../server/node/chatFingerprint.cjs')

const samples: unknown[] = [
    { role: 'char', data: '비가 내리는 역에서 그녀는 마지막 열차를 기다렸다. 🚉', chatId: 'a1', time: 1700000000000 },
    { role: 'user', data: 'hi', saying: undefined, disabled: null, swipes: ['one', 'two', ''], swipeId: 1 },
    { data: 'nested', generationInfo: { model: 'x', stageTiming: { stage1: 1.5, stage2: 0 }, inputTokens: 12 }, promptInfo: { toggles: [{ key: 'k', value: true }] } },
    { data: 'bin', blob: new Uint8Array([0, 1, 254, 255]) },
    { data: 'odd numbers', a: Number.NaN, b: Infinity, c: -0, d: 1e21 },
    { z: 1, a: 2, m: { y: [1, null, undefined, 'x'], b: false } },
]

describe('chat fingerprints', () => {
    test('client and server implementations agree', () => {
        for (const sample of samples) {
            expect(client.canon(sample)).toBe(server.canon(sample))
            expect(client.messageFingerprint(sample)).toBe(server.messageFingerprint(sample))
        }
        const fps = client.messageFingerprints(samples)
        expect(fps).toEqual(server.messageFingerprints(samples))
        for (let k = 1; k <= samples.length; k++) {
            expect(client.prefixFingerprint(fps, k)).toBe(server.prefixFingerprint(fps, k))
        }
    })

    test('a Node Buffer and a Uint8Array with the same bytes fingerprint the same', () => {
        expect(server.messageFingerprint({ b: Buffer.from([1, 2, 3]) })).toBe(client.messageFingerprint({ b: new Uint8Array([1, 2, 3]) }))
    })

    test('key order, undefined and null object fields do not matter; content does', () => {
        const a = { role: 'char', data: 'x', chatId: 'c' }
        expect(client.messageFingerprint({ chatId: 'c', data: 'x', role: 'char', extra: undefined, other: null })).toBe(client.messageFingerprint(a))
        expect(client.messageFingerprint({ ...a, data: 'y' })).not.toBe(client.messageFingerprint(a))
        expect(client.messageFingerprint({ ...a, swipes: ['x'] })).not.toBe(client.messageFingerprint(a))
    })

    test('prefix fingerprints include the count', () => {
        const fps = client.messageFingerprints([{ data: 'a' }, { data: 'b' }])
        expect(client.prefixFingerprint(fps, 1)).not.toBe(client.prefixFingerprint(fps, 2))
    })
})

import { createRequire } from 'node:module'
import { createHash } from 'node:crypto'
import * as fs from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

const require = createRequire(import.meta.url)

const PIXAI_PROFILE_ID = 'pixai-tagger-v0.9-onnx'
const TINY_BYTES = Buffer.from('tiny-pixai-artifact')
const TINY_DIGEST = '54ffb88de3d8b9660d7dd2bd3959d33de6b42601cd0653503d24caae24343e59'
const TINY_MANIFEST = Object.freeze({
    revision: 'tiny-r1',
    artifacts: Object.freeze([Object.freeze({
        name: 'tiny.bin',
        bytes: 19,
        sha256: TINY_DIGEST,
    })]),
})

type Store = {
    stat(name: unknown): Promise<{ state: 'absent' | 'partial' | 'verified'; bytes: number; etag?: string }>
    estimate(): Promise<{ usageBytes?: number; quotaBytes?: number; persistent: boolean }>
    beginWrite(name: unknown, options?: unknown): Promise<{
        offset: number
        write(chunk: unknown): Promise<void>
        commit(digest: unknown): Promise<void>
        abort(options: unknown): Promise<void>
    }>
    readPartial(name: unknown, options: { chunkSize: number }): AsyncIterable<Uint8Array>
    openVerified(name: unknown): Promise<{
        size: number
        chunks(options: { chunkSize: number }): AsyncIterable<Uint8Array>
    }>
    openVerifiedFile(name: unknown): Promise<{ path: string; size: number }>
    remove(name: unknown): Promise<void>
}

type StoreModule = {
    MAX_MODEL_ARTIFACT_CHUNK_BYTES: number
    createPluginModelStore(options: {
        root: string
        manifest?: unknown
        fs?: typeof fs
    }): Store
}

const roots = new Set<string>()
const tmpRoot = path.resolve(tmpdir())
const tmpPrefix = `${tmpRoot}${path.sep}`

async function makeRoot(): Promise<string> {
    const root = path.resolve(await fs.mkdtemp(path.join(tmpRoot, 'pocket-pixai-p1-')))
    if (!root.startsWith(tmpPrefix)) throw new Error('temporary root escaped the system temp directory')
    roots.add(root)
    return root
}

afterEach(async () => {
    for (const root of roots) {
        const resolved = path.resolve(root)
        if (!resolved.startsWith(tmpPrefix)) throw new Error('refusing to remove a non-temporary root')
        await fs.rm(resolved, { recursive: true, force: true })
    }
    roots.clear()
})

function storeModule(): StoreModule {
    return require('./pluginModelStore.cjs') as StoreModule
}

async function createTinyStore(options: {
    root?: string
    manifest?: unknown
    fs?: typeof fs
} = {}): Promise<{ root: string; store: Store }> {
    const root = options.root ?? await makeRoot()
    return {
        root,
        store: storeModule().createPluginModelStore({
            root,
            manifest: options.manifest ?? TINY_MANIFEST,
            ...(options.fs ? { fs: options.fs } : {}),
        }),
    }
}

async function collect(chunks: AsyncIterable<Uint8Array>): Promise<Buffer> {
    const values: Buffer[] = []
    for await (const chunk of chunks) values.push(Buffer.from(chunk))
    return Buffer.concat(values)
}

async function writeTiny(store: Store, chunks: readonly Buffer[] = [TINY_BYTES]) {
    const writer = await store.beginWrite('tiny.bin', { etag: 'tiny-etag' })
    for (const chunk of chunks) await writer.write(chunk)
    return writer
}

describe('Pocket PixAI fixed registry', () => {
    it('returns the pinned PixAI profile and model artifact', () => {
        const registry = require('./pluginModelRegistry.cjs')

        expect(registry.getPixaiProfile('pixai-tagger-v0.9-onnx')).toMatchObject({
            id: 'pixai-tagger-v0.9-onnx',
            revision: 'd8cf666911a2c3d10d586d7823259192313c7eb7',
            totalBytes: 1_271_963_279,
        })
        expect(registry.getPixaiArtifact(
            'pixai-tagger-v0.9-onnx',
            'model.onnx',
        )).toEqual({
            profileId: 'pixai-tagger-v0.9-onnx',
            repository: 'deepghs/pixai-tagger-v0.9-onnx',
            revision: 'd8cf666911a2c3d10d586d7823259192313c7eb7',
            name: 'model.onnx',
            url: 'https://huggingface.co/deepghs/pixai-tagger-v0.9-onnx/resolve/d8cf666911a2c3d10d586d7823259192313c7eb7/model.onnx',
            bytes: 1_271_365_854,
            sha256: 'a8d479098b5e23f253543c93df42391736abbb77c21c2efd3a513b9cda7b3657',
        })
    })

    it('pins all reviewed metadata and returns independent deeply frozen clones', () => {
        const registry = require('./pluginModelRegistry.cjs')
        const first = registry.getPixaiProfile(PIXAI_PROFILE_ID)
        const second = registry.getPixaiProfile(PIXAI_PROFILE_ID)

        expect(first).toEqual({
            id: PIXAI_PROFILE_ID,
            repository: 'deepghs/pixai-tagger-v0.9-onnx',
            revision: 'd8cf666911a2c3d10d586d7823259192313c7eb7',
            sourceUrl: 'https://huggingface.co/deepghs/pixai-tagger-v0.9-onnx',
            license: 'Apache-2.0',
            licenseUrl: 'https://www.apache.org/licenses/LICENSE-2.0',
            preprocessing: {
                version: 'pixai-v0.9-preprocess-448-rgb-bilinear-v1',
                width: 448,
                height: 448,
                color: 'rgb',
                resize: 'bilinear',
                labelCount: 13_461,
            },
            thresholds: { general: 0.3, character: 0.85 },
            totalBytes: 1_271_963_279,
            artifacts: [
                {
                    profileId: PIXAI_PROFILE_ID,
                    repository: 'deepghs/pixai-tagger-v0.9-onnx',
                    revision: 'd8cf666911a2c3d10d586d7823259192313c7eb7',
                    name: 'model.onnx',
                    url: 'https://huggingface.co/deepghs/pixai-tagger-v0.9-onnx/resolve/d8cf666911a2c3d10d586d7823259192313c7eb7/model.onnx',
                    bytes: 1_271_365_854,
                    sha256: 'a8d479098b5e23f253543c93df42391736abbb77c21c2efd3a513b9cda7b3657',
                },
                {
                    profileId: PIXAI_PROFILE_ID,
                    repository: 'deepghs/pixai-tagger-v0.9-onnx',
                    revision: 'd8cf666911a2c3d10d586d7823259192313c7eb7',
                    name: 'selected_tags.csv',
                    url: 'https://huggingface.co/deepghs/pixai-tagger-v0.9-onnx/resolve/d8cf666911a2c3d10d586d7823259192313c7eb7/selected_tags.csv',
                    bytes: 596_868,
                    sha256: '76b5dd39354a7a4d9baefb94d63b44a09a4934ee15303b7eb86c38f2128eb68a',
                },
                {
                    profileId: PIXAI_PROFILE_ID,
                    repository: 'deepghs/pixai-tagger-v0.9-onnx',
                    revision: 'd8cf666911a2c3d10d586d7823259192313c7eb7',
                    name: 'preprocess.json',
                    url: 'https://huggingface.co/deepghs/pixai-tagger-v0.9-onnx/resolve/d8cf666911a2c3d10d586d7823259192313c7eb7/preprocess.json',
                    bytes: 557,
                    sha256: '5f8303626704053724fa7ac19cd269f57f5f843b6cca314276c8c4d48d335975',
                },
            ],
        })
        expect(first).not.toBe(second)
        expect(first.artifacts).not.toBe(second.artifacts)
        expect(Object.isFrozen(first)).toBe(true)
        expect(Object.isFrozen(first.preprocessing)).toBe(true)
        expect(Object.isFrozen(first.thresholds)).toBe(true)
        expect(Object.isFrozen(first.artifacts)).toBe(true)
        expect(first.artifacts.every(Object.isFrozen)).toBe(true)
    })

    it('rejects unknown and hostile lookup values without invoking accessors', () => {
        const registry = require('./pluginModelRegistry.cjs')
        let accessed = false
        const hostile = Object.defineProperty({}, 'profileId', {
            enumerable: true,
            get() {
                accessed = true
                throw new Error('getter must not run')
            },
        })

        expect(() => registry.getPixaiProfile('other')).toThrow(/unknown/i)
        expect(() => registry.getPixaiArtifact(PIXAI_PROFILE_ID, '../model.onnx')).toThrow(/unknown/i)
        expect(() => registry.getPixaiProfile(hostile)).toThrow(/unknown/i)
        expect(() => registry.getPixaiArtifact({ id: PIXAI_PROFILE_ID, extra: true }, 'model.onnx')).toThrow(/unknown/i)
        expect(accessed).toBe(false)
    })
})

describe('Pocket server model artifact store', () => {
    it('reports absent and uses bounded disk estimates without scanning entries', async () => {
        const { store } = await createTinyStore()

        expect(await store.stat('tiny.bin')).toEqual({ state: 'absent', bytes: 0 })
        expect(await store.estimate()).toMatchObject({ persistent: true })
    })

    it('replays a partial sequentially and resumes it after a crash-style reopen', async () => {
        const { root, store } = await createTinyStore()
        const first = await store.beginWrite('tiny.bin', { etag: 'tiny-etag' })
        expect(first.offset).toBe(0)
        await first.write(TINY_BYTES.subarray(0, 7))
        await first.abort({ keepPartial: true })

        expect(await store.stat('tiny.bin')).toEqual({
            state: 'partial',
            bytes: 7,
            etag: 'tiny-etag',
        })
        expect(await collect(store.readPartial('tiny.bin', { chunkSize: 3 })))
            .toEqual(TINY_BYTES.subarray(0, 7))

        const reopened = (await createTinyStore({ root })).store
        const resumed = await reopened.beginWrite('tiny.bin', { etag: 'tiny-etag' })
        expect(resumed.offset).toBe(7)
        await resumed.write(TINY_BYTES.subarray(7))
        await resumed.commit(TINY_DIGEST)

        expect(await reopened.stat('tiny.bin')).toEqual({
            state: 'verified',
            bytes: 19,
            etag: 'tiny-etag',
        })
        const readable = await reopened.openVerified('tiny.bin')
        expect(readable.size).toBe(19)
        expect(await collect(readable.chunks({ chunkSize: 5 }))).toEqual(TINY_BYTES)
    })

    it('rejects an oversized corrupt partial while reporting its status', async () => {
        const { root, store } = await createTinyStore()
        await store.stat('tiny.bin')
        await fs.writeFile(
            path.join(root, `${TINY_DIGEST}.partial`),
            Buffer.alloc(TINY_BYTES.byteLength + 1),
        )

        await expect(store.stat('tiny.bin')).rejects.toThrow(/length|size|manifest/i)
    })

    it('rejects an oversized corrupt partial before yielding file bytes', async () => {
        const root = await makeRoot()
        let partialOpens = 0
        const guardedFs = {
            ...fs,
            async open(...args: Parameters<typeof fs.open>) {
                if (String(args[0]).endsWith('.partial')) partialOpens += 1
                return fs.open(...args)
            },
        } as typeof fs
        const { store } = await createTinyStore({ root, fs: guardedFs })
        await store.stat('tiny.bin')
        await fs.writeFile(
            path.join(root, `${TINY_DIGEST}.partial`),
            Buffer.alloc(TINY_BYTES.byteLength + 1),
        )
        let yieldedBytes = 0

        const read = async () => {
            for await (const chunk of store.readPartial('tiny.bin', { chunkSize: 3 })) {
                yieldedBytes += chunk.byteLength
            }
        }

        await expect(read()).rejects.toThrow(/length|size|manifest/i)
        expect(yieldedBytes).toBe(0)
        expect(partialOpens).toBe(0)
    })

    it('accepts the maximum chunk and rejects one-over chunk and aggregate lengths', async () => {
        const { MAX_MODEL_ARTIFACT_CHUNK_BYTES, createPluginModelStore } = storeModule()
        const root = await makeRoot()
        const exact = Buffer.alloc(MAX_MODEL_ARTIFACT_CHUNK_BYTES, 7)
        const digest = createHash('sha256').update(exact).digest('hex')
        const store = createPluginModelStore({
            root,
            manifest: {
                revision: 'boundary-r1',
                artifacts: [{ name: 'boundary.bin', bytes: exact.byteLength, sha256: digest }],
            },
        })
        const writer = await store.beginWrite('boundary.bin')
        await expect(writer.write(exact)).resolves.toBeUndefined()
        await expect(writer.write(Buffer.of(1))).rejects.toThrow(/length|size/i)
        await writer.abort({ keepPartial: false })

        const over = createPluginModelStore({
            root,
            manifest: {
                revision: 'over-r1',
                artifacts: [{ name: 'over.bin', bytes: MAX_MODEL_ARTIFACT_CHUNK_BYTES + 1, sha256: '1'.repeat(64) }],
            },
        })
        const overWriter = await over.beginWrite('over.bin')
        await expect(overWriter.write(Buffer.alloc(MAX_MODEL_ARTIFACT_CHUNK_BYTES + 1)))
            .rejects.toThrow(/chunk/i)
        await overWriter.abort({ keepPartial: false })
    })

    it.each([
        ['ETag', TINY_MANIFEST, 'changed-etag'],
        ['revision', { ...TINY_MANIFEST, revision: 'tiny-r2' }, 'tiny-etag'],
        ['expected length', {
            ...TINY_MANIFEST,
            artifacts: [{ ...TINY_MANIFEST.artifacts[0], bytes: 20 }],
        }, 'tiny-etag'],
    ])('discards stale partial data when %s changes', async (_label, manifest, nextEtag) => {
        const { root, store } = await createTinyStore()
        const writer = await store.beginWrite('tiny.bin', { etag: 'tiny-etag' })
        await writer.write(TINY_BYTES.subarray(0, 8))
        await writer.abort({ keepPartial: true })

        const reopened = (await createTinyStore({ root, manifest })).store
        const fresh = await reopened.beginWrite('tiny.bin', { etag: nextEtag })
        expect(fresh.offset).toBe(0)
        expect(await reopened.stat('tiny.bin')).toMatchObject({ state: 'partial', bytes: 0 })
        await fresh.abort({ keepPartial: false })
    })

    it('requires exact aggregate length and exact expected digest before commit', async () => {
        const { store } = await createTinyStore()
        const short = await store.beginWrite('tiny.bin')
        await short.write(TINY_BYTES.subarray(0, 18))
        await expect(short.commit(TINY_DIGEST)).rejects.toThrow(/length|size/i)
        await short.abort({ keepPartial: false })

        const wrong = await writeTiny(store)
        await expect(wrong.commit('0'.repeat(64))).rejects.toThrow(/digest/i)
        await wrong.abort({ keepPartial: false })

        const exact = await writeTiny(store)
        await expect(exact.commit(TINY_DIGEST)).resolves.toBeUndefined()
    })

    it('keeps a successful commit intact when abort is called afterward', async () => {
        const { root, store } = await createTinyStore()
        const writer = await writeTiny(store)
        await writer.commit(TINY_DIGEST)
        const metadataPath = path.join(root, `${TINY_DIGEST}.json`)
        const metadata = await fs.readFile(metadataPath)

        await expect(writer.abort({ keepPartial: false })).resolves.toBeUndefined()
        await expect(writer.abort({ keepPartial: true })).resolves.toBeUndefined()

        expect(await fs.readFile(metadataPath)).toEqual(metadata)
        expect(await store.stat('tiny.bin')).toEqual({
            state: 'verified',
            bytes: TINY_BYTES.byteLength,
            etag: 'tiny-etag',
        })
        const readable = await store.openVerified('tiny.bin')
        expect(await collect(readable.chunks({ chunkSize: 4 }))).toEqual(TINY_BYTES)
    })

    it('preserves the primary rename failure as a resumable partial', async () => {
        const root = await makeRoot()
        const primary = new Error('injected rename failure')
        const failingFs = {
            ...fs,
            async rename(from: fs.PathLike, to: fs.PathLike) {
                if (String(from).endsWith('.partial') && String(to).endsWith('.data')) throw primary
                return fs.rename(from, to)
            },
        } as typeof fs
        const store = (await createTinyStore({ root, fs: failingFs })).store
        const writer = await writeTiny(store)

        await expect(writer.commit(TINY_DIGEST)).rejects.toBe(primary)
        expect(await (await createTinyStore({ root })).store.stat('tiny.bin'))
            .toMatchObject({ state: 'partial', bytes: 19 })
    })

    it('rolls a metadata failure back without advertising verified bytes', async () => {
        const root = await makeRoot()
        const primary = new Error('injected metadata failure')
        const failingFs = {
            ...fs,
            async writeFile(file: fs.PathLike | fs.FileHandle, data: string | Uint8Array, options?: unknown) {
                if (String(file).endsWith('.json') && String(data).includes('"state":"verified"')) throw primary
                return fs.writeFile(file as fs.PathLike, data, options as never)
            },
        } as typeof fs
        const store = (await createTinyStore({ root, fs: failingFs })).store
        const writer = await writeTiny(store)

        await expect(writer.commit(TINY_DIGEST)).rejects.toBe(primary)
        const reopened = (await createTinyStore({ root })).store
        expect(await reopened.stat('tiny.bin')).toMatchObject({ state: 'partial', bytes: 19 })
        const resumed = await reopened.beginWrite('tiny.bin', { etag: 'tiny-etag' })
        expect(resumed.offset).toBe(19)
        await resumed.abort({ keepPartial: true })
    })

    it.each([
        ['short', async (file: string) => fs.truncate(file, 18)],
        ['long', async (file: string) => fs.appendFile(file, Buffer.of(1))],
    ])('refuses to open a %s verified file', async (_label, corrupt) => {
        const { root, store } = await createTinyStore()
        const writer = await writeTiny(store)
        await writer.commit(TINY_DIGEST)
        await corrupt(path.join(root, `${TINY_DIGEST}.data`))

        expect(await store.stat('tiny.bin')).not.toMatchObject({ state: 'verified' })
        await expect(store.openVerified('tiny.bin')).rejects.toThrow(/verified|size|length/i)
    })

    it('opens only the committed verified data file without exposing its path through chunks', async () => {
        const { root, store } = await createTinyStore()
        const writer = await writeTiny(store)
        await writer.commit(TINY_DIGEST)

        const file = await store.openVerifiedFile('tiny.bin')
        expect(file).toEqual({ path: path.join(root, `${TINY_DIGEST}.data`), size: TINY_BYTES.byteLength })
        expect(Object.isFrozen(file)).toBe(true)
        expect(await store.openVerified('tiny.bin')).not.toHaveProperty('path')
    })

    it('rejects a partial, corrupt, or symlinked file from the verified-file boundary', async () => {
        const { root, store } = await createTinyStore()
        await fs.writeFile(path.join(root, `${TINY_DIGEST}.partial`), TINY_BYTES)
        await expect(store.openVerifiedFile('tiny.bin')).rejects.toThrow(/verified/i)
        await fs.rm(path.join(root, `${TINY_DIGEST}.partial`))
        await fs.symlink(path.join(root, 'outside'), path.join(root, `${TINY_DIGEST}.data`), 'file')
        await expect(store.openVerifiedFile('tiny.bin')).rejects.toThrow(/symbolic|link|verified/i)
    })

    it('removes partial and verified state idempotently', async () => {
        const { store } = await createTinyStore()
        const partial = await store.beginWrite('tiny.bin')
        await partial.write(TINY_BYTES.subarray(0, 4))
        await partial.abort({ keepPartial: true })
        await store.remove('tiny.bin')
        await expect(store.remove('tiny.bin')).resolves.toBeUndefined()
        expect(await store.stat('tiny.bin')).toEqual({ state: 'absent', bytes: 0 })

        const verified = await writeTiny(store)
        await verified.commit(TINY_DIGEST)
        await store.remove('tiny.bin')
        expect(await store.stat('tiny.bin')).toEqual({ state: 'absent', bytes: 0 })
    })

    it('rejects path traversal, hostile manifest data, and a symlink root', async () => {
        const { root, store } = await createTinyStore()
        const outside = path.join(path.dirname(root), `${path.basename(root)}-outside`)
        await fs.writeFile(outside, 'outside')
        roots.add(outside)
        let accessed = false
        const hostile = Object.defineProperty({}, 'name', {
            enumerable: true,
            get() {
                accessed = true
                throw new Error('getter must not run')
            },
        })

        await expect(store.stat('../outside')).rejects.toThrow(/artifact|unknown/i)
        await expect(store.stat(hostile)).rejects.toThrow(/artifact|unknown/i)
        expect(accessed).toBe(false)
        expect(await fs.readFile(outside, 'utf8')).toBe('outside')

        const badRoot = await makeRoot()
        const badManifest = { ...TINY_MANIFEST, extra: true }
        expect(() => storeModule().createPluginModelStore({ root: badRoot, manifest: badManifest }))
            .toThrow(/manifest|field|plain/i)

        const realRoot = await makeRoot()
        const linkedRoot = `${realRoot}-link`
        await fs.symlink(realRoot, linkedRoot, 'junction')
        roots.add(linkedRoot)
        const linked = storeModule().createPluginModelStore({ root: linkedRoot, manifest: TINY_MANIFEST })
        await expect(linked.stat('tiny.bin')).rejects.toThrow(/symbolic|link/i)
    })

    it('rejects a root renamed and replaced by a directory link after initial use', async () => {
        const { root, store } = await createTinyStore()
        const outside = await makeRoot()
        const original = `${root}-original`
        roots.add(original)
        await store.stat('tiny.bin')
        await fs.rename(root, original)
        await fs.symlink(outside, root, process.platform === 'win32' ? 'junction' : 'dir')

        let failure: unknown
        let unexpectedWriter: Awaited<ReturnType<Store['beginWrite']>> | undefined
        try {
            unexpectedWriter = await store.beginWrite('tiny.bin')
        } catch (error) {
            failure = error
        }
        if (unexpectedWriter) await unexpectedWriter.abort({ keepPartial: false })

        expect(unexpectedWriter).toBeUndefined()
        expect(failure).toBeInstanceOf(Error)
        expect(String(failure)).toMatch(/root|link|identity/i)
        expect(await fs.readdir(outside)).toEqual([])
    })

    it('keeps independent injected roots isolated for the same digest', async () => {
        const first = await createTinyStore()
        const second = await createTinyStore()
        const writer = await writeTiny(first.store)
        await writer.commit(TINY_DIGEST)

        expect(await first.store.stat('tiny.bin')).toMatchObject({ state: 'verified' })
        expect(await second.store.stat('tiny.bin')).toEqual({ state: 'absent', bytes: 0 })
    })
})

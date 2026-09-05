// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'

// Fast inlay path (inlayImagePriority): the cache entry is published before
// its dimensions arrive. Every <img> rendered from that entry — queued or
// remounted by a re-render — must receive the dimensions once they land.
const { getInlayInfosBatch } = vi.hoisted(() => ({ getInlayInfosBatch: vi.fn() }))

vi.mock('../../stores.svelte', () => ({
    DBState: { db: { hideAllImages: false, inlayImagePriority: true } },
    selectedCharID: { subscribe: () => () => {} },
    selIdState: { selId: 0 },
}))
vi.mock('../../process/files/inlays', async (importOriginal) => ({
    ...await importOriginal<typeof import('../../process/files/inlays')>(),
    getInlayInfosBatch,
}))

import { parseInlayAssets, resolveInlayPlaceholders, trimMarkdown } from '../parser.svelte'
import { DBState } from '../../stores.svelte'

type Info = Record<string, { type: 'image'; width: number; height: number }>
let intersect: IntersectionObserverCallback[]

function deferred() {
    let resolve!: (v: Info) => void
    let reject!: (e: unknown) => void
    const promise = new Promise<Info>((res, rej) => { resolve = res; reject = rej })
    return { promise, resolve, reject }
}

// Mount a token, fire the intersection observer so the placeholder is
// resolved through the queue, and return the root.
async function mountViaQueue(token: string) {
    const root = document.createElement('div')
    root.innerHTML = parseInlayAssets(token)
    document.body.appendChild(root)
    resolveInlayPlaceholders(root)
    const placeholder = root.querySelector<HTMLElement>('[data-inlay-id]')!
    intersect[intersect.length - 1]([{ isIntersecting: true, target: placeholder } as any], {} as any)
    await vi.waitFor(() => expect(root.querySelector('img')).not.toBeNull())
    return root
}

// Mount a token straight from the cache (what a re-render does): no
// placeholder, no queue, only the sanitized string + resolveInlayPlaceholders.
function remountFromCache(token: string) {
    const html = trimMarkdown(parseInlayAssets(token))
    const root = document.createElement('div')
    root.innerHTML = html
    document.body.appendChild(root)
    resolveInlayPlaceholders(root)
    return { root, html }
}

beforeEach(() => {
    DBState.db.hideAllImages = false
    getInlayInfosBatch.mockReset()
    intersect = []
    vi.stubGlobal('IntersectionObserver', class {
        constructor(cb: IntersectionObserverCallback) { intersect.push(cb) }
        observe() {}
        unobserve() {}
        disconnect() {}
        takeRecords() { return [] }
    })
})

afterEach(() => {
    vi.unstubAllGlobals()
    document.body.replaceChildren()
})

describe('inlay dimensions on the fast path', () => {
    test('an image remounted while the lookup is pending still gets its dimensions', async () => {
        const id = `remount-${crypto.randomUUID()}`
        const token = `{{inlay::${id}}}`
        const info = deferred()
        getInlayInfosBatch.mockReturnValueOnce(info.promise)

        const first = await mountViaQueue(token)
        const detached = first.querySelector('img')!
        first.remove()

        const { root, html } = remountFromCache(token)
        expect(html).toContain('data-inlay-pending')
        expect(root.querySelector('img')!.hasAttribute('data-inlay-pending')).toBe(false)

        info.resolve({ [id]: { type: 'image', width: 1080, height: 360 } })
        await vi.waitFor(() => {
            expect(root.querySelector('img')!.getAttribute('width')).toBe('1080')
            expect(root.querySelector('img')!.getAttribute('height')).toBe('360')
        })
        // Only the connected image was sized, the lookup ran once, and the
        // cache now renders with dimensions and no pending marker.
        expect(detached.hasAttribute('width')).toBe(false)
        expect(getInlayInfosBatch).toHaveBeenCalledTimes(1)
        expect(parseInlayAssets(token)).toContain('width="1080" height="360"')
        expect(parseInlayAssets(token)).not.toContain('data-inlay-pending')
    })

    test('several images of the same id all receive the dimensions', async () => {
        const id = `multi-${crypto.randomUUID()}`
        const token = `{{inlay::${id}}}`
        const info = deferred()
        getInlayInfosBatch.mockReturnValueOnce(info.promise)

        const queued = await mountViaQueue(token)
        const a = remountFromCache(token).root
        const b = remountFromCache(token).root

        info.resolve({ [id]: { type: 'image', width: 640, height: 480 } })
        await vi.waitFor(() => {
            for (const root of [queued, a, b]) {
                expect(root.querySelector('img')!.getAttribute('width')).toBe('640')
            }
        })
        expect(getInlayInfosBatch).toHaveBeenCalledTimes(1)
    })

    test('a legacy inlay without dimensions is not retried', async () => {
        const id = `legacy-${crypto.randomUUID()}`
        const token = `{{inlay::${id}}}`
        getInlayInfosBatch.mockResolvedValueOnce({})

        const root = await mountViaQueue(token)
        // Let the lookup settle and the pending entry clear.
        await vi.waitFor(() => expect(parseInlayAssets(token)).not.toContain('data-inlay-pending'))
        remountFromCache(token)

        expect(root.querySelector('img')!.hasAttribute('width')).toBe(false)
        expect(getInlayInfosBatch).toHaveBeenCalledTimes(1)
    })

    test('a failed lookup clears the pending entry and does not throw', async () => {
        const id = `fail-${crypto.randomUUID()}`
        const token = `{{inlay::${id}}}`
        const info = deferred()
        getInlayInfosBatch.mockReturnValueOnce(info.promise)

        await mountViaQueue(token)
        expect(parseInlayAssets(token)).toContain('data-inlay-pending')
        info.reject(new Error('offline'))
        await vi.waitFor(() => expect(parseInlayAssets(token)).not.toContain('data-inlay-pending'))
    })

    test('dimensions arriving after images are hidden are not applied', async () => {
        const id = `hidden-${crypto.randomUUID()}`
        const info = deferred()
        getInlayInfosBatch.mockReturnValueOnce(info.promise)

        const root = await mountViaQueue(`{{inlay::${id}}}`)
        const img = root.querySelector('img')!
        DBState.db.hideAllImages = true
        info.resolve({ [id]: { type: 'image', width: 1080, height: 360 } })
        await Promise.resolve(); await Promise.resolve(); await Promise.resolve()

        expect(img.hasAttribute('width')).toBe(false)
    })

    test('a foreign image carrying a real pending id is not sized', async () => {
        const id = `foreign-${crypto.randomUUID()}`
        const info = deferred()
        getInlayInfosBatch.mockReturnValueOnce(info.promise)
        const inlayRoot = await mountViaQueue(`{{inlay::${id}}}`)

        const root = document.createElement('div')
        root.innerHTML = trimMarkdown(`<img src="https://example.com/x.png" data-inlay-pending="${id}">`)
        document.body.appendChild(root)
        resolveInlayPlaceholders(root)
        const foreign = root.querySelector('img')!

        info.resolve({ [id]: { type: 'image', width: 1080, height: 360 } })
        await vi.waitFor(() => expect(inlayRoot.querySelector('img')!.getAttribute('width')).toBe('1080'))
        expect(foreign.hasAttribute('width')).toBe(false)
        expect(foreign.hasAttribute('data-inlay-pending')).toBe(false)
    })

    test('a user-written pending attribute on a foreign image is ignored', () => {
        const root = document.createElement('div')
        root.innerHTML = trimMarkdown('<img src="https://example.com/x.png" data-inlay-pending="nope">')
        document.body.appendChild(root)
        resolveInlayPlaceholders(root)
        const img = root.querySelector('img')!
        expect(img.hasAttribute('data-inlay-pending')).toBe(false)
        expect(img.hasAttribute('width')).toBe(false)
        expect(getInlayInfosBatch).not.toHaveBeenCalled()
    })
})

import { afterEach, describe, expect, it, vi } from 'vitest'
import { get } from 'svelte/store'

import type { InlayAssetRecord } from 'src/ts/process/files/inlays'

const inlayStorage = vi.hoisted(() => ({
    records: new Map<string, InlayAssetRecord>(),
    removalAttempts: 0,
    referenceResponse: {} as unknown,
}))

vi.mock('src/ts/process/files/inlays', async (importOriginal) => {
    const actual = await importOriginal<typeof import('src/ts/process/files/inlays')>()
    return {
        ...actual,
        getInlayAssetRecord: async (id: string) => inlayStorage.records.get(id) ?? null,
        listInlayKeys: async () => [...inlayStorage.records.keys()],
        writeInlayImageFromBytes: async (_data: Uint8Array, request: any) => {
            await request.beforeStore()
            inlayStorage.records.set(request.id, {
                data: new Blob(['image'], { type: 'image/png' }),
                ext: 'png',
                name: request.name,
                type: 'image',
                lifecycle: request.lifecycle,
            })
            return request.id
        },
        removeInlayAsset: async (id: string) => {
            inlayStorage.removalAttempts++
            return inlayStorage.records.delete(id)
        },
    }
})

describe('Pocket V3 owned Inlay archive-reference wiring', () => {
    let cleanup: undefined | (() => Promise<void>)

    afterEach(async () => {
        await cleanup?.()
        cleanup = undefined
        inlayStorage.records.clear()
        inlayStorage.removalAttempts = 0
        vi.restoreAllMocks()
        vi.unstubAllGlobals()
    })

    async function harness(referenceResponse: (id: string) => unknown) {
        vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
            const path = new URL(String(input), 'http://localhost').pathname
            if (path === '/api/test_auth') return Response.json({ status: 'correct', token: 'inlay-test' })
            if (path === '/api/session') return Response.json({})
            if (path === '/api/list') return Response.json({ content: [] })
            if (path === '/api/read') return new Response(new Uint8Array())
            if (path === '/api/inlays/references') return Response.json(inlayStorage.referenceResponse)
            throw new Error(`Unexpected inlay wiring fetch: ${path}`)
        }))
        const stores = await import('../../../stores.svelte')
        const permissions = await import('./permissions')
        const v3 = await import('../v3.svelte')
        vi.spyOn(permissions.pluginPermissionService, 'require').mockResolvedValue(undefined)

        const plugin = {
            name: `inlay-archive-${crypto.randomUUID()}`,
            displayName: 'Inlay archive wiring test',
            script: '',
            arguments: {},
            realArg: {},
            customLink: [],
            argMeta: {},
            version: '3.0' as const,
            enabled: true,
            principalId: crypto.randomUUID(),
        }
        const previousCharacters = stores.DBState.db.characters
        const previousPlugins = stores.DBState.db.plugins
        const previousSelected = stores.selIdState.selId
        const previousSelectedStore = get(stores.selectedCharID)
        stores.DBState.db.characters = [{ chaId: 'character-1', chats: [] }] as any
        stores.DBState.db.plugins = [plugin] as any
        stores.selIdState.selId = 0
        stores.selectedCharID.set(0)

        let instance: ReturnType<typeof v3.getV3PluginInstance>
        cleanup = async () => {
            if (instance) await v3.unloadV3Plugin(instance.instanceId)
            stores.DBState.db.characters = previousCharacters
            stores.DBState.db.plugins = previousPlugins
            stores.selIdState.selId = previousSelected
            stores.selectedCharID.set(previousSelectedStore)
        }
        await v3.executePluginV3(plugin as any)
        instance = v3.getV3PluginInstance(plugin.name)
        expect(instance).toBeDefined()
        const api = (instance!.host as any).apiFactory
        const descriptor = await api.createInlay(Uint8Array.of(1, 2, 3), {
            idempotencyKey: 'archive-reference',
            context: { kind: 'character', characterId: 'character-1' },
            return: 'descriptor',
        })
        inlayStorage.referenceResponse = referenceResponse(descriptor.id)
        return { api, descriptor }
    }

    it('prevents the real V3 delete API from removing an archive-referenced owned Inlay', async () => {
        const { api, descriptor } = await harness((id) => ({
            scannedAt: 10,
            totalMessages: 1,
            refCounts: { [id]: 1 },
        }))

        await expect(api.deleteInlay(descriptor.id, { expectedRevision: descriptor.revision }))
            .resolves.toEqual({ deleted: false, reason: 'referenced' })
        expect(inlayStorage.records.has(descriptor.id)).toBe(true)
        expect(inlayStorage.removalAttempts).toBe(0)
    }, 30_000)

    it.each([
        ['missing refCounts', () => ({ scannedAt: 10, totalMessages: 1 })],
        ['array refCounts', () => ({ scannedAt: 10, totalMessages: 1, refCounts: [] })],
    ])('fails closed through the real V3 API for an HTTP scan response with %s', async (_label, response) => {
        const { api, descriptor } = await harness(response)

        await expect(api.deleteInlay(descriptor.id, { expectedRevision: descriptor.revision }))
            .rejects.toMatchObject({
                name: 'PluginApiError',
                code: 'INTERNAL',
                message: 'Unable to verify Inlay references',
                retryable: true,
            })
        expect(inlayStorage.records.has(descriptor.id)).toBe(true)
        expect(inlayStorage.removalAttempts).toBe(0)
    }, 30_000)
})

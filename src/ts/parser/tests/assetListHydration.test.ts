import { describe, test, expect, vi, beforeEach } from 'vitest'

const loadAssetManifestItems = vi.fn()
const getModules = vi.fn()
vi.mock('../../globalApi.svelte', () => ({
    loadAssetManifestItems: (...args: any[]) => loadAssetManifestItems(...args),
}))
vi.mock('../../process/modules', () => ({
    getModules: () => getModules(),
}))

const cacheMod = await import('../../storage/assetManifestCache')
const { mentionsAssetListCbs, hydrateAssetListsForCbs, serializeForCbsScan } = await import('../assetListHydration')

const charManifest = { id: 'char-m', ownerKind: 'character', ownerId: 'c1' } as any
const moduleManifest = { id: 'mod-m', ownerKind: 'module', ownerId: 'm1' } as any

beforeEach(() => {
    loadAssetManifestItems.mockReset().mockResolvedValue([])
    getModules.mockReset().mockReturnValue([{ assetManifest: moduleManifest }, { namespace: 'inline', assets: [] }])
})

describe('mentionsAssetListCbs', () => {
    test.each([
        '{{assetlist}}',
        '{{ assetlist }}',
        '{{asset_list}}',
        '{{asset-list::x}}',
        '{{Asset List}}',
        '{{chardisplayasset}}',
        '{{char_display_asset}}',
        '{{moduleassetlist::TEST}}',
        '{{module_assetlist::TEST}}',
        '{{module asset list:TEST}}',
        'before {{#if 1}}{{module_assetlist::TEST}}{{/if}} after',
    ])('detects %s', (text) => {
        expect(mentionsAssetListCbs([text])).toBe(true)
    })

    test.each([
        '{{asset::smile}}',
        '{{assets}}',
        '{{modules}}',
        '{{moduleenabled::TEST}}',
        'assetlist without braces',
        '',
    ])('ignores %s', (text) => {
        expect(mentionsAssetListCbs([text])).toBe(false)
    })

    test('scans every text and tolerates non-strings', () => {
        expect(mentionsAssetListCbs([undefined, null, 'plain', '{{assetlist}}'])).toBe(true)
        expect(mentionsAssetListCbs([undefined, null, 'plain'])).toBe(false)
    })
})

describe('hydrateAssetListsForCbs', () => {
    test('loads module and character manifests when a list token is present', async () => {
        await hydrateAssetListsForCbs({ additionalAssetManifest: charManifest }, ['{{module_assetlist::TEST}}'])
        expect(loadAssetManifestItems).toHaveBeenCalledTimes(2)
        expect(loadAssetManifestItems).toHaveBeenCalledWith(moduleManifest)
        expect(loadAssetManifestItems).toHaveBeenCalledWith(charManifest)
    })

    test('picks the token up from a script template, not only the message', async () => {
        await hydrateAssetListsForCbs(null, ['<img src=x>', 'out: {{module_assetlist::TEST}}'])
        expect(loadAssetManifestItems).toHaveBeenCalledWith(moduleManifest)
    })

    test('does nothing when no list token is present', async () => {
        await hydrateAssetListsForCbs({ additionalAssetManifest: charManifest }, ['{{asset::smile}}', 'hello'])
        expect(getModules).not.toHaveBeenCalled()
        expect(loadAssetManifestItems).not.toHaveBeenCalled()
    })

    test('skips characters without a manifest', async () => {
        await hydrateAssetListsForCbs({ additionalAssets: [] } as any, ['{{assetlist}}'])
        expect(loadAssetManifestItems).toHaveBeenCalledTimes(1)
        expect(loadAssetManifestItems).toHaveBeenCalledWith(moduleManifest)
    })

    test('skips manifests that are already cached and fetches only the missing ones', async () => {
        cacheMod.cacheFullAssetManifest(moduleManifest.id, [['a', 'k', 'png']])
        await hydrateAssetListsForCbs({ additionalAssetManifest: charManifest }, ['{{assetlist}}'])
        expect(loadAssetManifestItems).toHaveBeenCalledTimes(1)
        expect(loadAssetManifestItems).toHaveBeenCalledWith(charManifest)

        loadAssetManifestItems.mockClear()
        cacheMod.cacheFullAssetManifest(charManifest.id, [])
        await hydrateAssetListsForCbs({ additionalAssetManifest: charManifest }, ['{{assetlist}}'])
        expect(loadAssetManifestItems).not.toHaveBeenCalled()
    })

    test('swallows loader failures instead of rejecting', async () => {
        loadAssetManifestItems.mockRejectedValue(new Error('offline'))
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
        // fresh id: the module-level cache still holds the ids used above
        const uncached = { ...charManifest, id: 'char-uncached' }
        await expect(hydrateAssetListsForCbs({ additionalAssetManifest: uncached }, ['{{assetlist}}'])).resolves.toBeUndefined()
        expect(warn).toHaveBeenCalled()
        warn.mockRestore()
    })
})

describe('serializeForCbsScan', () => {

    test('tokens survive serialization, including whitespace inside the name', () => {
        const sources = [
            { content: 'lore {{module\nassetlist::TEST}}' },
            ['{{char\tdisplay asset}}'],
            'plain {{assetlist}}',
        ]
        for (const source of sources) {
            expect(mentionsAssetListCbs([serializeForCbsScan([source])])).toBe(true)
        }
    })

    test('does not invent tokens from unrelated text', () => {
        expect(mentionsAssetListCbs([serializeForCbsScan([{ a: '{{asset::x}}', b: 'assetlist', c: '{{modules}}' }])])).toBe(false)
    })
})

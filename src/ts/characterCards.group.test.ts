import { describe, expect, test, vi } from 'vitest'
import {
    applyImportedGroupPackageAssetMap,
    buildGroupPackage,
    importGroupPackageAtomic,
    validateGroupPackage,
} from './groupPackage'

const member = (id: string, name: string) => ({
    type: 'character',
    chaId: id,
    name,
    chats: [{
        id: `${id}-chat`,
        name: 'Member chat',
        note: '',
        localLore: [],
        message: [{ role: 'char', data: `I am ${name}`, saying: id, chatId: `${id}-message` }],
    }],
    pluginOwned: { member: id },
})

const group = () => ({
    type: 'group',
    chaId: 'old-group',
    name: 'Two friends',
    firstMessage: 'Hello',
    characters: ['old-a', 'old-b'],
    characterTalks: [1, 2],
    characterActive: [true, true],
    chats: [{
        id: 'group-chat',
        name: 'Main',
        note: 'note',
        localLore: [{ key: 'group', content: 'only here' }],
        modules: ['chat-module'],
        scriptstate: { phase: 2 },
        pluginState: { value: 'keep' },
        message: [
            { role: 'char', data: 'A', saying: 'old-a', chatId: 'm-a' },
            { role: 'char', data: 'B', saying: 'old-b', chatId: 'm-b' },
        ],
    }],
    chatFolders: [],
    chatPage: 0,
    viewScreen: 'multiple',
    globalLore: [{ key: 'group-only', content: 'lore' }],
    autoMode: false,
    useCharacterLore: true,
    emotionImages: [],
    customscript: [],
    modules: ['group-module'],
    pluginOwned: { group: true },
})

describe('versioned group packages', () => {
    test('exports a self-contained version 1 package with stable original IDs', () => {
        const source: any = {
            characters: [member('old-a', 'Same name'), member('old-b', 'Same name'), group()],
        }

        const pkg = buildGroupPackage(source, 'old-group', () => '2026-07-19T00:00:00.000Z')

        expect(pkg).toMatchObject({
            type: 'risuGroupPackage',
            version: 1,
            createdAt: '2026-07-19T00:00:00.000Z',
            group: { originalId: 'old-group' },
            members: [
                { originalId: 'old-a' },
                { originalId: 'old-b' },
            ],
        })
        expect(pkg.group.record.pluginOwned).toEqual({ group: true })
        expect(pkg.group.record.chats[0]).toMatchObject({
            localLore: [{ key: 'group', content: 'only here' }],
            modules: ['chat-module'],
            scriptstate: { phase: 2 },
            pluginState: { value: 'keep' },
        })
        expect(pkg.members[0].record.pluginOwned).toEqual({ member: 'old-a' })
    })

    test('imports all records atomically and remaps membership plus every saying by ID', () => {
        const source: any = {
            characters: [member('old-a', 'Same name'), member('old-b', 'Same name'), group()],
        }
        const pkg = buildGroupPackage(source, 'old-group')
        const target: any = {
            characters: [member('existing', 'Same name')],
            characterOrder: ['existing'],
        }
        const ids = ['new-a', 'new-b', 'new-group']

        const result = importGroupPackageAtomic(target, pkg, { createId: () => ids.shift()! })

        expect(result).toEqual({
            groupId: 'new-group',
            memberIdMap: { 'old-a': 'new-a', 'old-b': 'new-b' },
            insertedIndexes: [1, 2, 3],
        })
        expect(target.characters.map((entry: any) => entry.chaId)).toEqual([
            'existing', 'new-a', 'new-b', 'new-group',
        ])
        const importedGroup = target.characters[3]
        expect(importedGroup.characters).toEqual(['new-a', 'new-b'])
        expect(importedGroup.chats[0].message.map((message: any) => message.saying)).toEqual(['new-a', 'new-b'])
        expect(target.characters[1].chats[0].message[0].saying).toBe('new-a')
        expect(target.characters[2].chats[0].message[0].saying).toBe('new-b')
        expect(target.characterOrder).toEqual(['existing', 'new-a', 'new-b', 'new-group'])
        expect(importedGroup.pluginOwned).toEqual({ group: true })
    })

    test('never matches members by name', () => {
        const source: any = {
            characters: [member('old-a', 'Duplicate'), member('old-b', 'Duplicate'), group()],
        }
        const pkg = buildGroupPackage(source, 'old-group')
        const target: any = {
            characters: [member('already-there', 'Duplicate')],
            characterOrder: ['already-there'],
        }
        const ids = ['fresh-a', 'fresh-b', 'fresh-group']

        importGroupPackageAtomic(target, pkg, { createId: () => ids.shift()! })

        expect(target.characters).toHaveLength(4)
        expect(target.characters[3].characters).toEqual(['fresh-a', 'fresh-b'])
    })

    test('rolls back the complete import when a member or saying reference is invalid', () => {
        const source: any = {
            characters: [member('old-a', 'A'), member('old-b', 'B'), group()],
        }
        const pkg = buildGroupPackage(source, 'old-group')
        pkg.group.record.chats[0].message[1].saying = 'missing-member'
        const target: any = {
            characters: [member('existing', 'Existing')],
            characterOrder: ['existing'],
            pluginOwnedDbField: { keep: true },
        }
        const before = structuredClone(target)
        const ids = ['new-a', 'new-b', 'new-group']

        expect(() => importGroupPackageAtomic(target, pkg, { createId: () => ids.shift()! }))
            .toThrow(/unknown saying/i)
        expect(target).toEqual(before)
    })

    test('rejects malformed, duplicate, and unsupported manifests before mutation', () => {
        const source: any = {
            characters: [member('old-a', 'A'), member('old-b', 'B'), group()],
        }
        const valid = buildGroupPackage(source, 'old-group')
        const stubbed = structuredClone(valid)
        stubbed.group.record.chats = [{ id: 'stub-only', name: 'Stub', _stub: true }]
        const untypedMember = structuredClone(valid)
        delete untypedMember.members[0].record.type
        const cases: any[] = [
            { ...valid, version: 2 },
            { ...valid, members: [valid.members[0], valid.members[0]] },
            { ...valid, group: { ...valid.group, originalId: 'wrong-id' } },
            stubbed,
            untypedMember,
        ]

        for (const pkg of cases) {
            const target: any = { characters: [], characterOrder: [] }
            const ids = ['new-a', 'new-b', 'new-group']
            expect(() => importGroupPackageAtomic(target, pkg, { createId: () => ids.shift()! })).toThrow()
            expect(target).toEqual({ characters: [], characterOrder: [] })
        }
    })

    test('rejects empty, non-string, or duplicate full-chat IDs before asset-map access or database mutation', () => {
        const first = member('old-a', 'A') as any
        first.image = 'assets/member-a.png'
        const source: any = {
            characters: [first, member('old-b', 'B'), group()],
        }
        const valid = buildGroupPackage(source, 'old-group')
        const cases: Array<{ name: string; mutate: (pkg: any) => void }> = [
            {
                name: 'empty group chat ID',
                mutate: pkg => { pkg.group.record.chats[0].id = '' },
            },
            {
                name: 'non-string member chat ID',
                mutate: pkg => { pkg.members[0].record.chats[0].id = 7 },
            },
            {
                name: 'duplicate group chat ID',
                mutate: pkg => {
                    pkg.group.record.chats.push(structuredClone(pkg.group.record.chats[0]))
                },
            },
            {
                name: 'duplicate member chat ID',
                mutate: pkg => {
                    pkg.members[1].record.chats.push(structuredClone(pkg.members[1].record.chats[0]))
                },
            },
        ]

        for (const { name, mutate } of cases) {
            const pkg = structuredClone(valid)
            mutate(pkg)
            const target: any = {
                characters: [member('existing', 'Existing')],
                characterOrder: ['existing'],
            }
            const before = structuredClone(target)
            const createId = vi.fn(() => 'must-not-run')
            const readAssetMap = vi.fn(() => ({ 'assets/member-a.png': 'assets/imported.png' }))
            const options = {
                createId,
                get assetUriMap() {
                    return readAssetMap()
                },
            }

            expect(
                () => importGroupPackageAtomic(target, pkg, options),
                name,
            ).toThrow(/chat.*id/i)
            expect(createId, name).not.toHaveBeenCalled()
            expect(readAssetMap, name).not.toHaveBeenCalled()
            expect(target, name).toEqual(before)
        }
    })

    test('requires createdAt to be an exact canonical ISO timestamp', () => {
        const source: any = {
            characters: [member('old-a', 'A'), member('old-b', 'B'), group()],
        }
        const valid = buildGroupPackage(source, 'old-group')
        const invalidCreatedAt = [
            undefined,
            1_700_000_000_000,
            '2026-07-19T00:00:00Z',
            '2026-07-19T09:00:00.000+09:00',
            '2026-02-30T00:00:00.000Z',
        ]

        for (const createdAt of invalidCreatedAt) {
            const pkg = { ...valid, createdAt }
            expect(() => validateGroupPackage(pkg), String(createdAt)).toThrow(/createdAt/i)
        }
        expect(() => validateGroupPackage(valid)).not.toThrow()
    })

    test('rejects generated ID collisions without a partial append', () => {
        const source: any = {
            characters: [member('old-a', 'A'), member('old-b', 'B'), group()],
        }
        const pkg = buildGroupPackage(source, 'old-group')
        const target: any = { characters: [member('occupied', 'Existing')], characterOrder: ['occupied'] }
        const before = structuredClone(target)

        expect(() => importGroupPackageAtomic(target, pkg, { createId: () => 'occupied' }))
            .toThrow(/unique id/i)
        expect(target).toEqual(before)
    })

    test('declares every local asset and rewrites asset URIs on portable import', () => {
        const first = member('old-a', 'A') as any
        first.image = 'assets/member-a.png'
        first.pluginOwned.preview = 'assets/plugin-preview.webp'
        const second = member('old-b', 'B') as any
        const sourceGroup = group() as any
        sourceGroup.image = 'assets/group.png'
        sourceGroup.emotionImages = [['smile', 'assets/group-smile.jpg']]
        sourceGroup.ccAssets = [{ type: 'x-risu-asset', uri: 'https://example.com/remote.png' }]
        const source: any = { characters: [first, second, sourceGroup] }

        const pkg = buildGroupPackage(source, 'old-group')

        expect(pkg.assets.map(asset => asset.originalUri)).toEqual([
            'assets/member-a.png',
            'assets/plugin-preview.webp',
            'assets/group.png',
            'assets/group-smile.jpg',
        ])
        expect(new Set(pkg.assets.map(asset => asset.file)).size).toBe(4)

        const target: any = { characters: [], characterOrder: [] }
        const ids = ['new-a', 'new-b', 'new-group']
        importGroupPackageAtomic(target, pkg, {
            createId: () => ids.shift()!,
            assetUriMap: {
                'assets/member-a.png': 'assets/imported-member.png',
                'assets/plugin-preview.webp': 'assets/imported-plugin.webp',
                'assets/group.png': 'assets/imported-group.png',
                'assets/group-smile.jpg': 'assets/imported-smile.jpg',
            },
        })

        expect(target.characters[0].image).toBe('assets/imported-member.png')
        expect(target.characters[0].pluginOwned.preview).toBe('assets/imported-plugin.webp')
        expect(target.characters[2].image).toBe('assets/imported-group.png')
        expect(target.characters[2].emotionImages[0][1]).toBe('assets/imported-smile.jpg')
        expect(target.characters[2].ccAssets[0].uri).toBe('https://example.com/remote.png')
    })

    test('rolls back before appending records when a packaged asset is not mapped', () => {
        const first = member('old-a', 'A') as any
        first.image = 'assets/member-a.png'
        const source: any = { characters: [first, member('old-b', 'B'), group()] }
        const pkg = buildGroupPackage(source, 'old-group')
        const target: any = { characters: [member('existing', 'Existing')], characterOrder: ['existing'] }
        const before = structuredClone(target)
        const ids = ['new-a', 'new-b', 'new-group']

        expect(() => importGroupPackageAtomic(target, pkg, {
            createId: () => ids.shift()!,
            assetUriMap: {},
        })).toThrow(/asset/i)
        expect(target).toEqual(before)
    })

    test('can validate and stage the complete DB import before committing saved asset URIs', () => {
        const first = member('old-a', 'A') as any
        first.image = 'assets/member-a.png'
        const source: any = { characters: [first, member('old-b', 'B'), group()] }
        const pkg = buildGroupPackage(source, 'old-group')
        const staged: any = { characters: [], characterOrder: [] }
        const ids = ['new-a', 'new-b', 'new-group']
        const result = importGroupPackageAtomic(staged, pkg, {
            createId: () => ids.shift()!,
            assetUriMap: { 'assets/member-a.png': 'assets/member-a.png' },
        })

        applyImportedGroupPackageAssetMap(staged, pkg, result, {
            'assets/member-a.png': 'assets/saved-member.png',
        })

        expect(staged.characters[0].image).toBe('assets/saved-member.png')
    })

    test('does not partially rewrite staged records when the final asset map is incomplete', () => {
        const first = member('old-a', 'A') as any
        first.image = 'assets/member-a.png'
        first.pluginOwned.preview = 'assets/plugin-preview.webp'
        const source: any = { characters: [first, member('old-b', 'B'), group()] }
        const pkg = buildGroupPackage(source, 'old-group')
        const staged: any = { characters: [], characterOrder: [] }
        const ids = ['new-a', 'new-b', 'new-group']
        const identityMap = Object.fromEntries(pkg.assets.map(asset => [asset.originalUri, asset.originalUri]))
        const result = importGroupPackageAtomic(staged, pkg, {
            createId: () => ids.shift()!,
            assetUriMap: identityMap,
        })
        const before = structuredClone(staged)

        expect(() => applyImportedGroupPackageAssetMap(staged, pkg, result, {
            'assets/member-a.png': 'assets/saved-member.png',
        })).toThrow(/asset/i)
        expect(staged).toEqual(before)
    })

    test('rejects a group original ID that collides with a member before any import work', () => {
        const source: any = {
            characters: [member('old-a', 'A'), member('old-b', 'B'), group()],
        }
        const pkg = buildGroupPackage(source, 'old-group')
        pkg.group.originalId = 'old-a'
        pkg.group.record.chaId = 'old-a'
        const target: any = { characters: [member('existing', 'Existing')], characterOrder: ['existing'] }
        const before = structuredClone(target)
        const createId = vi.fn(() => 'must-not-run')

        expect(() => importGroupPackageAtomic(target, pkg, { createId }))
            .toThrow(/group.*member|member.*group|collid/i)
        expect(createId).not.toHaveBeenCalled()
        expect(target).toEqual(before)
    })

    test('uses a hostile-key-safe member ID map for __proto__, constructor, and prototype IDs', () => {
        const first = member('__proto__', 'Prototype') as any
        const second = member('constructor', 'Constructor') as any
        const hostileGroup = group() as any
        hostileGroup.chaId = 'prototype'
        hostileGroup.characters = ['__proto__', 'constructor']
        hostileGroup.chats[0].message[0].saying = '__proto__'
        hostileGroup.chats[0].message[1].saying = 'constructor'
        const source: any = { characters: [first, second, hostileGroup] }
        const pkg = buildGroupPackage(source, 'prototype')
        const target: any = { characters: [], characterOrder: [] }
        const ids = ['safe-a', 'safe-b', 'safe-group']

        const result = importGroupPackageAtomic(target, pkg, { createId: () => ids.shift()! })

        expect(Object.getPrototypeOf(result.memberIdMap)).toBeNull()
        expect(Object.hasOwn(result.memberIdMap, '__proto__')).toBe(true)
        expect(Object.hasOwn(result.memberIdMap, 'constructor')).toBe(true)
        expect(result.memberIdMap['__proto__']).toBe('safe-a')
        expect(result.memberIdMap.constructor).toBe('safe-b')
        expect(target.characters[2].characters).toEqual(['safe-a', 'safe-b'])
        expect(target.characters[2].chats[0].message.map((message: any) => message.saying))
            .toEqual(['safe-a', 'safe-b'])
    })
})

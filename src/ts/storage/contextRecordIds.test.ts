import { describe, expect, it } from 'vitest'
import { normalizeContextRecordIds } from './contextRecordIds'

describe('persisted context record IDs', () => {
    it('fills missing IDs, resolves collisions globally, and is idempotent across a serialized reload', () => {
        const database = {
            characters: [
                { chaId: 'character-existing', chats: [{ id: 'conversation-existing' }, { id: '' }] },
                { chaId: 'character-existing', chats: [{ id: 'conversation-existing' }, {}] },
                { chaId: ' ', chats: [{ id: 'conversation-unique' }] },
            ],
        }
        const generated = [
            'character-existing',
            'character-generated-1',
            'character-generated-2',
            'conversation-existing',
            'conversation-generated-1',
            'conversation-generated-2',
        ]
        const result = normalizeContextRecordIds(database, () => generated.shift()!)
        expect(result).toEqual({ contextIdsChanged: true })
        expect(database.characters.map((character) => character.chaId)).toEqual([
            'character-existing', 'character-generated-1', 'character-generated-2',
        ])
        expect(database.characters.flatMap((character) => character.chats.map((chat) => chat.id))).toEqual([
            'conversation-existing', 'conversation-generated-1', 'conversation-existing',
            'conversation-generated-2', 'conversation-unique',
        ])

        const reloaded = structuredClone(database)
        expect(normalizeContextRecordIds(reloaded, () => { throw new Error('must not regenerate') }))
            .toEqual({ contextIdsChanged: false })
        expect(reloaded).toEqual(database)
    })

    it('preserves identical lazy-stub chat IDs owned by different characters', () => {
        const database = {
            characters: [
                { chaId: 'character-a', chats: [{ id: 'shared-chat', _stub: true }] },
                { chaId: 'character-b', chats: [{ id: 'shared-chat', _stub: true }] },
            ],
        }

        expect(normalizeContextRecordIds(database, () => { throw new Error('must not rekey') }))
            .toEqual({ contextIdsChanged: false })
        expect(database.characters.map((character) => character.chats[0].id))
            .toEqual(['shared-chat', 'shared-chat'])
    })
})

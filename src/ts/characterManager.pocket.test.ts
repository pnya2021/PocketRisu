import { describe, expect, it } from 'vitest'
import { buildManagerEntries } from './characterManager'

describe('downstream groups in the unified character manager', () => {
    it('keeps groups recognizable in the replacement mobile and grid list', () => {
        const entries = buildManagerEntries({
            characters: [
                { chaId: 'party', type: 'group', name: 'Party', chats: [] },
                { chaId: 'alice', type: 'character', name: 'Alice', chats: [], creation_date: 20 },
            ],
        } as any)
        expect(entries.get('party')).toMatchObject({ name: '[Group] Party', creationDate: 0, index: 0 })
        expect(entries.get('alice')).toMatchObject({ name: 'Alice', creationDate: 20, index: 1 })
    })
})

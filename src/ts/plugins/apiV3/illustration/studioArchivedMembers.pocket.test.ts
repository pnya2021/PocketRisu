import { describe, expect, it, vi } from 'vitest'
import { createPocketStudioCardResourceAdapter } from './studioCardResources.pocket'

describe('Studio source capture with PocketRisu archived group members', () => {
    it('requires Host activation without returning an incomplete group and works again after activation', async () => {
        const group = { chaId: 'party', type: 'group', name: 'Party', characters: ['member'] }
        const db = {
            characters: [group] as Record<string, unknown>[],
            nodeOnlyArchivedCharacters: [{ chaId: 'member', name: 'Member', archivedAt: 10 }],
        }
        const readImage = vi.fn(async () => new Uint8Array())
        const adapter = createPocketStudioCardResourceAdapter({
            getDatabase: () => db,
            getSelectedCharacterIndex: () => 0,
            readImage,
        })
        await expect(adapter.captureSource('party')).rejects.toMatchObject({
            code: 'NOT_FOUND', retryable: false,
            details: { reason: 'GROUP_MEMBER_ARCHIVED' },
        })
        expect(db.nodeOnlyArchivedCharacters).toHaveLength(1)
        expect(db.characters).toEqual([group])
        expect(readImage).not.toHaveBeenCalled()

        db.nodeOnlyArchivedCharacters = []
        db.characters.push({ chaId: 'member', type: 'character', name: 'Member' })
        await expect(adapter.captureSource('party')).resolves.toMatchObject({
            card: { id: 'party', groupMemberIds: ['member'] },
            groupMembers: [{ id: 'member', name: 'Member' }],
        })
    })
})

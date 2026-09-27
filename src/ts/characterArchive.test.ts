import { describe, test, expect, vi, beforeEach } from 'vitest'
import { get } from 'svelte/store'

// Deactivate → activate before the deactivation's save reached the server:
// the server still lists the character as active (409 ARCHIVE_ALREADY_ACTIVE).
// Activation used to drop the stub then, and the save that followed deleted
// the character from the database. And deactivation must not ask the server
// to archive before every earlier edit has actually been saved.

class CharacterArchiveError extends Error {
    code: string
    chats: string[]
    constructor(code: string, message: string, chats: string[] = []) {
        super(message)
        this.code = code
        this.chats = chats
    }
}

const flushSaves = vi.fn<() => Promise<boolean>>()
const requestImmediateSave = vi.fn()
const trackCharacterForSave = vi.fn()
const persistLiveDatabaseUnderLease = vi.fn<(snapshot: any) => Promise<void>>()
const getDbEtag = vi.fn<() => string | null>()
const storage = {
    activateCharacter: vi.fn(),
    archiveCharacter: vi.fn(),
    archiveCharacters: vi.fn(),
}
const overlay = vi.fn()
const deselectCharacter = vi.fn()
const alertError = vi.fn()
const state: { db: any } = { db: null }

vi.mock('./globalApi.svelte', () => ({
    checkCharOrder: () => {},
    flushSaves: () => flushSaves(),
    forageStorage: { get realStorage() { return storage }, getDbEtag: () => getDbEtag() },
    persistLiveDatabaseUnderLease: (snapshot: any) => persistLiveDatabaseUnderLease(snapshot),
    requestImmediateSave: () => requestImmediateSave(),
    requiresFullEncoderReload: { state: false },
    trackCharacterForSave: (id: string) => trackCharacterForSave(id),
}))
vi.mock('./storage/database.svelte', () => ({
    getDatabase: ({ snapshot }: { snapshot?: boolean } = {}) => snapshot
        ? structuredClone(state.db)
        : state.db,
}))
const { writable } = await import('svelte/store')
const selectedCharID = writable(-1)
vi.mock('./stores.svelte', async () => {
    return {
        DBState: { get db() { return state.db } },
        loadingOverlayStore: { set: (v: any) => overlay(v) },
        selectedCharID,
    }
})
vi.mock('./alert', () => ({
    alertConfirm: async () => true,
    alertError: (error: unknown) => alertError(error),
    notifySuccess: () => {},
}))
vi.mock('./characters', () => ({ changeChar: () => {}, deselectCharacter: () => deselectCharacter() }))
vi.mock('./storage/chatStorage', () => ({ convertStubsToPlaceholders: (chats: any[]) => chats }))
vi.mock('./storage/nodeStorage', () => ({ CharacterArchiveError }))
vi.mock('src/lang', () => ({
    language: new Proxy({}, { get: (_t, key) => typeof key === 'string' && /(Confirm|Progress)$/.test(key) ? () => String(key) : String(key) }),
}))

const { activateCharacter, archiveCharacter, archiveCharacters, restoreTrashedCharacter, trashDeactivatedCharacter } = await import('./characterArchive')
const { generationStates } = await import('./process/generationState')

const stub = { chaId: 'c1', name: 'One', archivedAt: 1000 }
const restored = () => ({ chaId: 'c1', name: 'One', chats: [{ id: 'x', name: 'Chat', _stub: true }] })

beforeEach(() => {
    vi.clearAllMocks()
    selectedCharID.set(-1)
    flushSaves.mockResolvedValue(true)
    persistLiveDatabaseUnderLease.mockResolvedValue(undefined)
    getDbEtag.mockReturnValue('etag:current')
    generationStates.set(new Map())
})

describe('activateCharacter', () => {
    test('waits for the pending save and retries when the server still has the character active', async () => {
        state.db = { characters: [], nodeOnlyArchivedCharacters: [{ ...stub }] }
        storage.activateCharacter
            .mockRejectedValueOnce(new CharacterArchiveError('ARCHIVE_ALREADY_ACTIVE', 'Character is already active'))
            .mockResolvedValueOnce(restored())
        expect(await activateCharacter('c1')).toBe(0)
        expect(flushSaves).toHaveBeenCalledTimes(1)
        expect(storage.activateCharacter).toHaveBeenNthCalledWith(2, 'c1', 1000)
        expect(state.db.characters.map((c: any) => c.chaId)).toEqual(['c1'])
        expect(state.db.nodeOnlyArchivedCharacters).toEqual([])
    })

    test('keeps the stub when the server still reports it active after saving', async () => {
        state.db = { characters: [], nodeOnlyArchivedCharacters: [{ ...stub }] }
        storage.activateCharacter.mockRejectedValue(new CharacterArchiveError('ARCHIVE_ALREADY_ACTIVE', 'Character is already active'))
        await expect(activateCharacter('c1')).rejects.toMatchObject({ code: 'ARCHIVE_ALREADY_ACTIVE' })
        expect(state.db.nodeOnlyArchivedCharacters).toEqual([stub])
        expect(state.db.characters).toEqual([])
    })

    test('keeps the stub when the pending save cannot be completed', async () => {
        state.db = { characters: [], nodeOnlyArchivedCharacters: [{ ...stub }] }
        flushSaves.mockResolvedValue(false)
        storage.activateCharacter.mockRejectedValue(new CharacterArchiveError('ARCHIVE_ALREADY_ACTIVE', 'Character is already active'))
        await expect(activateCharacter('c1')).rejects.toMatchObject({ code: 'ARCHIVE_ALREADY_ACTIVE' })
        expect(storage.activateCharacter).toHaveBeenCalledTimes(1)
        expect(state.db.nodeOnlyArchivedCharacters).toEqual([stub])
    })

    test('works on the database object current after the save, not the one it started with', async () => {
        const before = { characters: [], nodeOnlyArchivedCharacters: [{ ...stub }] }
        const after = { characters: [], nodeOnlyArchivedCharacters: [{ ...stub }] }
        state.db = before
        storage.activateCharacter
            .mockRejectedValueOnce(new CharacterArchiveError('ARCHIVE_ALREADY_ACTIVE', 'x'))
            .mockResolvedValueOnce(restored())
        flushSaves.mockImplementation(async () => { state.db = after; return true })
        await activateCharacter('c1')
        expect(after.characters.map((c: any) => c.chaId)).toEqual(['c1'])
        expect(after.nodeOnlyArchivedCharacters).toEqual([])
    })
})

describe('archiveCharacter', () => {
    test('does not archive while earlier edits are still unsaved', async () => {
        state.db = { characters: [{ chaId: 'c1', name: 'One', chats: [] }], nodeOnlyArchivedCharacters: [] }
        persistLiveDatabaseUnderLease.mockRejectedValue(new Error('write failed'))
        expect(await archiveCharacter(0, { skipConfirm: true })).toBe(false)
        expect(storage.archiveCharacter).not.toHaveBeenCalled()
        expect(state.db.characters).toHaveLength(1)
    })

    test('gives an id-less chat an id and saves it before the server builds the payload', async () => {
        const chat: any = { name: 'Chat 1', message: [{ role: 'user', data: 'hi' }] }
        const placeholder: any = { id: 'p', name: 'Old', message: [], _placeholder: true }
        state.db = { characters: [{ chaId: 'c1', name: 'One', chats: [chat, placeholder] }], nodeOnlyArchivedCharacters: [] }
        const order: string[] = []
        persistLiveDatabaseUnderLease.mockImplementation(async (snapshot: any) => {
            expect(typeof snapshot.characters[0].chats[0].id).toBe('string')
            expect(snapshot.characters[0].chats[1]).toEqual(placeholder)
            order.push('persist')
        })
        storage.archiveCharacter.mockImplementation(async () => { order.push('archive'); return { ...stub } })
        expect(await archiveCharacter(0, { skipConfirm: true })).toBe(true)
        expect(typeof chat.id).toBe('string')
        expect(chat.id.length).toBeGreaterThan(0)
        expect(placeholder.id).toBe('p')
        expect(trackCharacterForSave).toHaveBeenCalledWith('c1')
        expect(order.slice(0, 2)).toEqual(['persist', 'archive'])
        expect(state.db.characters).toEqual([])
        expect(state.db.nodeOnlyArchivedCharacters.map((s: any) => s.chaId)).toEqual(['c1'])
    })

    test('waits for the transition to be saved before reporting success', async () => {
        state.db = { characters: [{ chaId: 'c1', name: 'One', chats: [] }], nodeOnlyArchivedCharacters: [] }
        storage.archiveCharacter.mockResolvedValue({ ...stub })
        await archiveCharacter(0, { skipConfirm: true })
        // The pre-archive full write is acknowledged under the lease; the
        // later transition is acknowledged before the success notification.
        expect(persistLiveDatabaseUnderLease).toHaveBeenCalledTimes(1)
        expect(flushSaves).toHaveBeenCalledTimes(1)
        expect(requestImmediateSave).not.toHaveBeenCalled()
    })
})

describe('archiveCharacters (bulk)', () => {
    const chars = (n: number) => Array.from({ length: n }, (_, i) => ({ chaId: `c${i}`, name: `C${i}`, chats: [] }))
    const okFor = (ids: string[]) => ids.map((chaId) => ({ chaId, ok: true, stub: { chaId, name: chaId, archivedAt: 1 } }))

    test('sends chunks of 20 with an acknowledged snapshot before and after each chunk', async () => {
        state.db = { characters: chars(45), nodeOnlyArchivedCharacters: [] }
        const order: string[] = []
        persistLiveDatabaseUnderLease.mockImplementation(async () => { order.push('persist') })
        storage.archiveCharacters.mockImplementation(async (ids: string[]) => { order.push(`batch${ids.length}`); return okFor(ids) })
        const out = await archiveCharacters(state.db.characters.map((c: any) => c.chaId), { trash: true })
        expect(order).toEqual(['persist', 'batch20', 'persist', 'persist', 'batch20', 'persist', 'persist', 'batch5', 'persist'])
        expect(storage.archiveCharacters).toHaveBeenCalledWith(expect.any(Array), { acceptLostChats: true })
        expect(out).toMatchObject({ done: 45, failed: [], lost: [], stopped: false })
        expect(state.db.characters).toEqual([])
        expect(state.db.nodeOnlyArchivedCharacters).toHaveLength(45)
        expect(state.db.nodeOnlyArchivedCharacters.every((s: any) => typeof s.trashedAt === 'number')).toBe(true)
        expect(overlay).toHaveBeenLastCalledWith({ active: false, text: '', onCancel: null })
    })

    test('moves only the characters the server archived', async () => {
        state.db = { characters: chars(3), nodeOnlyArchivedCharacters: [] }
        storage.archiveCharacters.mockResolvedValue([
            { chaId: 'c0', ok: true, stub: { chaId: 'c0' } },
            { chaId: 'c1', ok: false, code: 'ARCHIVE_VERIFY_FAILED', error: 'bad' },
            { chaId: 'c2', ok: false, code: 'ARCHIVE_CHATS_UNAVAILABLE', error: 'lost', chats: ['X'] },
        ])
        const out = await archiveCharacters(['c0', 'c1', 'c2'])
        expect(storage.archiveCharacters).toHaveBeenCalledWith(['c0', 'c1', 'c2'], { acceptLostChats: false })
        expect(state.db.characters.map((c: any) => c.chaId)).toEqual(['c1', 'c2'])
        expect(out.done).toBe(1)
        expect(out.failed).toEqual([{ chaId: 'c1', name: 'C1', reason: 'bad' }])
        expect(out.lost).toEqual([{ chaId: 'c2', name: 'C2', chats: ['X'] }])
    })

    test('stops before the next chunk when a save does not land', async () => {
        state.db = { characters: chars(30), nodeOnlyArchivedCharacters: [] }
        persistLiveDatabaseUnderLease
            .mockResolvedValueOnce(undefined)
            .mockRejectedValueOnce(new Error('transition write failed'))
        storage.archiveCharacters.mockImplementation(async (ids: string[]) => okFor(ids))
        const out = await archiveCharacters(state.db.characters.map((c: any) => c.chaId))
        expect(storage.archiveCharacters).toHaveBeenCalledTimes(1)
        expect(out).toMatchObject({ done: 20, stopped: true })
        expect(state.db.characters).toHaveLength(10)
    })

    test('does not start while earlier edits are unsaved', async () => {
        state.db = { characters: chars(2), nodeOnlyArchivedCharacters: [] }
        persistLiveDatabaseUnderLease.mockRejectedValue(new Error('write failed'))
        await expect(archiveCharacters(['c0', 'c1'])).rejects.toThrow()
        expect(storage.archiveCharacters).not.toHaveBeenCalled()
        expect(state.db.characters).toHaveLength(2)
        expect(overlay).toHaveBeenLastCalledWith({ active: false, text: '', onCancel: null })
    })

    test('refuses an unbound batch instead of overwriting a foreign database revision', async () => {
        state.db = { characters: chars(2), nodeOnlyArchivedCharacters: [] }
        getDbEtag.mockReturnValue(null)

        await expect(archiveCharacters(['c0', 'c1'])).rejects.toMatchObject({ code: 'ARCHIVE_SAVE_UNAVAILABLE' })
        expect(persistLiveDatabaseUnderLease).not.toHaveBeenCalled()
        expect(storage.archiveCharacters).not.toHaveBeenCalled()
        expect(state.db.characters).toHaveLength(2)
    })

    test('keeps live bodies when a target changes during the server batch', async () => {
        state.db = { characters: chars(2), nodeOnlyArchivedCharacters: [] }
        storage.archiveCharacters.mockImplementation(async (ids: string[]) => {
            state.db.characters[0].name = 'Edited during archive'
            return okFor(ids)
        })

        await expect(archiveCharacters(['c0', 'c1'])).rejects.toMatchObject({ code: 'ARCHIVE_CHARACTER_CHANGED' })
        expect(state.db.characters.map((c: any) => c.chaId)).toEqual(['c0', 'c1'])
        expect(state.db.characters[0].name).toBe('Edited during archive')
        expect(state.db.nodeOnlyArchivedCharacters).toEqual([])
    })

    test('refuses a second run while one is in progress', async () => {
        state.db = { characters: chars(2), nodeOnlyArchivedCharacters: [] }
        let release!: () => void
        storage.archiveCharacters.mockImplementation((ids: string[]) => new Promise((r) => { release = () => r(okFor(ids)) }))
        const first = archiveCharacters(['c0'])
        await expect(archiveCharacters(['c1'])).rejects.toThrow('bulkArchiveBusy')
        await vi.waitFor(() => expect(storage.archiveCharacters).toHaveBeenCalledTimes(1))
        release()
        await first
        // Free again once the first run has finished.
        storage.archiveCharacters.mockImplementation(async (ids: string[]) => okFor(ids))
        expect(await archiveCharacters(['c1'])).toMatchObject({ done: 1 })
    })

    test('keeps the selected character selected by id, and deselects an archived one', async () => {
        state.db = { characters: chars(4), nodeOnlyArchivedCharacters: [] }
        selectedCharID.set(3)
        storage.archiveCharacters.mockImplementation(async (ids: string[]) => okFor(ids))
        await archiveCharacters(['c0', 'c1'])
        expect(get(selectedCharID)).toBe(1)
        expect(state.db.characters[1].chaId).toBe('c3')
        await archiveCharacters(['c3'])
        expect(deselectCharacter).toHaveBeenCalled()
        selectedCharID.set(-1)
    })
})

describe('trash keeps the folder', () => {
    // checkCharOrder is mocked out here; the real one drops trashed ids from
    // every folder, which `leaveOrder` stands in for.
    const leaveOrder = (chaId: string) => {
        for (const e of state.db.characterOrder) if (typeof e !== 'string') e.data = e.data.filter((id: string) => id !== chaId)
    }

    test('restoring puts the character back into the folder it was trashed from', () => {
        state.db = {
            characters: [],
            characterOrder: ['top', { id: 'F', name: 'F', data: ['c1', 'c2'], color: '' }],
            nodeOnlyArchivedCharacters: [{ ...stub }, { chaId: 'top', name: 'Top', archivedAt: 1 }],
        }
        expect(trashDeactivatedCharacter('c1')).toBe(true)
        expect(trashDeactivatedCharacter('top')).toBe(true)
        expect(state.db.nodeOnlyArchivedCharacters[0].trashedFromFolder).toBe('F')
        expect(state.db.nodeOnlyArchivedCharacters[1].trashedFromFolder).toBeUndefined()
        leaveOrder('c1')

        expect(restoreTrashedCharacter('c1')).toBe(true)
        expect(state.db.characterOrder[1].data).toEqual(['c2', 'c1'])
        expect(state.db.nodeOnlyArchivedCharacters[0].trashedAt).toBeUndefined()
        expect(state.db.nodeOnlyArchivedCharacters[0].trashedFromFolder).toBeUndefined()
    })

    test('a folder deleted meanwhile is not recreated', () => {
        state.db = {
            characters: [],
            characterOrder: [{ id: 'F', name: 'F', data: ['c1'], color: '' }],
            nodeOnlyArchivedCharacters: [{ ...stub }],
        }
        trashDeactivatedCharacter('c1')
        state.db.characterOrder = []
        expect(restoreTrashedCharacter('c1')).toBe(true)
        expect(state.db.characterOrder).toEqual([])
    })

    test('bulk trash records the folder of each character', async () => {
        state.db = {
            characters: [{ chaId: 'a', name: 'A', chats: [] }, { chaId: 'b', name: 'B', chats: [] }],
            characterOrder: ['a', { id: 'F', name: 'F', data: ['b'], color: '' }],
            nodeOnlyArchivedCharacters: [],
        }
        storage.archiveCharacters.mockResolvedValue([
            { chaId: 'a', ok: true, stub: { chaId: 'a', archivedAt: 1 } },
            { chaId: 'b', ok: true, stub: { chaId: 'b', archivedAt: 1 } },
        ])
        await archiveCharacters(['a', 'b'], { trash: true })
        const byId = Object.fromEntries(state.db.nodeOnlyArchivedCharacters.map((s: any) => [s.chaId, s]))
        expect(byId.a.trashedFromFolder).toBeUndefined()
        expect(byId.b.trashedFromFolder).toBe('F')
    })
})

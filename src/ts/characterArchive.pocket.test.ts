import { beforeEach, describe, expect, it, vi } from 'vitest'

const host = vi.hoisted(() => {
    const store = <T>(initial: T) => {
        let value = initial
        return {
            subscribe(run: (value: T) => void) {
                run(value)
                return () => undefined
            },
            set(next: T) { value = next },
        }
    }
    return {
        dbState: { db: { characters: [] as any[], nodeOnlyArchivedCharacters: [] as any[] } },
        selectedCharID: store(0),
        loadingOverlayStore: store({ active: false, text: '', onCancel: null as null }),
        archiveCharacter: vi.fn(),
        activateCharacter: vi.fn(),
        deleteArchivedCharacter: vi.fn(),
        fetchArchivedCharactersInline: vi.fn(),
        requestImmediateSave: vi.fn(),
        persistLiveDatabaseUnderLease: vi.fn(),
        getDbEtag: vi.fn(),
        checkCharOrder: vi.fn(),
        requiresFullEncoderReload: { state: false },
    }
})

vi.mock('src/lang', () => ({
    language: {
        loading: 'Loading',
        deactivateCharacterConfirm: (name: string) => `Deactivate ${name}?`,
        deactivateCharacterDone: 'Deactivated',
        trashCharacterDone: 'Trashed',
        deactivateCharacterUnsaved: 'Unsaved',
        deactivateCharacterFailed: 'Deactivate failed: ',
        activateCharacterConfirm: (name: string) => `Activate ${name}?`,
        activateCharacterMissing: 'Missing',
        activateCharacterRemoveStub: 'Remove stub',
        activateCharacterFailed: 'Activate failed: ',
    },
}))

vi.mock('./alert', () => ({
    alertConfirm: vi.fn(async () => true),
    alertError: vi.fn(),
    notifySuccess: vi.fn(),
}))

vi.mock('./characters', () => ({
    changeChar: vi.fn(),
    deselectCharacter: vi.fn(),
}))

vi.mock('./globalApi.svelte', () => ({
    checkCharOrder: host.checkCharOrder,
    forageStorage: {
        realStorage: {
            archiveCharacter: host.archiveCharacter,
            activateCharacter: host.activateCharacter,
            deleteArchivedCharacter: host.deleteArchivedCharacter,
            fetchArchivedCharactersInline: host.fetchArchivedCharactersInline,
        },
        getDbEtag: host.getDbEtag,
    },
    persistLiveDatabaseUnderLease: host.persistLiveDatabaseUnderLease,
    requestImmediateSave: host.requestImmediateSave,
    requiresFullEncoderReload: host.requiresFullEncoderReload,
}))

vi.mock('./stores.svelte', () => ({
    DBState: host.dbState,
    loadingOverlayStore: host.loadingOverlayStore,
    selectedCharID: host.selectedCharID,
}))

vi.mock('./storage/chatStorage', () => ({
    convertStubsToPlaceholders: (chats: unknown[]) => chats,
}))

vi.mock('./storage/database.svelte', () => ({
    getDatabase: ({ snapshot }: { snapshot?: boolean } = {}) => snapshot
        ? JSON.parse(JSON.stringify(host.dbState.db))
        : host.dbState.db,
}))

vi.mock('./storage/nodeStorage', () => {
    class CharacterArchiveError extends Error {
        constructor(public readonly code: string, message: string) {
            super(message)
            this.name = 'CharacterArchiveError'
        }
    }
    return { CharacterArchiveError }
})

import { activateCharacter, archiveCharacter } from './characterArchive'
import { generationStates, type GenState } from './process/generationState'
import { databasePersistenceCoordinator } from './storage/databasePersistenceCoordinator'

function deferred<T = void>() {
    let resolve!: (value: T | PromiseLike<T>) => void
    let reject!: (reason?: unknown) => void
    const promise = new Promise<T>((res, rej) => {
        resolve = res
        reject = rej
    })
    return { promise, resolve, reject }
}

function archivedStub(name = 'Archived') {
    return {
        chaId: 'character-a', name, archivedAt: 100,
        bytes: 1, chatCount: 0, chatIds: [], image: '', tags: [], lastInteraction: 0,
    }
}

describe('character archive database mutation ownership', () => {
    beforeEach(() => {
        host.dbState.db = { characters: [], nodeOnlyArchivedCharacters: [] }
        host.selectedCharID.set(0)
        host.requiresFullEncoderReload.state = false
        vi.clearAllMocks()
        host.requestImmediateSave.mockResolvedValue(undefined)
        host.persistLiveDatabaseUnderLease.mockResolvedValue(undefined)
        host.getDbEtag.mockReturnValue('etag:current')
        generationStates.set(new Map())
    })

    it('waits for an owned write and full-writes its acknowledged target before archiving', async () => {
        host.dbState.db = {
            characters: [{ chaId: 'character-a', name: 'Before write', chats: [] }],
            nodeOnlyArchivedCharacters: [],
        }
        const writerStarted = deferred()
        const releaseWriter = deferred()
        let persistedName: string | undefined
        let archivedName: string | undefined
        const writer = databasePersistenceCoordinator.runExclusiveMutation(async () => {
            writerStarted.resolve()
            await releaseWriter.promise
            host.dbState.db.characters[0].name = 'Acknowledged write'
        })
        await writerStarted.promise
        host.persistLiveDatabaseUnderLease.mockImplementation(async (snapshot: any) => {
            persistedName = snapshot.characters[0].name
        })
        host.archiveCharacter.mockImplementation(async () => {
            archivedName = persistedName
            return archivedStub(archivedName)
        })

        const archiving = archiveCharacter(0, { skipConfirm: true, silent: true })
        await Promise.resolve()
        const persistenceStartedBeforeAcknowledgement = host.persistLiveDatabaseUnderLease.mock.calls.length > 0
        releaseWriter.resolve()
        await writer
        await expect(archiving).resolves.toBe(true)

        expect(persistenceStartedBeforeAcknowledgement).toBe(false)
        expect(archivedName).toBe('Acknowledged write')
        expect(host.dbState.db.characters).toEqual([])
        expect(host.dbState.db.nodeOnlyArchivedCharacters).toHaveLength(1)
    })

    it('re-resolves the archive target after acquiring the lease instead of mutating a stale database', async () => {
        const staleDatabase = {
            characters: [{ chaId: 'character-a', name: 'Deleted concurrently', chats: [] }],
            nodeOnlyArchivedCharacters: [] as any[],
        }
        host.dbState.db = staleDatabase
        const priorStarted = deferred()
        const releasePrior = deferred()
        const prior = databasePersistenceCoordinator.runExclusiveMutation(async () => {
            priorStarted.resolve()
            await releasePrior.promise
            host.dbState.db = { characters: [], nodeOnlyArchivedCharacters: [] }
        })
        await priorStarted.promise
        host.archiveCharacter.mockResolvedValue(archivedStub('Deleted concurrently'))

        const archiving = archiveCharacter(0, { skipConfirm: true, silent: true })
        releasePrior.resolve()
        await prior
        await expect(archiving).resolves.toBe(false)

        expect(host.persistLiveDatabaseUnderLease).not.toHaveBeenCalled()
        expect(host.archiveCharacter).not.toHaveBeenCalled()
        expect(host.dbState.db.characters).toEqual([])
        expect(staleDatabase.nodeOnlyArchivedCharacters).toEqual([])
    })

    it.each(['live', 'background'] as const)('rejects while a %s generation is active', async (kind) => {
        host.dbState.db = {
            characters: [{ chaId: 'character-a', name: 'Generating', chats: [] }],
            nodeOnlyArchivedCharacters: [],
        }
        generationStates.set(new Map<string, GenState>([[
            'chat-a', { generationId: 'generation-a', kind, startedAt: 0 },
        ]]))

        await expect(archiveCharacter(0, { skipConfirm: true, silent: true }))
            .rejects.toMatchObject({ code: 'ARCHIVE_GENERATION_ACTIVE' })

        expect(host.dbState.db.characters).toHaveLength(1)
        expect(host.persistLiveDatabaseUnderLease).not.toHaveBeenCalled()
        expect(host.archiveCharacter).not.toHaveBeenCalled()
    })

    it('rejects when a generation starts during the acknowledged full write', async () => {
        host.dbState.db = {
            characters: [{ chaId: 'character-a', name: 'Stable', chats: [] }],
            nodeOnlyArchivedCharacters: [],
        }
        host.persistLiveDatabaseUnderLease.mockImplementation(async () => {
            generationStates.set(new Map<string, GenState>([[
                'chat-a', { generationId: 'generation-a', kind: 'live', startedAt: 0 },
            ]]))
        })

        await expect(archiveCharacter(0, { skipConfirm: true, silent: true }))
            .rejects.toMatchObject({ code: 'ARCHIVE_GENERATION_ACTIVE' })

        expect(host.dbState.db.characters).toHaveLength(1)
        expect(host.archiveCharacter).not.toHaveBeenCalled()
    })

    it('leaves the live body when a generation starts during archive HTTP', async () => {
        host.dbState.db = {
            characters: [{ chaId: 'character-a', name: 'Stable', chats: [] }],
            nodeOnlyArchivedCharacters: [],
        }
        host.archiveCharacter.mockImplementation(async () => {
            generationStates.set(new Map<string, GenState>([[
                'chat-a', { generationId: 'generation-a', kind: 'background', startedAt: 0 },
            ]]))
            return archivedStub('Stable')
        })

        await expect(archiveCharacter(0, { skipConfirm: true, silent: true }))
            .rejects.toMatchObject({ code: 'ARCHIVE_GENERATION_ACTIVE' })

        expect(host.dbState.db.characters.map((char) => char.chaId)).toEqual(['character-a'])
        expect(host.dbState.db.nodeOnlyArchivedCharacters).toEqual([])
    })

    it('rejects a target edit made during the acknowledged full write before archive HTTP', async () => {
        host.dbState.db = {
            characters: [{ chaId: 'character-a', name: 'Before edit', chats: [] }],
            nodeOnlyArchivedCharacters: [],
        }
        host.persistLiveDatabaseUnderLease.mockImplementation(async () => {
            host.dbState.db.characters[0].name = 'Edited during write'
        })

        await expect(archiveCharacter(0, { skipConfirm: true, silent: true }))
            .rejects.toMatchObject({ code: 'ARCHIVE_CHARACTER_CHANGED' })

        expect(host.dbState.db.characters[0].name).toBe('Edited during write')
        expect(host.archiveCharacter).not.toHaveBeenCalled()
    })

    it('leaves the edited live body when the target changes during archive HTTP', async () => {
        host.dbState.db = {
            characters: [{ chaId: 'character-a', name: 'Before edit', chats: [] }],
            nodeOnlyArchivedCharacters: [],
        }
        host.archiveCharacter.mockImplementation(async () => {
            host.dbState.db.characters[0].name = 'Edited during archive'
            return archivedStub('Before edit')
        })

        await expect(archiveCharacter(0, { skipConfirm: true, silent: true }))
            .rejects.toMatchObject({ code: 'ARCHIVE_CHARACTER_CHANGED' })

        expect(host.dbState.db.characters[0].name).toBe('Edited during archive')
        expect(host.dbState.db.nodeOnlyArchivedCharacters).toEqual([])
    })

    it('does not call archive HTTP when the acknowledged full write rejects', async () => {
        host.dbState.db = {
            characters: [{ chaId: 'character-a', name: 'Unsaved', chats: [] }],
            nodeOnlyArchivedCharacters: [],
        }
        host.persistLiveDatabaseUnderLease.mockRejectedValue(new Error('write failed'))

        await expect(archiveCharacter(0, { skipConfirm: true, silent: true }))
            .rejects.toThrow('write failed')

        expect(host.dbState.db.characters).toHaveLength(1)
        expect(host.archiveCharacter).not.toHaveBeenCalled()
    })

    it('refuses an unbound full write when no database ETag is available', async () => {
        host.dbState.db = {
            characters: [{ chaId: 'character-a', name: 'Unbound', chats: [] }],
            nodeOnlyArchivedCharacters: [],
        }
        host.getDbEtag.mockReturnValue(null)

        await expect(archiveCharacter(0, { skipConfirm: true, silent: true }))
            .rejects.toMatchObject({ code: 'ARCHIVE_SAVE_UNAVAILABLE' })

        expect(host.persistLiveDatabaseUnderLease).not.toHaveBeenCalled()
        expect(host.archiveCharacter).not.toHaveBeenCalled()
        expect(host.dbState.db.characters).toHaveLength(1)
    })

    it('holds activation ownership through the server read and the live list move', async () => {
        host.dbState.db = {
            characters: [],
            nodeOnlyArchivedCharacters: [{ chaId: 'character-a', name: 'Archived', archivedAt: 100 }],
        }
        const activationStarted = deferred()
        const releaseActivation = deferred()
        host.activateCharacter.mockImplementation(async () => {
            activationStarted.resolve()
            await releaseActivation.promise
            return { chaId: 'character-a', name: 'Active', chats: [] }
        })

        const activating = activateCharacter('character-a')
        await activationStarted.promise

        let competingMutationSettled = false
        const competingMutation = databasePersistenceCoordinator.runExclusiveMutation(() => {
            competingMutationSettled = true
        })
        await Promise.resolve()
        const overlappedServerActivation = competingMutationSettled

        releaseActivation.resolve()
        await expect(activating).resolves.toBe(0)
        await competingMutation

        expect(overlappedServerActivation).toBe(false)
        expect(host.dbState.db.characters.map((char) => char.chaId)).toEqual(['character-a'])
        expect(host.dbState.db.nodeOnlyArchivedCharacters).toEqual([])
    })

    it('re-resolves activation state after a prior owned mutation makes the character active', async () => {
        const stub = { chaId: 'character-a', name: 'Archived', archivedAt: 100 }
        host.dbState.db = { characters: [], nodeOnlyArchivedCharacters: [stub] }
        host.activateCharacter.mockResolvedValue({ chaId: 'character-a', name: 'Stale restore', chats: [] })
        const priorStarted = deferred()
        const releasePrior = deferred()
        const prior = databasePersistenceCoordinator.runExclusiveMutation(async () => {
            priorStarted.resolve()
            await releasePrior.promise
            host.dbState.db = {
                characters: [{ chaId: 'character-a', name: 'Already active', chats: [] }],
                nodeOnlyArchivedCharacters: [stub],
            }
        })
        await priorStarted.promise

        const activating = activateCharacter('character-a')
        await Promise.resolve()
        const serverReadStartedAgainstStaleState = host.activateCharacter.mock.calls.length > 0
        releasePrior.resolve()
        await prior
        await expect(activating).resolves.toBe(0)

        expect(serverReadStartedAgainstStaleState).toBe(false)
        expect(host.activateCharacter).not.toHaveBeenCalled()
        expect(host.dbState.db.characters.map((char) => char.name)).toEqual(['Already active'])
        expect(host.dbState.db.nodeOnlyArchivedCharacters).toEqual([])
    })
})

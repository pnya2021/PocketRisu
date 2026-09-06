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
    },
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

describe('character archive database mutation ownership', () => {
    beforeEach(() => {
        host.dbState.db = { characters: [], nodeOnlyArchivedCharacters: [] }
        host.selectedCharID.set(0)
        host.requiresFullEncoderReload.state = false
        vi.clearAllMocks()
        host.requestImmediateSave.mockResolvedValue(undefined)
    })

    it('waits for an acknowledged owned write before taking the server archive snapshot', async () => {
        host.dbState.db = {
            characters: [{ chaId: 'character-a', name: 'Before write', chats: [] }],
            nodeOnlyArchivedCharacters: [],
        }
        const writerStarted = deferred()
        const releaseWriter = deferred()
        let writer: Promise<void> | undefined
        let persistedName = 'Before write'
        let archivedName: string | undefined

        // Model requestImmediateSave's real ordering: its normal save completes,
        // then another owned message mutation obtains the shared coordinator
        // before archiveCharacter's await continuation resumes.
        host.requestImmediateSave.mockImplementationOnce(async () => {
            await databasePersistenceCoordinator.runNormalWrite(
                databasePersistenceCoordinator.captureGeneration(),
                () => undefined,
            )
            writer = databasePersistenceCoordinator.runExclusiveMutation(async () => {
                writerStarted.resolve()
                await releaseWriter.promise
                persistedName = 'Acknowledged write'
            })
        })
        host.archiveCharacter.mockImplementation(async () => {
            archivedName = persistedName
            return {
                chaId: 'character-a',
                name: archivedName,
                archivedAt: 100,
                bytes: 1,
                chatCount: 0,
                chatIds: [],
                image: '',
                tags: [],
                lastInteraction: 0,
            }
        })

        const archiving = archiveCharacter(0, { skipConfirm: true, silent: true })
        await writerStarted.promise
        await Promise.resolve()
        const archiveStartedBeforeAcknowledgement = host.archiveCharacter.mock.calls.length > 0
        releaseWriter.resolve()
        await writer
        await expect(archiving).resolves.toBe(true)

        expect(archiveStartedBeforeAcknowledgement).toBe(false)
        expect(archivedName).toBe('Acknowledged write')
        expect(host.dbState.db.characters).toEqual([])
        expect(host.dbState.db.nodeOnlyArchivedCharacters).toHaveLength(1)
    })

    it('re-resolves the archive target after the pre-save lease instead of mutating a stale database', async () => {
        const staleDatabase = {
            characters: [{ chaId: 'character-a', name: 'Deleted concurrently', chats: [] }],
            nodeOnlyArchivedCharacters: [] as any[],
        }
        host.dbState.db = staleDatabase
        host.requestImmediateSave.mockImplementationOnce(async () => {
            await databasePersistenceCoordinator.runExclusiveMutation(() => {
                host.dbState.db = { characters: [], nodeOnlyArchivedCharacters: [] }
            })
        })
        host.archiveCharacter.mockResolvedValue({
            chaId: 'character-a', name: 'Deleted concurrently', archivedAt: 100,
            bytes: 1, chatCount: 0, chatIds: [], image: '', tags: [], lastInteraction: 0,
        })

        await expect(archiveCharacter(0, { skipConfirm: true, silent: true })).resolves.toBe(false)

        expect(host.archiveCharacter).not.toHaveBeenCalled()
        expect(host.dbState.db.characters).toEqual([])
        expect(staleDatabase.nodeOnlyArchivedCharacters).toEqual([])
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

import { describe, expect, it, vi } from 'vitest'
import { DatabasePersistenceCoordinator } from './databasePersistenceCoordinator'
import { runCoordinatedConflictRebase } from './coordinatedConflictRebase'

describe('coordinated conflict rebase', () => {
    it('keeps a restore behind a pending latest-read so the restore lands last', async () => {
        const coordinator = new DatabasePersistenceCoordinator()
        const events: string[] = []
        let releaseRead!: () => void
        let markReadStarted!: () => void
        const readGate = new Promise<void>((resolve) => { releaseRead = resolve })
        const readStarted = new Promise<void>((resolve) => { markReadStarted = resolve })

        const rebase = runCoordinatedConflictRebase(coordinator.captureGeneration(), {
            readLatest: async () => {
                events.push('rebase-read')
                markReadStarted()
                await readGate
                return { source: 'server-before-restore' }
            },
            applyLatest: async () => { events.push('rebase-write') },
        }, coordinator)
        await readStarted
        const restore = coordinator.runExclusiveMutation(async () => { events.push('restore-write') })
        await Promise.resolve()
        expect(events).toEqual(['rebase-read'])

        releaseRead()
        await Promise.all([rebase, restore])
        expect(events).toEqual(['rebase-read', 'rebase-write', 'restore-write'])
    })

    it('skips every stale rebase read and write when a queued restore changes generation first', async () => {
        const coordinator = new DatabasePersistenceCoordinator()
        const failedSaveGeneration = coordinator.captureGeneration()
        await expect(coordinator.runNormalWrite(failedSaveGeneration, async () => {
            throw new Error('etag conflict')
        })).rejects.toThrow('etag conflict')

        let releaseRestore!: () => void
        let markRestoreStarted!: () => void
        const restoreGate = new Promise<void>((resolve) => { releaseRestore = resolve })
        const restoreStarted = new Promise<void>((resolve) => { markRestoreStarted = resolve })
        const restore = coordinator.runExclusiveMutation(async () => {
            markRestoreStarted()
            await restoreGate
        })
        await restoreStarted
        const readLatest = vi.fn(async () => ({ source: 'stale' }))
        const applyLatest = vi.fn()
        const rebase = runCoordinatedConflictRebase(failedSaveGeneration, { readLatest, applyLatest }, coordinator)
        releaseRestore()

        await restore
        await expect(rebase).resolves.toEqual({ executed: false })
        expect(readLatest).not.toHaveBeenCalled()
        expect(applyLatest).not.toHaveBeenCalled()
    })
})

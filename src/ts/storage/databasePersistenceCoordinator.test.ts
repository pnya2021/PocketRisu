import { describe, expect, it, vi } from 'vitest'
import { DatabasePersistenceCoordinator } from './databasePersistenceCoordinator'

describe('database persistence coordinator', () => {
    it('lets an in-flight normal save finish before an exclusive restore lands last', async () => {
        const coordinator = new DatabasePersistenceCoordinator()
        const events: string[] = []
        let releaseSave!: () => void
        const saveGate = new Promise<void>((resolve) => { releaseSave = resolve })
        const token = coordinator.captureGeneration()
        const save = coordinator.runNormalWrite(token, async () => { events.push('save:start'); await saveGate; events.push('save:end') })
        await Promise.resolve()
        const restore = coordinator.runExclusiveMutation(async () => { events.push('restore') })
        await Promise.resolve()
        expect(events).toEqual(['save:start'])
        releaseSave()
        await Promise.all([save, restore])
        expect(events).toEqual(['save:start', 'save:end', 'restore'])
    })

    it('invalidates a stale save captured before an exclusive restore without deadlocking async rebase work', async () => {
        const coordinator = new DatabasePersistenceCoordinator()
        const staleToken = coordinator.captureGeneration()
        let releaseRestore!: () => void
        const restoreGate = new Promise<void>((resolve) => { releaseRestore = resolve })
        const events: string[] = []
        const restore = coordinator.runExclusiveMutation(async () => { events.push('restore:start'); await restoreGate; events.push('restore:end') })
        await Promise.resolve()
        const staleSave = coordinator.runNormalWrite(staleToken, async () => { events.push('stale-save') })
        releaseRestore()
        const [, result] = await Promise.all([restore, staleSave])
        expect(result.executed).toBe(false)
        expect(events).toEqual(['restore:start', 'restore:end'])
    })

    it('fences fresh normal writes when an irreversible restore may have committed before failing', async () => {
        const coordinator = new DatabasePersistenceCoordinator()
        let backingDatabase = 'old'
        await expect(coordinator.runFailClosedExclusiveMutation(async () => {
            backingDatabase = 'restored'
            throw new Error('response lost after commit')
        })).rejects.toThrow('response lost after commit')

        const writeOldLiveDatabase = vi.fn(() => { backingDatabase = 'old-live' })
        const freshGeneration = coordinator.captureGeneration()
        await expect(coordinator.runNormalWrite(freshGeneration, writeOldLiveDatabase))
            .resolves.toEqual({ executed: false })
        expect(writeOldLiveDatabase).not.toHaveBeenCalled()
        expect(backingDatabase).toBe('restored')
    })

    it('fences queued exclusive and generation-bound writers after an uncertain mutation', async () => {
        const coordinator = new DatabasePersistenceCoordinator()
        let releaseRestore!: () => void
        let markRestoreStarted!: () => void
        const restoreGate = new Promise<void>((resolve) => { releaseRestore = resolve })
        const restoreStarted = new Promise<void>((resolve) => { markRestoreStarted = resolve })
        const uncertainRestore = coordinator.runFailClosedExclusiveMutation(async () => {
            markRestoreStarted()
            await restoreGate
            throw new Error('response lost after commit')
        })
        await restoreStarted

        const exclusiveWrite = vi.fn()
        const generationWrite = vi.fn()
        const queuedExclusive = coordinator.runExclusiveMutation(exclusiveWrite)
        const queuedAtGeneration = coordinator.runExclusiveMutationAtGeneration(
            coordinator.captureGeneration(),
            generationWrite,
        )
        releaseRestore()

        await expect(uncertainRestore).rejects.toThrow('response lost after commit')
        await expect(queuedExclusive).rejects.toThrow('fail-closed')
        await expect(queuedAtGeneration).resolves.toEqual({ executed: false })
        await expect(coordinator.runExclusiveMutationAtGeneration(
            coordinator.captureGeneration(),
            generationWrite,
        )).resolves.toEqual({ executed: false })
        const secondUncertainMutation = vi.fn()
        await expect(coordinator.runFailClosedExclusiveMutation(secondUncertainMutation))
            .rejects.toThrow('fail-closed')
        expect(exclusiveWrite).not.toHaveBeenCalled()
        expect(generationWrite).not.toHaveBeenCalled()
        expect(secondUncertainMutation).not.toHaveBeenCalled()
    })
})

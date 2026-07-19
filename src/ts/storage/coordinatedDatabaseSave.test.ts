import { describe, expect, it, vi } from 'vitest'
import { commitCoordinatedDatabaseSave } from './coordinatedDatabaseSave'
import { DatabasePersistenceCoordinator } from './databasePersistenceCoordinator'

describe('coordinated normal database save', () => {
    it('keeps old chat sidecars and database bytes together so a waiting restore lands last', async () => {
        const coordinator = new DatabasePersistenceCoordinator()
        const events: string[] = []
        let releaseChat!: () => void
        let markChatStarted!: () => void
        const chatGate = new Promise<void>((resolve) => { releaseChat = resolve })
        const chatStarted = new Promise<void>((resolve) => { markChatStarted = resolve })
        const generation = coordinator.captureGeneration()
        const normal = commitCoordinatedDatabaseSave({
            generation,
            writeSidecars: async () => {
                events.push('old-chat-start')
                markChatStarted()
                await chatGate
                events.push('old-chat-end')
            },
            writeDatabase: async () => { events.push('old-database') },
        }, coordinator)
        await chatStarted
        const restore = coordinator.runExclusiveMutation(async () => { events.push('restore') })
        await Promise.resolve()
        expect(events).toEqual(['old-chat-start'])
        releaseChat()
        await Promise.all([normal, restore])
        expect(events).toEqual(['old-chat-start', 'old-chat-end', 'old-database', 'restore'])
    })

    it('executes no old chat or database write when restore acquires first', async () => {
        const coordinator = new DatabasePersistenceCoordinator()
        const oldGeneration = coordinator.captureGeneration()
        let releaseRestore!: () => void
        let markRestoreStarted!: () => void
        const restoreGate = new Promise<void>((resolve) => { releaseRestore = resolve })
        const restoreStarted = new Promise<void>((resolve) => { markRestoreStarted = resolve })
        const restore = coordinator.runExclusiveMutation(async () => {
            markRestoreStarted()
            await restoreGate
        })
        await restoreStarted
        const sidecar = vi.fn()
        const database = vi.fn()
        const normal = commitCoordinatedDatabaseSave({
            generation: oldGeneration,
            writeSidecars: sidecar,
            writeDatabase: database,
        }, coordinator)
        releaseRestore()
        await restore
        await expect(normal).resolves.toEqual({ executed: false })
        expect(sidecar).not.toHaveBeenCalled()
        expect(database).not.toHaveBeenCalled()
    })

    it('releases the normal lease before conflict rebase enters the exclusive path', async () => {
        const coordinator = new DatabasePersistenceCoordinator()
        const events: string[] = []
        const workflow = (async () => {
            try {
                await commitCoordinatedDatabaseSave({
                    generation: coordinator.captureGeneration(),
                    writeSidecars: async () => { events.push('chat') },
                    writeDatabase: async () => {
                        events.push('conflict')
                        throw new Error('etag conflict')
                    },
                }, coordinator)
            } catch {
                await coordinator.runExclusiveMutation(async () => { events.push('rebase') })
            }
        })()
        await expect(Promise.race([
            workflow.then(() => 'complete'),
            new Promise<string>((resolve) => setTimeout(() => resolve('deadlocked'), 500)),
        ])).resolves.toBe('complete')
        expect(events).toEqual(['chat', 'conflict', 'rebase'])
    })
})

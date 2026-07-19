import { databasePersistenceCoordinator, type DatabasePersistenceCoordinator } from './databasePersistenceCoordinator'

export interface CoordinatedDatabaseSave<T> {
    generation: number
    writeSidecars: () => void | Promise<void>
    writeDatabase: () => T | Promise<T>
    finalize?: (result: T) => void | Promise<void>
}

/**
 * Commits every externally visible part of one normal save under one lease.
 * Snapshot construction and encoding stay outside; a restore invalidates their
 * generation before any sidecar or database write can execute.
 */
export function commitCoordinatedDatabaseSave<T>(
    save: CoordinatedDatabaseSave<T>,
    coordinator: DatabasePersistenceCoordinator = databasePersistenceCoordinator,
) {
    return coordinator.runNormalWrite(save.generation, async () => {
        await save.writeSidecars()
        const result = await save.writeDatabase()
        await save.finalize?.(result)
        return result
    })
}

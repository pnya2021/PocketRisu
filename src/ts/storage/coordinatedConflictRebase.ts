import { databasePersistenceCoordinator, type DatabasePersistenceCoordinator } from './databasePersistenceCoordinator'

/**
 * Keeps the winning-server read and every derived live/persistent write in
 * one exclusive generation. A restore queued while the read is pending must
 * land after the rebase, never between its read and write.
 */
export function runCoordinatedConflictRebase<T>(
    expectedGeneration: number,
    operation: {
        readLatest: () => T | null | Promise<T | null>
        applyLatest: (latest: T) => void | Promise<void>
    },
    coordinator: DatabasePersistenceCoordinator = databasePersistenceCoordinator,
) {
    return coordinator.runExclusiveMutationAtGeneration(expectedGeneration, async () => {
        const latest = await operation.readLatest()
        if (latest !== null) await operation.applyLatest(latest)
    })
}

export class DatabasePersistenceCoordinator {
    private tail: Promise<void> = Promise.resolve()
    private generation = 0
    private normalWritesBlocked = false

    captureGeneration() { return this.generation }

    private async withLease<T>(operation: () => T | Promise<T>): Promise<T> {
        let release!: () => void
        const previous = this.tail
        this.tail = new Promise<void>((resolve) => { release = resolve })
        await previous
        try { return await operation() } finally { release() }
    }

    runNormalWrite<T>(expectedGeneration: number, write: () => T | Promise<T>) {
        return this.withLease(async () => {
            if (this.normalWritesBlocked || expectedGeneration !== this.generation) {
                return { executed: false as const }
            }
            return { executed: true as const, value: await write() }
        })
    }

    runExclusiveMutation<T>(mutation: () => T | Promise<T>) {
        return this.withLease(async () => {
            if (this.normalWritesBlocked) {
                throw new Error('Database persistence coordinator is fail-closed')
            }
            this.generation += 1
            try { return await mutation() } finally { this.generation += 1 }
        })
    }

    runExclusiveMutationAtGeneration<T>(expectedGeneration: number, mutation: () => T | Promise<T>) {
        return this.withLease(async () => {
            if (this.normalWritesBlocked || expectedGeneration !== this.generation) {
                return { executed: false as const }
            }
            this.generation += 1
            try {
                return { executed: true as const, value: await mutation() }
            } finally {
                this.generation += 1
            }
        })
    }

    /**
     * Runs an externally irreversible mutation and permanently fences normal
     * writes in this page session if its outcome is uncertain. Navigation is
     * then responsible for loading the authoritative persisted database.
     */
    runFailClosedExclusiveMutation<T>(mutation: () => T | Promise<T>) {
        return this.withLease(async () => {
            if (this.normalWritesBlocked) {
                throw new Error('Database persistence coordinator is fail-closed')
            }
            this.generation += 1
            try {
                return await mutation()
            } catch (error) {
                this.normalWritesBlocked = true
                throw error
            } finally {
                this.generation += 1
            }
        })
    }
}

export const databasePersistenceCoordinator = new DatabasePersistenceCoordinator()

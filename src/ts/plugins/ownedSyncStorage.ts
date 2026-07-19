export interface OwnedSyncStorageBackend<T> {
    setItem(key: string, value: T): void
    removeItem(key: string): void
    clear(): void
}

export function createOwnedSyncStorageMutations<T>(options: {
    storage: OwnedSyncStorageBackend<T>
    canMutate: () => boolean
    recordOwner: (key: string) => boolean
    removeOwner: (key: string) => void
    clearOwners: () => void
}) {
    return {
        setItem(key: string, value: T) {
            if (!options.canMutate() || !options.recordOwner(key)) return false
            options.storage.setItem(key, value)
            return true
        },
        removeItem(key: string) {
            if (!options.canMutate()) return false
            options.storage.removeItem(key)
            options.removeOwner(key)
            return true
        },
        clear() {
            if (!options.canMutate()) return false
            options.storage.clear()
            options.clearOwners()
            return true
        },
    }
}

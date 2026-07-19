export interface EtagBoundDatabaseStorage {
    getDbEtag(): string | null
    setItem(key: string, value: Uint8Array, etag?: string): Promise<unknown>
}

export function writeEtagBoundDatabase(storage: EtagBoundDatabaseStorage, value: Uint8Array) {
    const currentEtag = storage.getDbEtag()
    return storage.setItem('database/database.bin', value, currentEtag ?? undefined)
}

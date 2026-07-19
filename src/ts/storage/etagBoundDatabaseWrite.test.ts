import { describe, expect, it, vi } from 'vitest'
import { writeEtagBoundDatabase } from './etagBoundDatabaseWrite'

describe('ETag-bound normalized database writes', () => {
    it('passes the current database ETag as the write precondition', async () => {
        const setItem = vi.fn(async () => undefined)
        await writeEtagBoundDatabase({ getDbEtag: () => 'etag-current', setItem }, new Uint8Array([1, 2, 3]))
        expect(setItem).toHaveBeenCalledWith('database/database.bin', new Uint8Array([1, 2, 3]), 'etag-current')
    })

    it('propagates a conflict so callers keep plugins fail-closed', async () => {
        const conflict = Object.assign(new Error('conflict'), { name: 'ConflictError', status: 409 })
        const storage = {
            getDbEtag: () => 'stale-etag',
            setItem: vi.fn(async () => { throw conflict }),
        }
        await expect(writeEtagBoundDatabase(storage, new Uint8Array([4]))).rejects.toBe(conflict)
        expect(storage.setItem).toHaveBeenCalledWith('database/database.bin', new Uint8Array([4]), 'stale-etag')
    })
})

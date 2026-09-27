/**
 * Character archive — shown to users as "deactivate / activate".
 *
 * A deactivated character leaves `db.characters` and is kept as a small stub in
 * `db.nodeOnlyArchivedCharacters`; its full body (chats, asset list) lives on
 * the server in kv `archive/<chaId>/<archivedAt>` (one immutable row per
 * deactivation; the stub names its row). Lists render the stub in place (dimmed)
 * and every other consumer — plugins, scripts, search, dataset export — sees
 * the character as if it had been deleted.
 *
 * Both moves happen here on the client, after the server has written/read the
 * payload, so the change reaches the server through the normal save path
 * (/api/patch) and dbCache, hashes and etag stay in one flow. The server
 * rejects a patch that would leave a chaId in both lists.
 */
import { get } from "svelte/store"
import { language } from "src/lang"
import { alertConfirm, alertError, notifyError, notifySuccess } from "./alert"
import { changeChar, deselectCharacter } from "./characters"
import { checkCharOrder, flushSaves, forageStorage, persistLiveDatabaseUnderLease, requestImmediateSave, requiresFullEncoderReload, trackCharacterForSave } from "./globalApi.svelte"
import { generationStates } from "./process/generationState"
import { DBState, loadingOverlayStore, selectedCharID } from "./stores.svelte"
import { convertStubsToPlaceholders } from "./storage/chatStorage"
import { getDatabase, type ArchivedCharacterStub, type character, type Database } from "./storage/database.svelte"
import { databasePersistenceCoordinator } from "./storage/databasePersistenceCoordinator"
import { CharacterArchiveError, type ArchiveBatchResult, type NodeStorage } from "./storage/nodeStorage"
import { v4 } from "uuid"

export { CharacterArchiveError }

function storage(): NodeStorage {
    return forageStorage.realStorage as NodeStorage
}

export function getArchivedStubs(): ArchivedCharacterStub[] {
    return DBState.db.nodeOnlyArchivedCharacters ?? []
}

export function findArchivedStub(chaId: string): ArchivedCharacterStub | undefined {
    return getArchivedStubs().find((s) => s?.chaId === chaId)
}

// The trash takes a character out of characterOrder (checkCharOrder), folder
// included. Remember the folder so restoring can put it back.
function markTrashed(stub: ArchivedCharacterStub, trashedAt: number) {
    stub.trashedAt = trashedAt
    const folder = DBState.db.characterOrder?.find((e) => typeof e !== 'string' && e?.data?.includes(stub.chaId))
    if (folder && typeof folder !== 'string') stub.trashedFromFolder = folder.id
    else delete stub.trashedFromFolder
}

export function isArchivedCharacter(chaId: string): boolean {
    return !!findArchivedStub(chaId)
}

function withOverlay<T>(fn: () => Promise<T>): Promise<T> {
    loadingOverlayStore.set({ active: true, text: language.loading ?? '', onCancel: null })
    return fn().finally(() => {
        loadingOverlayStore.set({ active: false, text: '', onCancel: null })
    })
}

function bulletList(names: string[], max = 5): string {
    const lines = names.slice(0, max).map((n) => `• ${n || '—'}`)
    if (names.length > max) lines.push(`• … +${names.length - max}`)
    return lines.join('\n')
}

/**
 * Deactivate the character at `index`. Asks for confirmation, then:
 * server writes + verifies the payload → the character moves from
 * `characters` to the stub list (one save tick) → selection is cleared.
 * Returns true when the character was deactivated.
 */
export async function archiveCharacter(index: number, arg: { skipConfirm?: boolean; trash?: boolean; trashedAt?: number; silent?: boolean } = {}): Promise<boolean> {
    const char = DBState.db.characters[index]
    if (!char?.chaId) return false
    const chaId = char.chaId
    const name = char.name || 'Unnamed'
    // skipConfirm: bulk callers (character manager) confirm once for the whole set.
    // trash: the trash is "deactivated + trashedAt marker" — same server row,
    // the stub just carries the marker (exported as upstream's trashTime).
    if (!arg.skipConfirm && !await alertConfirm(language.deactivateCharacterConfirm(name))) return false

    // A missing server chat body can be accepted for trash, but ordinary
    // deactivation asks before archiving the empty chat the user can see.
    const run = async (acceptLostChats: boolean) => {
        const archived = await databasePersistenceCoordinator.runExclusiveMutation(async () => {
            // Resolve only after obtaining ownership: a preceding save/rebase
            // may have replaced the database while the confirmation was open.
            assertArchiveGenerationIdle()
            const liveMatches = (DBState.db.characters ?? []).filter((candidate) => candidate?.chaId === chaId)
            if (liveMatches.length === 0) return false
            if (liveMatches.length !== 1) {
                throw new CharacterArchiveError(
                    'ARCHIVE_CHARACTER_CHANGED',
                    'The character identity is ambiguous. Reload before retrying deactivation.',
                )
            }
            // Archive must not turn an initial, unbound write into a blind
            // overwrite of a foreign database revision.
            if (!forageStorage.getDbEtag()) {
                throw new CharacterArchiveError(
                    'ARCHIVE_SAVE_UNAVAILABLE',
                    'The saved database revision is unavailable. Reload before deactivating a character.',
                )
            }

            // Id-less loaded chats are invisible to the normal split save path.
            // Give them stable identities while ownership is held, then include
            // their bodies in the acknowledged full snapshot below.
            let assignedIds = false
            for (const chat of liveMatches[0].chats ?? []) {
                if (chat && !chat._placeholder && !chat.id) {
                    chat.id = v4()
                    assignedIds = true
                }
            }
            if (assignedIds) trackCharacterForSave(chaId)
            const databaseSnapshot = getDatabase({ snapshot: true })
            const snapshotMatches = (databaseSnapshot.characters ?? [])
                .filter((candidate) => candidate?.chaId === chaId)
            const targetSignature = archiveTargetSignature(snapshotMatches[0])

            // The debounce save can coalesce or absorb failures. Use an
            // acknowledged, ETag-bound full write of the exact snapshot instead.
            await persistLiveDatabaseUnderLease(databaseSnapshot)
            assertArchiveTargetUnchanged(chaId, targetSignature)

            // Generations are checked separately because their incremental
            // writes can occur outside the coordinator.
            const stub = await storage().archiveCharacter(chaId, { acceptLostChats })
            assertArchiveTargetUnchanged(chaId, targetSignature)

            const db = DBState.db
            const idx = db.characters.findIndex((candidate) => candidate?.chaId === chaId)
            if (idx === -1) {
                throw new CharacterArchiveError(
                    'ARCHIVE_CHARACTER_CHANGED',
                    'The character changed while preparing deactivation. Retry the operation.',
                )
            }
            if (!Array.isArray(db.nodeOnlyArchivedCharacters)) db.nodeOnlyArchivedCharacters = []
            if (arg.trash) markTrashed(stub, arg.trashedAt ?? Date.now())
            db.nodeOnlyArchivedCharacters.push(stub)
            const selectedIndex = get(selectedCharID)
            db.characters.splice(idx, 1)
            checkCharOrder()
            requiresFullEncoderReload.state = true
            // Keep whatever else was selected (bulk actions and the boot-time
            // trash migration run while a chat may be open); only the archived
            // character itself loses the selection. Indices after `idx` shift by one.
            if (selectedIndex === idx || selectedIndex < 0) deselectCharacter()
            else if (selectedIndex > idx) selectedCharID.set(selectedIndex - 1)
            return true
        })
        // Normal saves acquire the same coordinator; do not wait for one while
        // this mutation owns the exclusive lease.
        if (archived) {
            if (arg.silent) {
                void requestImmediateSave()
            } else if (await flushSaves()) {
                notifySuccess(arg.trash ? language.trashCharacterDone : language.deactivateCharacterDone)
            } else {
                notifyError(language.archiveSavePending)
            }
        }
        return archived
    }
    // silent: no overlay, no dialogs — the caller reports (migration logs).
    const attempt = (acceptLostChats: boolean) => arg.silent ? run(acceptLostChats) : withOverlay(() => run(acceptLostChats))
    const fail = (error: unknown) => {
        alertError(language.deactivateCharacterFailed + (error instanceof Error ? error.message : String(error)))
        return false
    }
    try {
        return await attempt(!!arg.trash)
    } catch (error) {
        if (arg.silent) throw error
        if (!(error instanceof CharacterArchiveError && error.code === 'ARCHIVE_CHATS_UNAVAILABLE')) return fail(error)
        if (!await alertConfirm(language.deactivateCharacterLostChats(name, error.chats.length, bulletList(error.chats)))) return false
        return await attempt(true).catch(fail)
    }
}

const BULK_ARCHIVE_CHUNK = 20
let bulkArchiveRunning = false

export interface BulkArchiveOutcome {
    /** Characters moved to the stub list. */
    done: number
    /** Characters left active, with the reason. */
    failed: { chaId: string; name: string; reason: string }[]
    /** Refused because some chats have no content anywhere (only without acceptLostChats). */
    lost: { chaId: string; name: string; chats: string[] }[]
    /** A save did not land; later chunks were not attempted. */
    stopped: boolean
}

export function isBulkArchiveRunning(): boolean {
    return bulkArchiveRunning
}

// The chunk's successes, applied in one synchronous step to the database
// current after the request: the characters leave `characters`, their stubs
// join the stub list, the order is normalised once and the selection follows
// its character by id.
function applyArchived(successes: { chaId: string; stub: any }[], trash: boolean): number {
    const db = DBState.db
    const selectedChaId = db.characters[get(selectedCharID)]?.chaId
    if (!Array.isArray(db.nodeOnlyArchivedCharacters)) db.nodeOnlyArchivedCharacters = []
    const moved = new Set<string>()
    const now = Date.now()
    for (const { chaId, stub } of successes) {
        if (!db.characters.some((c) => c?.chaId === chaId)) continue
        if (trash) markTrashed(stub, now)
        if (!db.nodeOnlyArchivedCharacters.some((s) => s?.chaId === chaId)) db.nodeOnlyArchivedCharacters.push(stub)
        moved.add(chaId)
    }
    if (moved.size === 0) return 0
    for (let i = db.characters.length - 1; i >= 0; i--) {
        if (moved.has(db.characters[i]?.chaId)) db.characters.splice(i, 1)
    }
    checkCharOrder()
    requiresFullEncoderReload.state = true
    if (selectedChaId && moved.has(selectedChaId)) {
        deselectCharacter()
    } else if (selectedChaId) {
        const idx = db.characters.findIndex((c) => c?.chaId === selectedChaId)
        if (idx !== get(selectedCharID)) selectedCharID.set(idx)
    }
    return moved.size
}

/**
 * Deactivate (or trash) many characters in 20-ID server batches. Each batch
 * starts from an acknowledged full snapshot, then its successful list moves
 * are acknowledged before the next batch. The exclusive lease fences normal
 * saves for the whole run; a progress overlay remains visible throughout.
 */
export async function archiveCharacters(chaIds: string[], arg: { trash?: boolean; acceptLostChats?: boolean } = {}): Promise<BulkArchiveOutcome> {
    if (bulkArchiveRunning) throw new Error(language.bulkArchiveBusy)
    bulkArchiveRunning = true
    const outcome: BulkArchiveOutcome = { done: 0, failed: [], lost: [], stopped: false }
    const trash = !!arg.trash
    const progress = (done: number, total: number) =>
        loadingOverlayStore.set({ active: true, text: language.bulkArchiveProgress(done, total, trash), onCancel: null })
    try {
        await databasePersistenceCoordinator.runExclusiveMutation(async () => {
            // A queued save/rebase may have replaced the database. Resolve IDs
            // only after taking ownership, and never trust an old array index.
            const names = new Map<string, string>()
            const targets: string[] = []
            for (const chaId of new Set(chaIds)) {
                const matches = DBState.db.characters.filter((c) => c?.chaId === chaId)
                if (matches.length === 0) continue
                if (matches.length !== 1) {
                    throw new CharacterArchiveError('ARCHIVE_CHARACTER_CHANGED', 'The character identity is ambiguous. Reload before retrying deactivation.')
                }
                names.set(chaId, matches[0].name || 'Unnamed')
                targets.push(chaId)
            }
            if (targets.length === 0) return
            progress(0, targets.length)

            for (let i = 0; i < targets.length; i += BULK_ARCHIVE_CHUNK) {
                const chunk = targets.slice(i, i + BULK_ARCHIVE_CHUNK)
                assertArchiveGenerationIdle()
                if (!forageStorage.getDbEtag()) {
                    throw new CharacterArchiveError('ARCHIVE_SAVE_UNAVAILABLE', 'The saved database revision is unavailable. Reload before deactivating a character.')
                }
                // Assign IDs to loaded chats before the full write; unresolved
                // placeholders retain their stable IDs and server-side bodies.
                for (const chaId of chunk) {
                    const matches = DBState.db.characters.filter((c) => c?.chaId === chaId)
                    if (matches.length !== 1) {
                        throw new CharacterArchiveError('ARCHIVE_CHARACTER_CHANGED', 'The character changed while preparing deactivation. Retry the operation.')
                    }
                    let assigned = false
                    for (const chat of matches[0].chats ?? []) {
                        if (chat && !chat._placeholder && !chat.id) {
                            chat.id = v4()
                            assigned = true
                        }
                    }
                    if (assigned) trackCharacterForSave(chaId)
                }
                const snapshot = getDatabase({ snapshot: true })
                const signatures = new Map(chunk.map((chaId) => {
                    const target = snapshot.characters.find((c) => c?.chaId === chaId)
                    return [chaId, archiveTargetSignature(target)] as const
                }))
                await persistLiveDatabaseUnderLease(snapshot)
                for (const chaId of chunk) assertArchiveTargetUnchanged(chaId, signatures.get(chaId)!)

                const results: ArchiveBatchResult[] = await storage().archiveCharacters(chunk, { acceptLostChats: arg.acceptLostChats ?? trash })
                // A generation or live edit during the server request leaves
                // only recoverable orphan rows; no changed body is removed.
                for (const chaId of chunk) assertArchiveTargetUnchanged(chaId, signatures.get(chaId)!)
                const successes: { chaId: string; stub: any }[] = []
                for (const r of results) {
                    const name = names.get(r.chaId) ?? r.chaId
                    if (r.ok) {
                        successes.push({ chaId: r.chaId, stub: (r as Extract<ArchiveBatchResult, { ok: true }>).stub })
                        continue
                    }
                    const f = r as Extract<ArchiveBatchResult, { ok: false }>
                    if (f.code === 'ARCHIVE_CHATS_UNAVAILABLE') outcome.lost.push({ chaId: f.chaId, name, chats: f.chats ?? [] })
                    else outcome.failed.push({ chaId: f.chaId, name, reason: f.error })
                }
                const moved = applyArchived(successes, trash)
                outcome.done += moved
                if (moved > 0) {
                    try {
                        await persistLiveDatabaseUnderLease(getDatabase({ snapshot: true }))
                    } catch {
                        // Keep the local stubs and queued save intact; do not
                        // archive a later chunk against an unacknowledged view.
                        outcome.stopped = true
                        break
                    }
                }
                progress(Math.min(i + chunk.length, targets.length), targets.length)
            }
        })
        if (outcome.stopped) void requestImmediateSave()
        return outcome
    } finally {
        loadingOverlayStore.set({ active: false, text: '', onCancel: null })
        bulkArchiveRunning = false
    }
}

/**
 * Re-activate a deactivated character. Server registers its chats and hands
 * back the client view; the character returns to `characters` and the stub is
 * removed (one save tick). Resolves to the new index, or -1 when there was
 * nothing to activate. Throws CharacterArchiveError on server failure.
 */
export async function activateCharacter(chaId: string): Promise<number> {
    let shouldSave = false
    const attempt = () => databasePersistenceCoordinator.runExclusiveMutation(async () => {
        // Re-read after obtaining ownership: an acknowledged save/rebase may
        // have activated or replaced this character while this call was queued.
        const db = DBState.db
        const list = db.nodeOnlyArchivedCharacters ?? []
        const stubIndex = list.findIndex((s) => s?.chaId === chaId)
        const existing = db.characters.findIndex((c) => c?.chaId === chaId)
        if (existing !== -1) {
            // Already active (e.g. another device activated it): just drop the stub.
            if (stubIndex !== -1) list.splice(stubIndex, 1)
            return existing
        }
        if (stubIndex === -1) return -1

        let restored: character
        try {
            // Name the exact row this stub was made with (rows are versioned).
            restored = await storage().activateCharacter(chaId, list[stubIndex]?.archivedAt)
        } catch (error) {
            // A just-deactivated character may still appear active to the
            // server until its normal transition save lands. Keep the stub,
            // release ownership, flush, and retry against current state.
            throw error
        }
        // A rebase or other live mutation can replace the object during the
        // server request even while normal writes are fenced by the lease.
        const current = DBState.db
        const existingNow = current.characters.findIndex((c) => c?.chaId === chaId)
        if (existingNow !== -1) {
            const staleStub = (current.nodeOnlyArchivedCharacters ?? []).findIndex((s) => s?.chaId === chaId)
            if (staleStub !== -1) current.nodeOnlyArchivedCharacters!.splice(staleStub, 1)
            return existingNow
        }
        // The server sends chats as stubs; the client works with placeholders
        // (same conversion bootstrap applies to the whole database).
        restored.chats = convertStubsToPlaceholders(restored.chats ?? [])
        // The trash marker lives on the stub, never on the body (a body archived
        // by the legacy-trash migration may still carry the old flag).
        delete restored.trashTime
        current.characters.push(restored)
        const stubIdxNow = (current.nodeOnlyArchivedCharacters ?? []).findIndex((s) => s?.chaId === chaId)
        if (stubIdxNow !== -1) current.nodeOnlyArchivedCharacters!.splice(stubIdxNow, 1)
        checkCharOrder()
        requiresFullEncoderReload.state = true
        shouldSave = true
        return current.characters.length - 1
    })
    let result: number
    try {
        result = await attempt()
    } catch (error) {
        if (!(error instanceof CharacterArchiveError && error.code === 'ARCHIVE_ALREADY_ACTIVE')) throw error
        // The coordinator must be released before flushSaves takes its normal
        // write lease. A failed flush leaves the stub untouched.
        if (!await flushSaves()) throw new CharacterArchiveError(error.code, language.archiveSaveFailed)
        try {
            result = await attempt()
        } catch (retryError) {
            if (retryError instanceof CharacterArchiveError && retryError.code === 'ARCHIVE_ALREADY_ACTIVE') {
                throw new CharacterArchiveError(retryError.code, language.activateCharacterAlreadyActive)
            }
            throw retryError
        }
    }
    // requestImmediateSave takes a normal-write lease itself.
    if (shouldSave) void requestImmediateSave()
    return result
}

function assertArchiveGenerationIdle(): void {
    if (get(generationStates).size === 0) return
    throw new CharacterArchiveError(
        'ARCHIVE_GENERATION_ACTIVE',
        'Wait for all message generations to finish before deactivating a character.',
    )
}

function archiveTargetSignature(target: Database['characters'][number]): string {
    const signature = JSON.stringify(target)
    if (typeof signature === 'string') return signature
    throw new CharacterArchiveError(
        'ARCHIVE_CHARACTER_CHANGED',
        'The character changed while preparing deactivation. Retry the operation.',
    )
}

function assertArchiveTargetUnchanged(chaId: string, expectedSignature: string): void {
    assertArchiveGenerationIdle()
    const matches = (getDatabase({ snapshot: true }).characters ?? [])
        .filter((candidate) => candidate?.chaId === chaId)
    if (matches.length === 1 && archiveTargetSignature(matches[0]) === expectedSignature) return
    throw new CharacterArchiveError(
        'ARCHIVE_CHARACTER_CHANGED',
        'The character changed while preparing deactivation. Retry the operation.',
    )
}

/** Move an already-deactivated character to the trash (marker only; nothing moves on the server). */
export function trashDeactivatedCharacter(chaId: string): boolean {
    const stub = findArchivedStub(chaId)
    if (!stub || stub.trashedAt) return false
    markTrashed(stub, Date.now())
    checkCharOrder()
    void requestImmediateSave()
    return true
}

/** Take a trashed character out of the trash. It stays deactivated (its previous state) until opened. */
export function restoreTrashedCharacter(chaId: string): boolean {
    const stub = findArchivedStub(chaId)
    if (!stub || !stub.trashedAt) return false
    delete stub.trashedAt
    const folderId = stub.trashedFromFolder
    delete stub.trashedFromFolder
    const folder = folderId && DBState.db.characterOrder?.find((e) => typeof e !== 'string' && e?.id === folderId)
    if (folder && typeof folder !== 'string' && !folder.data.includes(chaId)) folder.data.push(chaId)
    checkCharOrder()
    void requestImmediateSave()
    return true
}

/** Permanently delete a trashed character: server rows first, then the stub. Throws CharacterArchiveError. */
export async function deleteTrashedCharacter(chaId: string): Promise<boolean> {
    const stub = findArchivedStub(chaId)
    if (!stub) return false
    await storage().deleteArchivedCharacter(chaId)
    return removeArchivedStub(chaId)
}

/**
 * Legacy trash (a live character carrying `trashTime`, written by older
 * builds, upstream imports or .bin restores) → deactivated + trashedAt.
 * Best effort at boot: a character that fails to archive stays legacy and is
 * retried next boot. The lists render both shapes.
 */
export async function migrateLegacyTrash(): Promise<void> {
    const db = DBState.db
    const ids = db.characters.filter((c) => c?.chaId && c.trashTime).map((c) => c.chaId)
    for (const chaId of ids) {
        const idx = db.characters.findIndex((c) => c?.chaId === chaId)
        if (idx === -1) continue
        const trashedAt = db.characters[idx].trashTime
        try {
            await archiveCharacter(idx, { skipConfirm: true, trash: true, trashedAt, silent: true })
        } catch (error) {
            console.warn('[Trash] legacy trash migration skipped for', chaId, error)
        }
    }
}

/** Drop a stub whose payload is gone for good (recovery path; nothing else is deleted). */
export function removeArchivedStub(chaId: string): boolean {
    const list = DBState.db.nodeOnlyArchivedCharacters ?? []
    const idx = list.findIndex((s) => s?.chaId === chaId)
    if (idx === -1) return false
    list.splice(idx, 1)
    checkCharOrder()
    requiresFullEncoderReload.state = true
    void requestImmediateSave()
    return true
}

/**
 * List-click entry point: "This character is deactivated. Activate it?" →
 * activate → open it like a normal selection.
 */
export async function promptActivateCharacter(chaId: string, arg: { reseter?: () => any } = {}): Promise<boolean> {
    const stub = findArchivedStub(chaId)
    if (!stub) return false
    if (!await alertConfirm(language.activateCharacterConfirm(stub.name || 'Unnamed'))) return false
    try {
        const index = await withOverlay(() => activateCharacter(chaId))
        if (index < 0) return false
        changeChar(index, arg)
        return true
    } catch (error) {
        if (error instanceof CharacterArchiveError
            && (error.code === 'ARCHIVE_PAYLOAD_MISSING' || error.code === 'ARCHIVE_PAYLOAD_INVALID')) {
            // Nothing to restore from: offer to drop the stub so the dashboard,
            // orphan sweep and export stop failing closed on it.
            if (await alertConfirm(language.activateCharacterMissing + '\n\n' + language.activateCharacterRemoveStub)) {
                removeArchivedStub(chaId)
            }
        } else {
            alertError(language.activateCharacterFailed + (error instanceof Error ? error.message : String(error)))
        }
        return false
    }
}

/** Every deactivated character as a full record (for the client-assembled partial backup). */
export async function fetchArchivedCharactersInline(): Promise<character[]> {
    if (getArchivedStubs().length === 0) return []
    return await storage().fetchArchivedCharactersInline()
}

export function isCharacterSelected(index: number): boolean {
    return get(selectedCharID) === index
}

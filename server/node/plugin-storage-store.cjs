'use strict';

// Server-side home for `db.pluginCustomStorage`. Each plugin key becomes one
// kv row `plugin-storage/<base64url(key)>` holding UTF-8 `JSON.stringify(value)`.
// The DB blob keeps the field (always `{}`) so upstream/legacy decoders still
// find it; export reassembles the field from here (see server.cjs).
//
// Key encoding is byte-identical to persistentKv.encodeKeyComponent on the
// client — the client addresses these rows directly through /api/read|write.

const crypto = require('node:crypto');

const PREFIX = 'plugin-storage/';
const MIGRATED_MARKER_KEY = `${PREFIX}__migrated__`;
const MIGRATION_VERSION = 1;
// Snapshot layout (content-addressed, see "Snapshot support" below):
//   plugin-storage-snapshot/<id>   one JSON map row per snapshot
//   plugin-storage-blob/<sha256>   write-once value bytes shared by every map
// Older builds wrote `plugin-storage-snapshot/<id>/<enc>` row copies instead;
// those still restore/drop/size (detected by the absence of the map row).
// Deliberately NOT under PREFIX (LIKE 'plugin-storage/%' must not match them)
// and not under database/dbbackup- (the snapshot listing parses that prefix).
const SNAPSHOT_PREFIX = 'plugin-storage-snapshot/';
const BLOB_PREFIX = 'plugin-storage-blob/';
const SNAPSHOT_MAP_VERSION = 2;

function snapshotPrefixFor(snapshotId) {
    return `${SNAPSHOT_PREFIX}${snapshotId}/`;
}

function snapshotMapKeyFor(snapshotId) {
    return `${SNAPSHOT_PREFIX}${snapshotId}`;
}

function blobKeyFor(sha) {
    return `${BLOB_PREFIX}${sha}`;
}

function sha256(buf) {
    return crypto.createHash('sha256').update(buf).digest('hex');
}

function encodeKey(pluginKey) {
    return Buffer.from(String(pluginKey), 'utf-8')
        .toString('base64')
        .replace(/\+/g, '-')
        .replace(/\//g, '_')
        .replace(/=+$/g, '');
}

function decodeKey(kvKey) {
    const encoded = kvKey.startsWith(PREFIX) ? kvKey.slice(PREFIX.length) : kvKey;
    const base64 = encoded.replace(/-/g, '+').replace(/_/g, '/');
    return Buffer.from(base64, 'base64').toString('utf-8');
}

function kvKeyFor(pluginKey) {
    return `${PREFIX}${encodeKey(pluginKey)}`;
}

function serializeValue(value) {
    // Values are JSON by contract (V2 API = strings). `undefined`/functions
    // can't round-trip through the DB blob anyway; store null rather than an
    // unparseable empty row.
    const text = JSON.stringify(value);
    return Buffer.from(text === undefined ? 'null' : text, 'utf-8');
}

function isPlainObject(value) {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/**
 * @param {object} deps - kv primitives from db.cjs plus the better-sqlite3
 *   handle (`db`) for the migration transaction. Injected so tests can run
 *   against an in-memory database.
 */
function createPluginStorageStore(deps) {
    const { db, kvGet, kvSet, kvDel, kvDelPrefix, kvListWithSizes } = deps;
    // Optional: tells whether the DB blob a snapshot id belongs to still
    // exists. When given, gcBlobs treats a map row without its blob as an
    // orphan (e.g. the blob was removed through a raw kv delete) and drops it.
    const hasSnapshotBlob = typeof deps.hasSnapshotBlob === 'function' ? deps.hasSnapshotBlob : null;

    function list() {
        const out = [];
        for (const entry of kvListWithSizes(PREFIX)) {
            if (entry.key === MIGRATED_MARKER_KEY) continue;
            out.push({ key: decodeKey(entry.key), size: entry.size });
        }
        return out;
    }

    function get(pluginKey) {
        const raw = kvGet(kvKeyFor(pluginKey));
        if (raw === null || raw === undefined) return null;
        return JSON.parse(Buffer.from(raw).toString('utf-8'));
    }

    function set(pluginKey, value) {
        kvSet(kvKeyFor(pluginKey), serializeValue(value));
    }

    function remove(pluginKey) {
        kvDel(kvKeyFor(pluginKey));
    }

    function removeAll() {
        kvDelPrefix(PREFIX);
    }

    function isMigrated() {
        const raw = kvGet(MIGRATED_MARKER_KEY);
        return raw !== null && raw !== undefined;
    }

    // Materializes every key into one object — the shape `db.pluginCustomStorage`
    // had before the split. Only for export; it holds all values in memory.
    // Keys are added with defineProperty so a stored "__proto__" key stays an
    // own property instead of rewiring the prototype.
    // Every value as { key, text } with the JSON left unparsed, one row at a
    // time, for streaming the whole store to a client.
    function* entriesRaw() {
        for (const entry of kvListWithSizes(PREFIX)) {
            if (entry.key === MIGRATED_MARKER_KEY) continue;
            const raw = kvGet(entry.key);
            if (raw === null || raw === undefined) continue;
            yield { key: decodeKey(entry.key), text: Buffer.from(raw).toString('utf-8') };
        }
    }

    function readAll() {
        const out = {};
        for (const entry of kvListWithSizes(PREFIX)) {
            if (entry.key === MIGRATED_MARKER_KEY) continue;
            const raw = kvGet(entry.key);
            if (raw === null || raw === undefined) continue;
            Object.defineProperty(out, decodeKey(entry.key), {
                value: JSON.parse(Buffer.from(raw).toString('utf-8')),
                enumerable: true, writable: true, configurable: true,
            });
        }
        return out;
    }

    // ── Snapshot support ─────────────────────────────────────────────────
    // A DB snapshot (database/dbbackup-*) taken after the split holds an
    // EMPTY pluginCustomStorage, so the plugin rows must be captured next to
    // it or a restore would silently drop all plugin data.
    //
    // Snapshots are content-addressed so rotation does not multiply a large
    // plugin set: every live value is hashed (sha256) and stored once under
    // plugin-storage-blob/<sha> (INSERT OR IGNORE — write-once), and the
    // snapshot itself is a single JSON row plugin-storage-snapshot/<id>:
    //   { v: 2, marker: <marker row text | null>, entries: [[enc, sha], …] }
    // `entries` is an array of pairs (not an object) so an encoded key can
    // never collide with Object.prototype names. Values are hashed one row at
    // a time — the whole set is never materialized in JS.
    //
    // Size definition (snapshotBytes): a snapshot costs its map row plus the
    // blobs that ONLY it references. Shared blobs are counted by nobody, so
    // deleting a snapshot moves the bytes of blobs it shared onto the
    // surviving referrers — the same "marginal disk cost" notion the chunked
    // DB blob uses (db.cjs snapshotFootprint). snapshotLogicalBytes counts
    // every referenced blob (what the snapshot would cost without dedup).
    //
    // Legacy layout: builds before dedup copied rows to
    // plugin-storage-snapshot/<id>/<enc>. No migration; such a snapshot is
    // recognised by the absence of its map row and keeps working.
    const stmtGetValue = db.prepare('SELECT value FROM kv WHERE key = ?');
    const stmtInsertIgnore = db.prepare('INSERT OR IGNORE INTO kv (key, value, updated_at) VALUES (?, ?, ?)');
    // Copies a blob's bytes to a live row inside SQLite (no JS round-trip).
    const stmtCopyRow = db.prepare(
        `INSERT OR REPLACE INTO kv (key, value, updated_at) SELECT ?, value, ? FROM kv WHERE key = ?`,
    );
    let stmtCopyPrefix = null;
    function copyPrefixRows(fromPrefix, toPrefix) {
        if (!stmtCopyPrefix) {
            stmtCopyPrefix = db.prepare(
                `INSERT OR REPLACE INTO kv (key, value, updated_at)
                 SELECT ? || substr(key, ?), value, updated_at FROM kv WHERE key LIKE ? ESCAPE '\\'`,
            );
        }
        const escaped = fromPrefix.replace(/[\\%_]/g, '\\$&');
        stmtCopyPrefix.run(toPrefix, fromPrefix.length + 1, `${escaped}%`);
    }

    function readSnapshotMap(snapshotId) {
        const raw = kvGet(snapshotMapKeyFor(snapshotId));
        if (raw === null || raw === undefined) return null;
        const parsed = JSON.parse(Buffer.from(raw).toString('utf-8'));
        if (!parsed || !Array.isArray(parsed.entries)) {
            throw new Error(`plugin-storage snapshot map ${snapshotId} is malformed`);
        }
        return parsed;
    }

    // Every map row: [{ id, size, map }]. Legacy-layout rows (id contains
    // '/') are skipped — they hold no blob references.
    function listSnapshotMaps() {
        const out = [];
        for (const entry of kvListWithSizes(SNAPSHOT_PREFIX)) {
            const id = entry.key.slice(SNAPSHOT_PREFIX.length);
            if (id.includes('/')) continue;
            out.push({ id, size: entry.size, map: readSnapshotMap(id) });
        }
        return out;
    }

    // Builds the map for the current plugin-storage/ set (marker included)
    // and lands any blob not yet stored. Re-snapshotting an id replaces it.
    // Caller wraps this with the DB blob copy in one transaction.
    function snapshotTo(snapshotId) {
        // Drop a legacy-layout copy of the same id so the two never coexist.
        kvDelPrefix(snapshotPrefixFor(snapshotId));
        const entries = [];
        let marker = null;
        const now = Date.now();
        for (const row of kvListWithSizes(PREFIX)) {
            const raw = stmtGetValue.get(row.key)?.value;
            if (raw === null || raw === undefined) continue;
            if (row.key === MIGRATED_MARKER_KEY) {
                marker = Buffer.from(raw).toString('utf-8');
                continue;
            }
            const sha = sha256(raw);
            stmtInsertIgnore.run(blobKeyFor(sha), raw, now);
            entries.push([row.key.slice(PREFIX.length), sha]);
        }
        kvSet(snapshotMapKeyFor(snapshotId), Buffer.from(JSON.stringify({
            v: SNAPSHOT_MAP_VERSION, marker, entries,
        }), 'utf-8'));
    }

    // Replaces the live plugin-storage/ set with the snapshot's — exactly that
    // set, including "no rows / no marker" for a pre-split snapshot (whose
    // plugin data still sits in the blob and is re-split by the decode
    // migration). Caller wraps this with the blob restore in one transaction;
    // a missing blob throws so the whole restore rolls back.
    function restoreFrom(snapshotId) {
        const map = readSnapshotMap(snapshotId);
        kvDelPrefix(PREFIX);
        if (!map) {
            copyPrefixRows(snapshotPrefixFor(snapshotId), PREFIX);
            return;
        }
        const now = Date.now();
        for (const [enc, sha] of map.entries) {
            const info = stmtCopyRow.run(`${PREFIX}${enc}`, now, blobKeyFor(sha));
            if (info.changes !== 1) {
                throw new Error(`plugin-storage snapshot ${snapshotId}: blob ${sha} missing for key ${enc}`);
            }
        }
        if (typeof map.marker === 'string') kvSet(MIGRATED_MARKER_KEY, Buffer.from(map.marker, 'utf-8'));
    }

    // Deletes every plugin-storage-blob/ row no remaining map references.
    // A map row whose DB blob is gone (hasSnapshotBlob false) is dropped first
    // and counts as unreferenced, so a snapshot deleted by any other path
    // self-heals here instead of pinning its blobs forever.
    function gcBlobs() {
        const referenced = new Set();
        for (const { id, map } of listSnapshotMaps()) {
            if (hasSnapshotBlob && !hasSnapshotBlob(id)) {
                kvDel(snapshotMapKeyFor(id));
                kvDelPrefix(snapshotPrefixFor(id));
                continue;
            }
            for (const [, sha] of map.entries) referenced.add(sha);
        }
        let removed = 0;
        for (const entry of kvListWithSizes(BLOB_PREFIX)) {
            if (referenced.has(entry.key.slice(BLOB_PREFIX.length))) continue;
            kvDel(entry.key);
            removed++;
        }
        return removed;
    }

    const dropSnapshot = db.transaction((snapshotId) => {
        kvDel(snapshotMapKeyFor(snapshotId));
        kvDelPrefix(snapshotPrefixFor(snapshotId));
        gcBlobs();
    });

    function blobSizes() {
        const sizes = new Map();
        for (const entry of kvListWithSizes(BLOB_PREFIX)) sizes.set(entry.key.slice(BLOB_PREFIX.length), entry.size);
        return sizes;
    }

    function legacySnapshotBytes(snapshotId) {
        let total = 0;
        for (const entry of kvListWithSizes(snapshotPrefixFor(snapshotId))) total += entry.size;
        return total;
    }

    // Marginal cost — see the size definition above.
    function snapshotBytes(snapshotId) {
        const maps = listSnapshotMaps();
        const self = maps.find(m => m.id === snapshotId);
        if (!self) return legacySnapshotBytes(snapshotId);
        const shared = new Set();
        for (const other of maps) {
            if (other.id === snapshotId) continue;
            for (const [, sha] of other.map.entries) shared.add(sha);
        }
        const sizes = blobSizes();
        let total = self.size;
        const counted = new Set();
        for (const [, sha] of self.map.entries) {
            if (shared.has(sha) || counted.has(sha)) continue;
            counted.add(sha);
            total += sizes.get(sha) || 0;
        }
        return total;
    }

    // Full size — every referenced blob, as if nothing were shared.
    function snapshotLogicalBytes(snapshotId) {
        const self = listSnapshotMaps().find(m => m.id === snapshotId);
        if (!self) return legacySnapshotBytes(snapshotId);
        const sizes = blobSizes();
        let total = self.size;
        for (const [, sha] of self.map.entries) total += sizes.get(sha) || 0;
        return total;
    }

    /**
     * Moves `dbObject.pluginCustomStorage` into kv. Does NOT touch dbObject —
     * the caller empties the field and persists only after this returns.
     *
     * Order matters for data safety: snapshot the pre-migration blob first,
     * then write every key in one transaction and verify what landed before
     * committing. Any throw rolls the transaction back, so plugin data is
     * always in the DB blob, in kv, or both — never in neither.
     *
     * Conflict rule for keys already in kv:
     * - First migration (no marker): the DB value wins. If the user briefly
     *   ran an older build that wrote into the blob, the blob is newer.
     * - Re-migration (marker present) with `kvWinsOnRemigration`: kv wins.
     *   The marker means a migration already succeeded; the blob still
     *   holding data almost always means the emptied blob failed to persist
     *   afterwards (persist error, stub-flag-loss abort, crash between the
     *   kv commit and the kvSet). Clients have since been writing to kv, so
     *   re-applying the stale blob copy DB-wins would clobber newer values.
     *   Keys absent from kv are still moved. The snapshot is also skipped on
     *   re-migration so a persistently failing persist can't spam one per
     *   cold decode.
     * - `kvWinsOnRemigration: false` (the full /api/write path) always lets
     *   the DB win: there the blob is a fresh client write, and a client that
     *   still ships a populated field is the only writer of that data.
     */
    function migrateFromDb(dbObject, { createSnapshot = null, kvWinsOnRemigration = false } = {}) {
        const storage = dbObject?.pluginCustomStorage;
        if (!isPlainObject(storage)) return { migrated: false, keys: 0, bytes: 0 };
        const allKeys = Object.keys(storage);
        if (allKeys.length === 0) return { migrated: false, keys: 0, bytes: 0 };

        const remigration = isMigrated();
        if (!remigration && typeof createSnapshot === 'function') createSnapshot();

        const run = db.transaction(() => {
            const expected = new Map();
            let bytes = 0;
            let skipped = 0;
            const keys = [];
            for (const key of allKeys) {
                const kvKey = kvKeyFor(key);
                if (remigration && kvWinsOnRemigration) {
                    const existing = kvGet(kvKey);
                    if (existing !== null && existing !== undefined) { skipped++; continue; }
                }
                keys.push(key);
                // Own-property read: an own "__proto__" key (from JSON.parse or
                // msgpack) must not fall through to Object.prototype.
                const value = Object.getOwnPropertyDescriptor(storage, key).value;
                const buf = serializeValue(value);
                kvSet(kvKey, buf);
                expected.set(kvKey, buf.length);
                bytes += buf.length;
            }

            // Verify by re-reading sizes from the table. A short write, a key
            // collision from a bad encoder, or a kvSet that silently no-ops
            // shows up here and aborts the transaction.
            const actual = new Map();
            for (const entry of kvListWithSizes(PREFIX)) actual.set(entry.key, entry.size);
            let seen = 0;
            let actualBytes = 0;
            for (const [kvKey, size] of expected) {
                const got = actual.get(kvKey);
                if (got === undefined) throw new Error(`plugin-storage migration: key missing after write (${kvKey})`);
                if (got !== size) throw new Error(`plugin-storage migration: size mismatch for ${kvKey} (${got} != ${size})`);
                seen++;
                actualBytes += got;
            }
            if (seen !== keys.length || actualBytes !== bytes) {
                throw new Error(`plugin-storage migration: verification failed (${seen}/${keys.length} keys, ${actualBytes}/${bytes} bytes)`);
            }

            kvSet(MIGRATED_MARKER_KEY, Buffer.from(JSON.stringify({
                version: MIGRATION_VERSION,
                at: Date.now(),
                keys: keys.length,
            }), 'utf-8'));
            // `migrated: true` even when every key was skipped: kv holds the
            // full set, so the caller must still empty and persist the blob.
            return { migrated: true, keys: keys.length, bytes, skipped };
        });
        return run();
    }

    return {
        PREFIX, MIGRATED_MARKER_KEY, SNAPSHOT_PREFIX, BLOB_PREFIX, encodeKey, decodeKey,
        snapshotPrefixFor, snapshotMapKeyFor, blobKeyFor,
        list, get, set, remove, removeAll, readAll, entriesRaw, isMigrated, migrateFromDb,
        snapshotTo, restoreFrom, dropSnapshot, gcBlobs, snapshotBytes, snapshotLogicalBytes,
    };
}

// Default store bound to the live database. Required lazily: db.cjs opens
// ./save/risuai.db on load, which unit tests must not trigger.
let defaultStore = null;
function getDefaultStore() {
    if (!defaultStore) {
        const dbMod = require('./db.cjs');
        defaultStore = createPluginStorageStore({
            ...dbMod,
            // Snapshot ids are the digits of `database/dbbackup-<id>.bin`
            // (server.cjs createBackupAndRotate). Existence only — no reassembly.
            hasSnapshotBlob: (id) => dbMod.kvListWithSizes(`database/dbbackup-${id}.bin`).length > 0,
        });
    }
    return defaultStore;
}

module.exports = {
    PREFIX,
    MIGRATED_MARKER_KEY,
    SNAPSHOT_PREFIX,
    BLOB_PREFIX,
    encodeKey,
    decodeKey,
    snapshotPrefixFor,
    snapshotMapKeyFor,
    blobKeyFor,
    createPluginStorageStore,
    snapshotTo: (...a) => getDefaultStore().snapshotTo(...a),
    restoreFrom: (...a) => getDefaultStore().restoreFrom(...a),
    dropSnapshot: (...a) => getDefaultStore().dropSnapshot(...a),
    gcBlobs: (...a) => getDefaultStore().gcBlobs(...a),
    snapshotBytes: (...a) => getDefaultStore().snapshotBytes(...a),
    snapshotLogicalBytes: (...a) => getDefaultStore().snapshotLogicalBytes(...a),
    list: (...a) => getDefaultStore().list(...a),
    get: (...a) => getDefaultStore().get(...a),
    set: (...a) => getDefaultStore().set(...a),
    remove: (...a) => getDefaultStore().remove(...a),
    removeAll: (...a) => getDefaultStore().removeAll(...a),
    readAll: (...a) => getDefaultStore().readAll(...a),
    entriesRaw: (...a) => getDefaultStore().entriesRaw(...a),
    isMigrated: (...a) => getDefaultStore().isMigrated(...a),
    migrateFromDb: (...a) => getDefaultStore().migrateFromDb(...a),
};

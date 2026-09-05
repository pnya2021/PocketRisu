'use strict';

const crypto = require('crypto');
const zlib = require('zlib');

const MANIFEST_FORMAT_VERSION = 1;
const OWNER_KINDS = new Set(['module', 'character', 'persona-module']);
const DEFAULT_CACHE_BYTES = 64 * 1024 * 1024;
// Mirrors the client parser default (`data.assetMaxDifference ??= 4` in
// src/ts/storage/database.svelte.ts). Callers wiring the user setting through
// should pass it as { maxDistance } to resolveNames.
const DEFAULT_FUZZY_DISTANCE = 4;

// Mirrors trimmer() in src/ts/parser/parser.svelte.ts so the server-side
// fuzzy fallback scores the same strings the client parser scores.
const TRIMMED_EXTENSIONS = ['webp', 'png', 'jpg', 'jpeg', 'gif', 'mp4', 'webm', 'avi', 'm4p', 'm4v', 'mp3', 'wav', 'ogg'];
function trimAssetName(str) {
    for (const ext of TRIMMED_EXTENSIONS) {
        if (str.endsWith('.' + ext)) {
            str = str.substring(0, str.length - ext.length - 1);
        }
    }
    // The character class is copied verbatim from the client: ` -.` is a
    // range, so separators like "_", " ", "-" and "." all collapse away.
    return str.trim().replace(/[_ -.]/g, '');
}

function validationError(message) {
    const error = new Error(message);
    error.code = 'MANIFEST_VALIDATION';
    return error;
}

function assertOwner(kind, ownerId) {
    if (!OWNER_KINDS.has(kind)) throw validationError(`Unsupported asset manifest owner kind: ${kind}`);
    if (typeof ownerId !== 'string' || ownerId.length === 0) throw validationError('Asset manifest owner id is required');
}

function assertItems(items) {
    if (!Array.isArray(items)) throw validationError('Asset manifest items must be an array');
    for (let i = 0; i < items.length; i++) {
        const item = items[i];
        if (!Array.isArray(item) || item.length < 2 || item.length > 3) {
            throw validationError(`Invalid asset tuple at index ${i}`);
        }
        if (typeof item[0] !== 'string' || typeof item[1] !== 'string') {
            throw validationError(`Invalid asset tuple strings at index ${i}`);
        }
        if (item.length === 3 && item[2] != null && typeof item[2] !== 'string') {
            throw validationError(`Invalid asset tuple extension at index ${i}`);
        }
    }
}

function encodeItems(items) {
    assertItems(items);
    // JSON is intentional here: tuples contain only strings, and using a stable,
    // portable representation makes the integrity hash independent of msgpack
    // library versions. Tuple length/order and every string are preserved.
    const raw = Buffer.from(JSON.stringify(items), 'utf8');
    const hash = crypto.createHash('sha256').update(raw).digest('hex');
    const payload = zlib.deflateRawSync(raw, { level: 3 });
    return { raw, payload, hash };
}

function decodeItems(payload, expectedHash) {
    const raw = zlib.inflateRawSync(payload);
    const hash = crypto.createHash('sha256').update(raw).digest('hex');
    if (expectedHash && hash !== expectedHash) {
        throw new Error(`Asset manifest checksum mismatch: expected ${expectedHash}, got ${hash}`);
    }
    const items = JSON.parse(raw.toString('utf8'));
    assertItems(items);
    return { items, rawBytes: raw.length, hash };
}

function manifestIdFor(kind, ownerId, contentHash) {
    return crypto.createHash('sha256')
        .update(`${kind}\0${ownerId}\0${contentHash}`)
        .digest('hex');
}

function decodeAndValidateRow(row) {
    if (!row) throw new Error('Asset manifest row is missing');
    if (row.format_version !== MANIFEST_FORMAT_VERSION) {
        throw new Error(`Unsupported asset manifest version: ${row.format_version}`);
    }
    const expectedId = manifestIdFor(row.owner_kind, row.owner_id, row.content_hash);
    if (row.manifest_id !== expectedId) {
        throw new Error(`Asset manifest identity mismatch: ${row.manifest_id}`);
    }
    const decoded = decodeItems(row.payload, row.content_hash);
    if (decoded.items.length !== row.item_count || decoded.rawBytes !== row.raw_bytes) {
        throw new Error(`Asset manifest metadata mismatch: ${row.manifest_id}`);
    }
    return decoded;
}

function stringDistance(a, b) {
    if (a === b) return 0;
    if (!a.length) return b.length;
    if (!b.length) return a.length;
    let previous = Array.from({ length: b.length + 1 }, (_, i) => i);
    for (let i = 1; i <= a.length; i++) {
        const current = [i];
        for (let j = 1; j <= b.length; j++) {
            current[j] = Math.min(
                current[j - 1] + 1,
                previous[j] + 1,
                previous[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1),
            );
        }
        previous = current;
    }
    return previous[b.length];
}

function createAssetManifestStore(db, options = {}) {
    const maxCacheBytes = Number.isFinite(options.maxCacheBytes)
        ? Math.max(0, options.maxCacheBytes)
        : DEFAULT_CACHE_BYTES;

    db.exec(`
      CREATE TABLE IF NOT EXISTS asset_manifests (
        manifest_id   TEXT    PRIMARY KEY,
        owner_kind    TEXT    NOT NULL,
        owner_id      TEXT    NOT NULL,
        format_version INTEGER NOT NULL,
        item_count    INTEGER NOT NULL,
        content_hash  TEXT    NOT NULL,
        raw_bytes     INTEGER NOT NULL,
        payload       BLOB    NOT NULL,
        created_at    INTEGER NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_asset_manifests_owner
        ON asset_manifests(owner_kind, owner_id, created_at DESC);

      CREATE TABLE IF NOT EXISTS asset_manifest_live (
        owner_kind   TEXT NOT NULL,
        owner_id     TEXT NOT NULL,
        manifest_id  TEXT NOT NULL,
        updated_at   INTEGER NOT NULL,
        PRIMARY KEY(owner_kind, owner_id),
        FOREIGN KEY(manifest_id) REFERENCES asset_manifests(manifest_id)
      );

      CREATE TABLE IF NOT EXISTS asset_manifest_migration (
        owner_kind   TEXT NOT NULL,
        owner_id     TEXT NOT NULL,
        manifest_id  TEXT,
        source_hash  TEXT,
        item_count   INTEGER NOT NULL DEFAULT 0,
        status       TEXT NOT NULL,
        error        TEXT,
        updated_at   INTEGER NOT NULL,
        PRIMARY KEY(owner_kind, owner_id)
      );
    `);

    const stmtManifestGet = db.prepare(`
      SELECT manifest_id, owner_kind, owner_id, format_version, item_count,
             content_hash, raw_bytes, payload, created_at
      FROM asset_manifests WHERE manifest_id = ?
    `);
    const stmtManifestInsert = db.prepare(`
      INSERT OR IGNORE INTO asset_manifests
        (manifest_id, owner_kind, owner_id, format_version, item_count,
         content_hash, raw_bytes, payload, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    const stmtLiveSet = db.prepare(`
      INSERT INTO asset_manifest_live(owner_kind, owner_id, manifest_id, updated_at)
      VALUES (?, ?, ?, ?)
      ON CONFLICT(owner_kind, owner_id) DO UPDATE SET
        manifest_id = excluded.manifest_id,
        updated_at = excluded.updated_at
    `);
    const stmtLiveGet = db.prepare(`
      SELECT l.owner_kind, l.owner_id, l.manifest_id, l.updated_at,
             m.format_version, m.item_count, m.content_hash, m.raw_bytes
      FROM asset_manifest_live l
      JOIN asset_manifests m ON m.manifest_id = l.manifest_id
      WHERE l.owner_kind = ? AND l.owner_id = ?
    `);
    const stmtMigrationSet = db.prepare(`
      INSERT INTO asset_manifest_migration
        (owner_kind, owner_id, manifest_id, source_hash, item_count, status, error, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(owner_kind, owner_id) DO UPDATE SET
        manifest_id = excluded.manifest_id,
        source_hash = excluded.source_hash,
        item_count = excluded.item_count,
        status = excluded.status,
        error = excluded.error,
        updated_at = excluded.updated_at
    `);
    const stmtOwnerStaleList = db.prepare(`
      SELECT manifest_id FROM asset_manifests
      WHERE owner_kind = ? AND owner_id = ? AND manifest_id != ?
    `);
    const stmtOwnerStaleDelete = db.prepare(`
      DELETE FROM asset_manifests
      WHERE owner_kind = ? AND owner_id = ? AND manifest_id != ?
    `);
    const stmtMigrationList = db.prepare(`
      SELECT owner_kind, owner_id, manifest_id, source_hash, item_count, status, error, updated_at
      FROM asset_manifest_migration ORDER BY owner_kind, owner_id
    `);

    const cache = new Map();
    let cacheBytes = 0;

    function cacheGet(manifestId) {
        const found = cache.get(manifestId);
        if (!found) return null;
        cache.delete(manifestId);
        cache.set(manifestId, found);
        return found.items;
    }

    function cachePut(manifestId, items, rawBytes) {
        if (maxCacheBytes <= 0 || rawBytes > maxCacheBytes) return;
        const previous = cache.get(manifestId);
        if (previous) cacheBytes -= previous.rawBytes;
        cache.delete(manifestId);
        cache.set(manifestId, { items, rawBytes });
        cacheBytes += rawBytes;
        while (cacheBytes > maxCacheBytes && cache.size > 0) {
            const oldestId = cache.keys().next().value;
            const oldest = cache.get(oldestId);
            cache.delete(oldestId);
            cacheBytes -= oldest.rawBytes;
        }
    }

    function cacheEvict(manifestId) {
        const entry = cache.get(manifestId);
        if (!entry) return;
        cache.delete(manifestId);
        cacheBytes -= entry.rawBytes;
    }

    function loadItemsShared(manifestId) {
        const cached = cacheGet(manifestId);
        if (cached) return cached;
        const row = stmtManifestGet.get(manifestId);
        if (!row) return null;
        const decoded = decodeAndValidateRow(row);
        cachePut(manifestId, decoded.items, decoded.rawBytes);
        return decoded.items;
    }

    // Cached arrays are shared instances, and existing code paths mutate
    // asset arrays in place (module/character edit screens push tuples, the
    // asset re-save loop rewrites paths). Anything handed to a caller must be
    // a structural copy, or a caller mutation would poison the cache and leak
    // into every later hydration and disk write.
    function copyItems(items) {
        return items.map((item) => item.slice());
    }

    function loadItems(manifestId) {
        const items = loadItemsShared(manifestId);
        return items ? copyItems(items) : null;
    }

    function descriptorForRow(row) {
        if (!row) return null;
        return {
            id: row.manifest_id,
            version: row.format_version,
            count: row.item_count,
            sha256: row.content_hash,
        };
    }

    const putTx = db.transaction((kind, ownerId, items, activate) => {
        assertOwner(kind, ownerId);
        const encoded = encodeItems(items);
        const manifestId = manifestIdFor(kind, ownerId, encoded.hash);
        const now = Date.now();
        stmtManifestInsert.run(
            manifestId, kind, ownerId, MANIFEST_FORMAT_VERSION, items.length,
            encoded.hash, encoded.raw.length, encoded.payload, now,
        );
        // INSERT OR IGNORE makes repeated writes cheap, but the persisted row
        // still has to pass integrity checks before it can become live. This
        // prevents an existing damaged row from being re-activated while a
        // warm cache temporarily hides its corrupt payload.
        const stored = stmtManifestGet.get(manifestId);
        const decoded = decodeAndValidateRow(stored);
        if (stored.owner_kind !== kind || stored.owner_id !== ownerId || stored.content_hash !== encoded.hash) {
            throw new Error(`Asset manifest owner mismatch: ${manifestId}`);
        }
        if (activate) {
            stmtLiveSet.run(kind, ownerId, manifestId, now);
            // Superseded revisions have no readers left: canonical data is
            // still the hydrated database.bin, and a client holding an old
            // descriptor must refetch the live one anyway (stale edits 409).
            // Dropping them on activation keeps risuai.db from growing by a
            // full manifest copy on every asset edit.
            // Constraint: descriptors issued by a { activate: false } strip
            // are only valid until this owner's next activation — hydrate
            // them before yielding to other writers, or re-strip on the
            // resulting fail-closed hydrate error.
            for (const stale of stmtOwnerStaleList.all(kind, ownerId, manifestId)) {
                cacheEvict(stale.manifest_id);
            }
            stmtOwnerStaleDelete.run(kind, ownerId, manifestId);
        }
        stmtMigrationSet.run(kind, ownerId, manifestId, encoded.hash, items.length, 'verified', null, now);
        cachePut(manifestId, decoded.items, decoded.rawBytes);
        return {
            id: manifestId,
            version: MANIFEST_FORMAT_VERSION,
            count: items.length,
            sha256: encoded.hash,
        };
    });

    function putManifest(kind, ownerId, items, { activate = true } = {}) {
        return putTx(kind, ownerId, items, activate);
    }

    function getLiveDescriptor(kind, ownerId) {
        assertOwner(kind, ownerId);
        const row = stmtLiveGet.get(kind, ownerId);
        if (row && row.format_version !== MANIFEST_FORMAT_VERSION) {
            throw new Error(`Unsupported asset manifest version: ${row.format_version}`);
        }
        return descriptorForRow(row);
    }

    function getItemsByOwner(kind, ownerId) {
        const descriptor = getLiveDescriptor(kind, ownerId);
        return descriptor ? loadItems(descriptor.id) : null;
    }

    function getPage(manifestId, { offset = 0, limit = 100, search = '' } = {}) {
        const items = loadItemsShared(manifestId);
        if (!items) return null;
        const safeOffset = Math.max(0, Math.trunc(Number(offset) || 0));
        const safeLimit = Math.min(500, Math.max(1, Math.trunc(Number(limit) || 100)));
        const query = String(search || '').toLocaleLowerCase();
        const filtered = query
            ? items.filter((item) => item[0].toLocaleLowerCase().includes(query))
            : items;
        return {
            total: filtered.length,
            offset: safeOffset,
            limit: safeLimit,
            items: copyItems(filtered.slice(safeOffset, safeOffset + safeLimit)),
        };
    }

    // `fuzzyNamesOut` (a Set) receives the names that only the fuzzy fallback
    // matched, so a client can rank those below its own exact matches.
    function resolveNames(owners, names, { maxDistance = DEFAULT_FUZZY_DISTANCE, fuzzyNamesOut = null } = {}) {
        const wanted = new Set((names || []).map((name) => String(name).toLocaleLowerCase()));
        // Asset names are imported data. A null-prototype result keeps names
        // such as "__proto__" and "constructor" as ordinary lookup keys.
        const resolved = Object.create(null);
        if (wanted.size === 0) return resolved;
        const loadedOwners = [];
        for (const owner of owners || []) {
            if (!owner) continue;
            let descriptor = owner.manifestId
                ? { id: owner.manifestId }
                : getLiveDescriptor(owner.kind, owner.ownerId);
            if (!descriptor) continue;
            let items = loadItemsShared(descriptor.id);
            if (!items && owner.kind && owner.ownerId) {
                descriptor = getLiveDescriptor(owner.kind, owner.ownerId);
                items = descriptor ? loadItemsShared(descriptor.id) : null;
            }
            if (!items) continue;
            loadedOwners.push({ items, fuzzy: owner.fuzzy !== false });
            for (const item of items) {
                const key = item[0].toLocaleLowerCase();
                if (wanted.has(key) && !Object.hasOwn(resolved, key)) resolved[key] = item[1];
            }
            if (Object.keys(resolved).length >= wanted.size) break;
        }
        // Legacy fuzzy fallback, matching getClosestMatch in the client
        // parser: extensions are trimmed before scoring and the ceiling is
        // the user's assetMaxDifference setting, passed in as maxDistance.
        // It is only evaluated for exact misses.
        const distanceCeiling = Math.max(0, Math.trunc(Number(maxDistance) || 0));
        for (const name of wanted) {
            if (Object.hasOwn(resolved, name)) continue;
            const trimmedName = trimAssetName(name);
            let bestDistance = Number.POSITIVE_INFINITY;
            let bestPath = '';
            for (const loaded of loadedOwners) {
                if (!loaded.fuzzy) continue;
                const items = loaded.items;
                for (const item of items) {
                    const candidate = trimAssetName(item[0].toLocaleLowerCase());
                    // Length difference is a lower bound on edit distance.
                    if (Math.abs(candidate.length - trimmedName.length) > distanceCeiling) continue;
                    const distance = stringDistance(trimmedName, candidate);
                    if (distance < bestDistance) {
                        bestDistance = distance;
                        bestPath = item[1];
                    }
                }
            }
            if (bestPath && bestDistance <= distanceCeiling) {
                resolved[name] = bestPath;
                if (fuzzyNamesOut) fuzzyNamesOut.add(name);
            }
        }
        return resolved;
    }

    function applyOperations(kind, ownerId, expectedManifestId, operations) {
        assertOwner(kind, ownerId);
        if (!Array.isArray(operations) || operations.length === 0 || operations.length > 1000) {
            throw validationError('Asset manifest operations must contain 1-1000 entries');
        }
        const current = getLiveDescriptor(kind, ownerId);
        if (!current) throw validationError(`Asset manifest owner not found: ${kind}/${ownerId}`);
        if (expectedManifestId && expectedManifestId !== current.id) {
            const error = new Error('Asset manifest revision conflict');
            error.code = 'MANIFEST_CONFLICT';
            error.current = current;
            throw error;
        }
        const source = loadItems(current.id);
        const next = source.map((item) => item.slice());
        for (const operation of operations) {
            const type = operation?.type;
            if (type === 'append') {
                assertItems([operation.item]);
                next.push(operation.item.slice());
                continue;
            }
            const index = Math.trunc(Number(operation?.index));
            if (!Number.isFinite(index) || index < 0 || index >= next.length + (type === 'insert' ? 1 : 0)) {
                throw validationError(`Invalid asset manifest operation index: ${operation?.index}`);
            }
            if (type === 'insert') {
                assertItems([operation.item]);
                next.splice(index, 0, operation.item.slice());
            } else if (type === 'remove') {
                if (index >= next.length) throw validationError(`Invalid remove index: ${index}`);
                next.splice(index, 1);
            } else if (type === 'rename') {
                if (index >= next.length || typeof operation.name !== 'string') {
                    throw validationError(`Invalid rename operation at index: ${index}`);
                }
                next[index][0] = operation.name;
            } else if (type === 'replace') {
                if (index >= next.length) throw validationError(`Invalid replace index: ${index}`);
                assertItems([operation.item]);
                next[index] = operation.item.slice();
            } else {
                throw validationError(`Unsupported asset manifest operation: ${type}`);
            }
        }
        return putManifest(kind, ownerId, next, { activate: true });
    }

    function verifyManifest(manifestId) {
        const row = stmtManifestGet.get(manifestId);
        if (!row) return { ok: false, error: 'not-found' };
        try {
            // Verification deliberately bypasses the LRU so it checks the bytes
            // currently persisted in SQLite, not an earlier cached decode.
            const decoded = decodeAndValidateRow(row);
            return {
                ok: true,
                manifestId,
                version: row.format_version,
                ownerKind: row.owner_kind,
                ownerId: row.owner_id,
                count: decoded.items.length,
                sha256: row.content_hash,
                rawBytes: row.raw_bytes,
            };
        } catch (error) {
            return { ok: false, manifestId, error: String(error?.message || error) };
        }
    }

    function recordMigrationFailure(kind, ownerId, error) {
        assertOwner(kind, ownerId);
        stmtMigrationSet.run(kind, ownerId, null, null, 0, 'failed', String(error?.message || error), Date.now());
    }

    function listMigrationState() {
        return stmtMigrationList.all();
    }

    function listLiveDescriptors() {
        return db.prepare(`
          SELECT m.manifest_id, m.owner_kind, m.owner_id, m.item_count, m.content_hash
          FROM asset_manifest_live l
          JOIN asset_manifests m ON m.manifest_id = l.manifest_id
          ORDER BY m.owner_kind, m.owner_id
        `).all().map((row) => ({
            id: row.manifest_id,
            version: MANIFEST_FORMAT_VERSION,
            count: row.item_count,
            sha256: row.content_hash,
            ownerKind: row.owner_kind,
            ownerId: row.owner_id,
        }));
    }

    function stats() {
        const manifest = db.prepare(`
          SELECT COUNT(*) AS count, COALESCE(SUM(item_count), 0) AS items,
                 COALESCE(SUM(raw_bytes), 0) AS raw_bytes,
                 COALESCE(SUM(LENGTH(payload)), 0) AS stored_bytes
          FROM asset_manifests
        `).get();
        const live = db.prepare(`SELECT COUNT(*) AS count FROM asset_manifest_live`).get();
        return {
            manifests: manifest.count,
            liveManifests: live.count,
            items: manifest.items,
            rawBytes: manifest.raw_bytes,
            storedBytes: manifest.stored_bytes,
            cacheEntries: cache.size,
            cacheRawBytes: cacheBytes,
        };
    }

    return {
        putManifest,
        getLiveDescriptor,
        getItemsByOwner,
        loadItems,
        getPage,
        resolveNames,
        applyOperations,
        verifyManifest,
        recordMigrationFailure,
        listMigrationState,
        listLiveDescriptors,
        stats,
    };
}

module.exports = {
    MANIFEST_FORMAT_VERSION,
    createAssetManifestStore,
    encodeItems,
    decodeItems,
    manifestIdFor,
    stringDistance,
};

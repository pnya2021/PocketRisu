'use strict';

const path = require('path');
const crypto = require('crypto');
const Database = require('better-sqlite3');
const { CHUNK_MARKER } = require('../server/node/chunkStore.cjs');
const { decodeRisuSave, encodeRisuSaveLegacy } = require('../server/node/utils.cjs');
const { createAssetManifestStore } = require('../server/node/assetManifestStore.cjs');
const {
    stripAssetManifests,
    hydrateAssetManifests,
    assetManifestSummary,
} = require('../server/node/assetManifestMigration.cjs');

function parseArgs(argv) {
    const args = {};
    for (let i = 2; i < argv.length; i += 2) {
        const key = argv[i];
        if (!key?.startsWith('--') || argv[i + 1] === undefined) throw new Error(`Invalid argument: ${key}`);
        args[key.slice(2)] = argv[i + 1];
    }
    if (!args.db) throw new Error('Usage: node verify-asset-manifest-migration.cjs --db <risuai.db>');
    return args;
}

function readChunkAwareValue(db, key) {
    const row = db.prepare('SELECT value FROM kv WHERE key = ?').get(key);
    if (!row) return null;
    if (!Buffer.isBuffer(row.value) || !row.value.equals(CHUNK_MARKER)) return row.value;
    const rows = db.prepare(`
      SELECT c.data
      FROM manifest_chunks m JOIN chunks c ON c.hash = m.hash
      WHERE m.manifest_key = ? ORDER BY m.seq
    `).all(key);
    if (rows.length === 0) throw new Error(`Chunk marker has no manifest rows: ${key}`);
    return Buffer.concat(rows.map((item) => item.data));
}

function hashJson(value) {
    return crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

function collectLegacyOwners(dbObj) {
    const owners = [];
    for (let i = 0; i < (dbObj.modules || []).length; i++) {
        const owner = dbObj.modules[i];
        if (Array.isArray(owner?.assets) && owner.assets.length) {
            owners.push({ kind: 'module', index: i, items: owner.assets });
        }
    }
    for (let i = 0; i < (dbObj.characters || []).length; i++) {
        const owner = dbObj.characters[i];
        if (Array.isArray(owner?.additionalAssets) && owner.additionalAssets.length) {
            owners.push({ kind: 'character', index: i, items: owner.additionalAssets });
        }
    }
    for (let i = 0; i < (dbObj.personas || []).length; i++) {
        const owner = dbObj.personas[i]?.embeddedModule;
        if (Array.isArray(owner?.assets) && owner.assets.length) {
            owners.push({ kind: 'persona-module', index: i, items: owner.assets });
        }
    }
    return owners;
}

function stripChatsForClient(dbObj) {
    if (!Array.isArray(dbObj?.characters)) return dbObj;
    return {
        ...dbObj,
        characters: dbObj.characters.map((character) => {
            if (!Array.isArray(character?.chats)) return character;
            return {
                ...character,
                chats: character.chats.map((chat) => {
                    if (!chat || (chat._stub && !Array.isArray(chat.message))) return chat;
                    const stub = { id: chat.id || '', name: chat.name ?? '', _stub: true };
                    if ('lastDate' in chat) stub.lastDate = chat.lastDate;
                    if ('folderId' in chat) stub.folderId = chat.folderId;
                    if ('modules' in chat) stub.modules = chat.modules;
                    return stub;
                }),
            };
        }),
    };
}

function hydratedItems(hydrated, owner) {
    if (owner.kind === 'module') return hydrated.modules[owner.index].assets;
    if (owner.kind === 'character') return hydrated.characters[owner.index].additionalAssets;
    return hydrated.personas[owner.index].embeddedModule.assets;
}

function jsonBytes(value) {
    try { return Buffer.byteLength(JSON.stringify(value), 'utf8'); }
    catch { return -1; }
}

function aggregateFieldBytes(items) {
    const totals = new Map();
    for (const item of items || []) {
        if (!item || typeof item !== 'object') continue;
        for (const [key, value] of Object.entries(item)) {
            totals.set(key, (totals.get(key) || 0) + Math.max(0, jsonBytes(value)));
        }
    }
    return [...totals.entries()]
        .map(([key, bytes]) => ({ key, bytes }))
        .sort((a, b) => b.bytes - a.bytes)
        .slice(0, 20);
}

async function main() {
    const args = parseArgs(process.argv);
    const sourcePath = path.resolve(args.db);
    const source = new Database(sourcePath, { readonly: true, fileMustExist: true });
    source.pragma('query_only = ON');

    console.log('[verify] reading database.bin snapshot');
    const raw = readChunkAwareValue(source, 'database/database.bin');
    if (!raw) throw new Error('database/database.bin is missing');
    console.log(`[verify] database.bin bytes=${raw.length}`);

    const dbObj = await decodeRisuSave(raw);
    const legacyOwners = collectLegacyOwners(dbObj);
    const originalItems = legacyOwners.reduce((sum, owner) => sum + owner.items.length, 0);
    console.log(`[verify] owners=${legacyOwners.length} references=${originalItems}`);

    const manifestDb = new Database(':memory:');
    const store = createAssetManifestStore(manifestDb, { maxCacheBytes: 0 });
    const chatStrippedDb = stripChatsForClient(dbObj);
    const strippedResult = stripAssetManifests(chatStrippedDb, store);
    const summary = assetManifestSummary(strippedResult.db);
    if (summary.manifests !== legacyOwners.length || summary.items !== originalItems) {
        throw new Error(`Migration count mismatch: manifests ${summary.manifests}/${legacyOwners.length}, items ${summary.items}/${originalItems}`);
    }

    console.log('[verify] checking every immutable manifest');
    for (const descriptor of summary.descriptors) {
        const verified = store.verifyManifest(descriptor.id);
        if (!verified.ok || verified.count !== descriptor.count || verified.sha256 !== descriptor.sha256) {
            throw new Error(`Manifest verification failed: ${descriptor.id}`);
        }
    }

    console.log('[verify] rebuilding legacy arrays and comparing owner hashes');
    const hydrated = hydrateAssetManifests(strippedResult.db, store);
    for (const owner of legacyOwners) {
        const beforeHash = hashJson(owner.items);
        const after = hydratedItems(hydrated, owner);
        const afterHash = hashJson(after);
        if (owner.items.length !== after.length || beforeHash !== afterHash) {
            throw new Error(`Round-trip mismatch: ${owner.kind}[${owner.index}]`);
        }
    }

    console.log('[verify] checking referenced assets against kv keys');
    const assetKeys = new Set(source.prepare(`SELECT key FROM kv WHERE key LIKE 'assets/%'`).all().map((row) => row.key));
    let storedRefs = 0;
    let missingStoredRefs = 0;
    let nonStoredRefs = 0;
    const missingSamples = [];
    for (const owner of legacyOwners) {
        for (const item of owner.items) {
            const ref = item[1];
            if (!String(ref).startsWith('assets/')) {
                nonStoredRefs++;
                continue;
            }
            storedRefs++;
            if (!assetKeys.has(ref)) {
                missingStoredRefs++;
                if (missingSamples.length < 10) missingSamples.push(ref);
            }
        }
    }

    const strippedBytes = Buffer.from(encodeRisuSaveLegacy(strippedResult.db)).length;
    const storeStats = store.stats();
    const topLevelBytes = Object.entries(strippedResult.db)
        .map(([key, value]) => ({ key, bytes: jsonBytes(value) }))
        .sort((a, b) => b.bytes - a.bytes)
        .slice(0, 20);
    const result = {
        ok: true,
        sourceDb: sourcePath,
        databaseBinBytes: raw.length,
        strippedDatabaseBinBytes: strippedBytes,
        reductionPercent: Number(((1 - strippedBytes / raw.length) * 100).toFixed(2)),
        owners: legacyOwners.length,
        references: originalItems,
        storedAssetReferences: storedRefs,
        missingStoredAssetReferences: missingStoredRefs,
        nonStoredReferences: nonStoredRefs,
        missingSamples,
        manifestStoredBytes: storeStats.storedBytes,
        manifestRawBytes: storeStats.rawBytes,
        topLevelBytes,
        characterFieldBytes: aggregateFieldBytes(strippedResult.db.characters),
        moduleFieldBytes: aggregateFieldBytes(strippedResult.db.modules),
        pluginEntries: aggregateFieldBytes(strippedResult.db.plugins),
        plugins: (strippedResult.db.plugins || []).map((plugin) => ({
            name: plugin?.name || plugin?.displayName || '(unnamed)',
            enabled: !!plugin?.enabled,
            version: plugin?.version ?? null,
            scriptBytes: jsonBytes(plugin?.script || ''),
        })).sort((a, b) => b.scriptBytes - a.scriptBytes),
    };
    console.log(JSON.stringify(result, null, 2));

    manifestDb.close();
    source.close();
}

main().catch((error) => {
    console.error(error?.stack || error);
    process.exitCode = 1;
});

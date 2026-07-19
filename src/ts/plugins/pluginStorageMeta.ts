// Best-effort "origin plugin" tagging for plugin storage.
//
// Plugin data lives in a single global namespace with no record of which
// plugin wrote which key. We cannot reconstruct ownership for existing data,
// but for NEW writes the V3 API does know the calling plugin. This module
// stores that origin as a SIDECAR — a separate map keyed by storage key —
// alongside the value, never wrapping the value itself. Reads of the actual
// value are untouched, so existing plugins keep working.
//
// The sidecar must live in the SAME backend as the data it describes, so its
// lifecycle/travel matches (save → travels with the save file; local/idb →
// device-local). Hence one store per backend:
//   - save  → db.pluginStorageMeta (persisted in the save's ROOT block)
//   - local → a single localStorage JSON blob (not safe_plugin_* prefixed, so
//             it never shows up in the viewer's local listing)
//   - idb   → persistentKv under a dedicated prefix (separate from the data
//             prefix, so it never shows up in the viewer's idb listing)

import { getDatabase } from "../storage/database.svelte";
import {
    listPersistentKeys,
    makeEncodedStorageKey,
    decodeStorageKeyComponent,
    readPersistentJson,
    writePersistentJson,
    removePersistentKey,
    clearPersistentPrefix,
} from "../storage/persistentKv";
import { pluginDataLifecycle } from './pluginDataLifecycle';
import {
    normalizePluginStorageOwner,
    principalOwner,
    quarantinePluginStorageOwners,
    type PluginStorageOwnerRecord,
} from './pluginStorageOwnership';

export type PluginStorageBackend = "save" | "local" | "idb";
export type PluginOwnerRecord = PluginStorageOwnerRecord;

const LOCAL_META_KEY = "risu_plugin_storage_owners";
const IDB_META_PREFIX = "cache/plugin-storage-meta/";
const LOCAL_MIGRATION_KEY = "risu_plugin_storage_owners_migrated_v2";
const IDB_MIGRATION_KEY = "cache/plugin-storage-meta-migrated-v2.json";

// ── local backend blob helpers ──────────────────────────────────────────────
function readLocalMeta(): Record<string, PluginOwnerRecord> {
    try {
        const raw = JSON.parse(localStorage.getItem(LOCAL_META_KEY) || "{}") as Record<string, unknown>;
        const normalized = Object.fromEntries(Object.entries(raw).map(([key, value]) => [key, normalizePluginStorageOwner(value)]));
        if (localStorage.getItem(LOCAL_MIGRATION_KEY) !== '1') {
            writeLocalMeta(normalized);
            localStorage.setItem(LOCAL_MIGRATION_KEY, '1');
        }
        return normalized;
    } catch {
        return {};
    }
}

function writeLocalMeta(map: Record<string, PluginOwnerRecord>): void {
    try {
        localStorage.setItem(LOCAL_META_KEY, JSON.stringify(map));
    } catch {}
}

// ── write side (called from V3 storage wrappers) ────────────────────────────
export function recordOwner(backend: PluginStorageBackend, key: string, principalId: string, displayName: string): boolean | Promise<boolean> {
    if (!principalId || pluginDataLifecycle.isRetiring(principalId)) return false;
    const record = principalOwner(principalId, displayName);
    if (backend === "save") {
        const db = getDatabase();
        db.pluginStorageMeta ??= {};
        db.pluginStorageMeta[key] = record;
        return true;
    }
    if (backend === "local") {
        const map = readLocalMeta();
        map[key] = record;
        writeLocalMeta(map);
        return true;
    }
    return (async () => {
        const storageKey = makeEncodedStorageKey(IDB_META_PREFIX, key);
        await writePersistentJson(storageKey, record);
        if (pluginDataLifecycle.isRetiring(principalId)) {
            await writePersistentJson(storageKey, { ...record, state: 'quarantined' });
            return false;
        }
        return true;
    })();
}

export function removeOwner(backend: PluginStorageBackend, key: string): void | Promise<void> {
    if (backend === "save") {
        const db = getDatabase();
        if (db.pluginStorageMeta) delete db.pluginStorageMeta[key];
        return;
    }
    if (backend === "local") {
        const map = readLocalMeta();
        delete map[key];
        writeLocalMeta(map);
        return;
    }
    return removePersistentKey(makeEncodedStorageKey(IDB_META_PREFIX, key));
}

export function clearOwners(backend: PluginStorageBackend): void | Promise<void> {
    if (backend === "save") {
        const db = getDatabase();
        db.pluginStorageMeta = {};
        db.pluginStorageMetaMigrationV2 = true;
        return;
    }
    if (backend === "local") {
        writeLocalMeta({});
        try { localStorage.setItem(LOCAL_MIGRATION_KEY, '1') } catch { /* unavailable local storage */ }
        return;
    }
    return (async () => {
        await clearPersistentPrefix(IDB_META_PREFIX);
        await writePersistentJson(IDB_MIGRATION_KEY, true);
    })();
}

// ── read side (called from the viewer) ──────────────────────────────────────
// Returns a { storageKey → plugin name } map for the given backend.
export async function getOwners(backend: PluginStorageBackend): Promise<Record<string, string>> {
    const out: Record<string, string> = {};
    if (backend === "save") {
        const db = getDatabase();
        const raw = db.pluginStorageMeta ?? {};
        const meta = Object.fromEntries(Object.entries(raw).map(([key, value]) => [key, normalizePluginStorageOwner(value)]));
        if (!db.pluginStorageMetaMigrationV2) {
            db.pluginStorageMeta = meta;
            db.pluginStorageMetaMigrationV2 = true;
        }
        for (const [key, record] of Object.entries(meta)) {
            out[key] = ownerLabel(record);
        }
        return out;
    }
    if (backend === "local") {
        const map = readLocalMeta();
        for (const key of Object.keys(map)) {
            out[key] = ownerLabel(map[key]);
        }
        return out;
    }
    const migrated = await readPersistentJson<boolean>(IDB_MIGRATION_KEY);
    const storageKeys = await listPersistentKeys(IDB_META_PREFIX);
    for (const fullKey of storageKeys) {
        const encoded = fullKey.slice(IDB_META_PREFIX.length, -".json".length);
        const rawKey = decodeStorageKeyComponent(encoded);
        const record = normalizePluginStorageOwner(await readPersistentJson<unknown>(fullKey));
        out[rawKey] = ownerLabel(record);
        if (!migrated) await writePersistentJson(fullKey, record);
    }
    if (!migrated) await writePersistentJson(IDB_MIGRATION_KEY, true);
    return out;
}

const ownerLabel = (record: PluginOwnerRecord) => record.state === 'principal'
    ? record.displayName
    : record.state === 'quarantined'
        ? `${record.displayName} (quarantined)`
        : `${record.displayName} (legacy/unassociated)`;

async function quarantinePrincipalStorage(principalId: string) {
    const db = getDatabase();
    const saveMeta = Object.fromEntries(Object.entries(db.pluginStorageMeta ?? {}).map(([key, value]) => [key, normalizePluginStorageOwner(value)]));
    db.pluginStorageMeta = quarantinePluginStorageOwners(saveMeta, principalId);
    db.pluginStorageMetaMigrationV2 = true;

    const localMeta = quarantinePluginStorageOwners(readLocalMeta(), principalId);
    writeLocalMeta(localMeta);
    try { localStorage.setItem(LOCAL_MIGRATION_KEY, '1') } catch { /* unavailable local storage */ }

    const storageKeys = await listPersistentKeys(IDB_META_PREFIX);
    for (const fullKey of storageKeys) {
        const record = normalizePluginStorageOwner(await readPersistentJson<unknown>(fullKey));
        if (record.state === 'principal' && record.principalId === principalId) {
            await writePersistentJson(fullKey, { ...record, state: 'quarantined' });
        }
    }
    await writePersistentJson(IDB_MIGRATION_KEY, true);
}

pluginDataLifecycle.register('plugin-storage', 'quarantine', ({ principalId }) => quarantinePrincipalStorage(principalId));

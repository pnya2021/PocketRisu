// V2 plugin view of `db.pluginCustomStorage`.
//
// Plugin values live in pluginStorageStore, never in the DB (see the store's
// INVARIANT). V2 plugins historically read/wrote `risuai.db.pluginCustomStorage`
// directly, so the safe DB proxy hands out this live object instead of the
// real (always empty) DB field, and bulk writers (setDatabase/setDatabaseLite)
// route the key through mergePluginCustomStorage.

import * as pluginStorageStore from "./pluginStorageStore";

export const PLUGIN_CUSTOM_STORAGE_KEY = "pluginCustomStorage";

export function pluginCustomStorageProxy(): Record<string, any> {
    return new Proxy({} as Record<string, any>, {
        get(_t, prop) {
            if (typeof prop !== "string") return undefined;
            return pluginStorageStore.getItemSync(prop) ?? undefined;
        },
        set(_t, prop, value) {
            if (typeof prop === "string") pluginStorageStore.setItemSync(prop, value);
            return true;
        },
        deleteProperty(_t, prop) {
            if (typeof prop === "string") pluginStorageStore.removeItemSync(prop);
            return true;
        },
        has(_t, prop) {
            return typeof prop === "string" && pluginStorageStore.has(prop);
        },
        ownKeys() {
            return pluginStorageStore.keys();
        },
        getOwnPropertyDescriptor(_t, prop) {
            if (typeof prop !== "string" || !pluginStorageStore.has(prop)) return undefined;
            return {
                value: pluginStorageStore.getItemSync(prop) ?? undefined,
                writable: true,
                enumerable: true,
                configurable: true,
            };
        },
    });
}

// `db.pluginCustomStorage = obj` semantics: MERGE `obj` into the store.
//
// This is deliberately not a replace. `getDatabase()` hands plugins the real
// DB field, which is always `{}` (values live in the store), so a plugin doing
// the ordinary upstream round-trip `getDatabase() -> mutate -> setDatabase()`
// would otherwise hand back an empty/partial object and wipe every other
// plugin's data. Missing keys therefore never mean "delete"; a plugin that
// wants a full wipe has `pluginStorage.clear()`.
export function mergePluginCustomStorage(obj: unknown): void {
    if (!obj || typeof obj !== "object") return;
    for (const [k, v] of Object.entries(obj as Record<string, any>)) {
        pluginStorageStore.setItemSync(k, v);
    }
}

// V3 getDatabase(): whether to fill `pluginCustomStorage` with every stored
// value (RisuAI shape) instead of the empty field. The whole store (all
// plugins, hundreds of MB with long-term-memory plugins) is loaded and copied
// into the plugin sandbox on every call, so only the user can turn it on, per
// plugin. Naming the key in includeOnly is deliberately not enough: widely
// used plugins (Plugin Manager 2.1.2) list it by default without needing it,
// which would make every one of their reads pull the whole store.
export function wantsFullPluginStorage(
    plugin: { nodeOnlyFullStorageAccess?: boolean } | undefined,
): boolean {
    return plugin?.nodeOnlyFullStorageAccess === true;
}

// Applies one key of a plugin-supplied DB object. Returns true when the key
// was handled here (so callers must not write it into the real DB).
export function applyPluginDbKey(key: string, value: unknown): boolean {
    if (key !== PLUGIN_CUSTOM_STORAGE_KEY) return false;
    mergePluginCustomStorage(value);
    return true;
}

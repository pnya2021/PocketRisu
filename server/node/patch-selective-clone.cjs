'use strict';

const { decodePointerSegment } = require('./patch-hash-cache.cjs');

function collectPatchTopLevelKeys(patch) {
    const keys = new Set();
    let touchesRoot = false;

    for (const op of Array.isArray(patch) ? patch : []) {
        for (const field of ['path', 'from']) {
            const pointer = op?.[field];
            if (typeof pointer !== 'string') continue;
            if (pointer === '') {
                touchesRoot = true;
                continue;
            }
            if (!pointer.startsWith('/')) {
                touchesRoot = true;
                continue;
            }
            const nextSlash = pointer.indexOf('/', 1);
            const rawSegment = nextSlash === -1
                ? pointer.slice(1)
                : pointer.slice(1, nextSlash);
            keys.add(decodePointerSegment(rawSegment));
        }
    }

    return { keys, touchesRoot };
}

function isPlainPatchRoot(database) {
    return database !== null && typeof database === 'object' && !Array.isArray(database);
}

function clonePatchSnapshot(database, patch) {
    if (!isPlainPatchRoot(database)) {
        return structuredClone(database);
    }

    const { keys, touchesRoot } = collectPatchTopLevelKeys(patch);
    if (touchesRoot) {
        return structuredClone(database);
    }

    // The root itself must be independent so top-level add/remove/replace ops
    // cannot mutate the live cache. Untouched nested branches stay shared;
    // every top-level branch that a patch can mutate is cloned below.
    const snapshot = { ...database };
    for (const key of keys) {
        if (Object.prototype.hasOwnProperty.call(database, key)) {
            Object.defineProperty(snapshot, key, {
                value: structuredClone(database[key]),
                enumerable: true,
                configurable: true,
                writable: true,
            });
        }
    }
    return snapshot;
}

module.exports = {
    clonePatchSnapshot,
    collectPatchTopLevelKeys,
};

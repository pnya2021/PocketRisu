'use strict';

const crypto = require('crypto');

function fallbackOwnerId(prefix, name, index) {
    return `${prefix}-${crypto.createHash('sha256')
        .update(`${String(name || '')}\0${index}`)
        .digest('hex')
        .slice(0, 24)}`;
}

function moduleOwnerId(module, index) {
    return String(module?.id || module?.namespace || fallbackOwnerId('module', module?.name, index));
}

function characterOwnerId(character, index) {
    return String(character?.chaId || fallbackOwnerId('character', character?.name, index));
}

function personaOwnerId(persona, index) {
    return String(persona?.id || persona?.personaId || fallbackOwnerId('persona', persona?.name, index));
}

function enrichDescriptor(descriptor, kind, ownerId) {
    return {
        ...descriptor,
        ownerKind: kind,
        ownerId,
    };
}

/**
 * Move large tuple arrays out of a decoded DB object and into immutable
 * manifests. Returns a shallow structural copy; the source object and its
 * arrays are never mutated. Empty arrays stay inline because they cost nothing
 * and preserve old UI initialization semantics.
 */
function stripAssetManifests(dbObj, store, { activate = true } = {}) {
    if (!dbObj || typeof dbObj !== 'object') return { db: dbObj, migrated: [] };
    const migrated = [];
    const out = { ...dbObj };

    // `reconcile` is used when reading the canonical database.bin. Creating the
    // content-addressed row is side-effect free; the live pointer only moves
    // when disk content genuinely differs (initial migration or crash recovery).
    // A normal read of already-live content therefore cannot prune/re-activate
    // revisions behind an accepted manifest edit.
    function putCanonical(kind, ownerId, items) {
        if (activate !== 'reconcile') {
            return store.putManifest(kind, ownerId, items, { activate });
        }
        const candidate = store.putManifest(kind, ownerId, items, { activate: false });
        const live = store.getLiveDescriptor(kind, ownerId);
        if (live?.id === candidate.id) return live;
        return store.putManifest(kind, ownerId, items, { activate: true });
    }

    if (Array.isArray(dbObj.modules)) {
        out.modules = dbObj.modules.map((module, index) => {
            if (!module || !Array.isArray(module.assets) || module.assets.length === 0) return module;
            const ownerId = moduleOwnerId(module, index);
            try {
                const descriptor = enrichDescriptor(
                    putCanonical('module', ownerId, module.assets),
                    'module', ownerId,
                );
                const next = { ...module, assetManifest: descriptor };
                delete next.assets;
                migrated.push(descriptor);
                return next;
            } catch (error) {
                store.recordMigrationFailure('module', ownerId, error);
                throw error;
            }
        });
    }

    if (Array.isArray(dbObj.characters)) {
        out.characters = dbObj.characters.map((character, index) => {
            if (!character || !Array.isArray(character.additionalAssets) || character.additionalAssets.length === 0) {
                return character;
            }
            const ownerId = characterOwnerId(character, index);
            try {
                const descriptor = enrichDescriptor(
                    putCanonical('character', ownerId, character.additionalAssets),
                    'character', ownerId,
                );
                const next = { ...character, additionalAssetManifest: descriptor };
                delete next.additionalAssets;
                migrated.push(descriptor);
                return next;
            } catch (error) {
                store.recordMigrationFailure('character', ownerId, error);
                throw error;
            }
        });
    }

    if (Array.isArray(dbObj.personas)) {
        out.personas = dbObj.personas.map((persona, index) => {
            const embedded = persona?.embeddedModule;
            if (!embedded || !Array.isArray(embedded.assets) || embedded.assets.length === 0) return persona;
            const ownerId = personaOwnerId(persona, index);
            try {
                const descriptor = enrichDescriptor(
                    putCanonical('persona-module', ownerId, embedded.assets),
                    'persona-module', ownerId,
                );
                const nextEmbedded = { ...embedded, assetManifest: descriptor };
                delete nextEmbedded.assets;
                migrated.push(descriptor);
                return { ...persona, embeddedModule: nextEmbedded };
            } catch (error) {
                store.recordMigrationFailure('persona-module', ownerId, error);
                throw error;
            }
        });
    }

    return { db: out, migrated };
}

function loadDescriptorItems(store, descriptor) {
    if (!descriptor?.id) throw new Error('Asset manifest descriptor is missing an id');
    const verified = store.verifyManifest(descriptor.id);
    if (!verified.ok) throw new Error(`Asset manifest is unavailable or corrupt: ${descriptor.id}`);
    if (descriptor.version !== undefined && verified.version !== descriptor.version) {
        throw new Error(`Asset manifest version mismatch: ${descriptor.id}`);
    }
    if (descriptor.count !== undefined && verified.count !== descriptor.count) {
        throw new Error(`Asset manifest count mismatch: ${descriptor.id}`);
    }
    if (descriptor.sha256 && verified.sha256 !== descriptor.sha256) {
        throw new Error(`Asset manifest hash mismatch: ${descriptor.id}`);
    }
    if (descriptor.ownerKind && verified.ownerKind !== descriptor.ownerKind) {
        throw new Error(`Asset manifest owner kind mismatch: ${descriptor.id}`);
    }
    if (descriptor.ownerId && verified.ownerId !== descriptor.ownerId) {
        throw new Error(`Asset manifest owner id mismatch: ${descriptor.id}`);
    }
    return store.loadItems(descriptor.id);
}

/** Rebuild legacy tuple arrays for disk persistence and RisuAI-compatible export. */
function hydrateAssetManifests(dbObj, store) {
    if (!dbObj || typeof dbObj !== 'object') return dbObj;
    const out = { ...dbObj };

    if (Array.isArray(dbObj.modules)) {
        out.modules = dbObj.modules.map((module) => {
            if (!module?.assetManifest) return module;
            const next = { ...module, assets: loadDescriptorItems(store, module.assetManifest) };
            delete next.assetManifest;
            return next;
        });
    }

    if (Array.isArray(dbObj.characters)) {
        out.characters = dbObj.characters.map((character) => {
            if (!character?.additionalAssetManifest) return character;
            const next = {
                ...character,
                additionalAssets: loadDescriptorItems(store, character.additionalAssetManifest),
            };
            delete next.additionalAssetManifest;
            return next;
        });
    }

    if (Array.isArray(dbObj.personas)) {
        out.personas = dbObj.personas.map((persona) => {
            const embedded = persona?.embeddedModule;
            if (!embedded?.assetManifest) return persona;
            const nextEmbedded = { ...embedded, assets: loadDescriptorItems(store, embedded.assetManifest) };
            delete nextEmbedded.assetManifest;
            return { ...persona, embeddedModule: nextEmbedded };
        });
    }

    return out;
}

function assetManifestSummary(dbObj) {
    const descriptors = [];
    for (const module of dbObj?.modules || []) if (module?.assetManifest) descriptors.push(module.assetManifest);
    for (const character of dbObj?.characters || []) {
        if (character?.additionalAssetManifest) descriptors.push(character.additionalAssetManifest);
    }
    for (const persona of dbObj?.personas || []) {
        if (persona?.embeddedModule?.assetManifest) descriptors.push(persona.embeddedModule.assetManifest);
    }
    return {
        manifests: descriptors.length,
        items: descriptors.reduce((sum, descriptor) => sum + (Number(descriptor.count) || 0), 0),
        descriptors,
    };
}

/**
 * Disk-protection guard partner of findStubFlagLossChats, for lazy asset
 * manifests. An owner (module / character / persona embedded module) whose
 * assets were split out carries only a descriptor on the client. If a writer
 * hands back that owner with neither the descriptor nor an inline array —
 * a plugin rebuilding characters from a field whitelist, `remove
 * /characters/N/additionalAssetManifest`, a malformed full write — hydrate
 * would pass it through and the asset list would be gone on disk while the
 * manifest rows stay orphaned. Compare the previous document with the next
 * one by owner id and report those owners so the caller can reject.
 */
function findAssetManifestLossOwners(prevDb, nextDb) {
    if (!prevDb || !nextDb) return [];
    const losses = [];
    const check = (kind, prevList, nextList, ownerIdOf, hasDescriptor, hasInline) => {
        if (!Array.isArray(prevList) || !Array.isArray(nextList)) return;
        const prevIds = new Set();
        prevList.forEach((owner, i) => { if (hasDescriptor(owner)) prevIds.add(ownerIdOf(owner, i)); });
        if (prevIds.size === 0) return;
        nextList.forEach((owner, i) => {
            if (!owner || typeof owner !== 'object') return;
            const id = ownerIdOf(owner, i);
            if (prevIds.has(id) && !hasDescriptor(owner) && !hasInline(owner)) {
                losses.push({ kind, ownerId: id, index: i });
            }
        });
    };
    check('module', prevDb.modules, nextDb.modules, moduleOwnerId,
        (m) => !!m?.assetManifest, (m) => Array.isArray(m?.assets));
    check('character', prevDb.characters, nextDb.characters, characterOwnerId,
        (c) => !!c?.additionalAssetManifest, (c) => Array.isArray(c?.additionalAssets));
    check('persona', prevDb.personas, nextDb.personas, personaOwnerId,
        (p) => !!p?.embeddedModule?.assetManifest, (p) => Array.isArray(p?.embeddedModule?.assets));
    return losses;
}

module.exports = {
    findAssetManifestLossOwners,
    stripAssetManifests,
    hydrateAssetManifests,
    assetManifestSummary,
    moduleOwnerId,
    characterOwnerId,
    personaOwnerId,
};

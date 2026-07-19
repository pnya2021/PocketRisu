'use strict';

function randomId() {
    return require('crypto').randomUUID();
}

/**
 * Repair duplicate character/group IDs before chats are indexed by chaId.
 * The first record retains the historical ID so existing group membership
 * references stay deterministic; later colliding records receive fresh IDs.
 */
function repairDuplicateCharacterIds(database, createId = randomId) {
    const records = Array.isArray(database?.characters) ? database.characters : [];
    const reserved = new Set(records
        .map(record => record?.chaId)
        .filter(id => typeof id === 'string' && id.length > 0));
    const seen = new Set();
    const remapped = [];

    for (let index = 0; index < records.length; index++) {
        const record = records[index];
        const originalId = record?.chaId;
        if (typeof originalId !== 'string' || originalId.length === 0) continue;
        if (!seen.has(originalId)) {
            seen.add(originalId);
            continue;
        }

        let newId = '';
        for (let attempt = 0; attempt < 1024; attempt++) {
            const candidate = createId();
            if (typeof candidate === 'string' && candidate.length > 0 && !reserved.has(candidate)) {
                newId = candidate;
                break;
            }
        }
        if (!newId) throw new Error(`Unable to repair duplicate chaId at character index ${index}`);
        record.chaId = newId;
        reserved.add(newId);
        seen.add(newId);
        remapped.push({ index, originalId, newId });
    }

    return { changed: remapped.length > 0, remapped };
}

module.exports = { repairDuplicateCharacterIds };

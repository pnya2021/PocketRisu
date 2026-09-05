import type { PromptPresetFolder } from './storage/database.svelte'

export interface FolderGroup {
    /** `null` for the uncategorized group. */
    folder: PromptPresetFolder | null
    /** Indexes into the original item array, in original order. */
    indexes: number[]
}

/**
 * Groups item indexes by folder. Items whose folderId points to a missing
 * folder are treated as uncategorized so nothing silently disappears from
 * the UI. Folder order follows `folders`; the uncategorized group is last.
 */
export function groupByFolder(
    itemFolderIds: (string | undefined | null)[],
    folders: PromptPresetFolder[],
): FolderGroup[] {
    const byId = new Map<string, number[]>()
    for (const folder of folders) byId.set(folder.id, [])
    const uncategorized: number[] = []
    itemFolderIds.forEach((folderId, index) => {
        const bucket = folderId ? byId.get(folderId) : undefined
        if (bucket) bucket.push(index)
        else uncategorized.push(index)
    })
    return [
        ...folders.map(folder => ({ folder, indexes: byId.get(folder.id) ?? [] })),
        { folder: null, indexes: uncategorized },
    ]
}

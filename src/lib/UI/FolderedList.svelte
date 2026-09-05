<script lang="ts">
    // Management list with collapsible folders. Items and folders are both
    // reorderable via Sortable (same pattern as SideChatList's chat folders:
    // one Sortable container per folder sharing a group, plus one for the
    // folder wrappers). Every drag action also has a menu equivalent so touch
    // users are never stuck.
    //
    // The parent owns the data. After any drag/menu action this component
    // reports the full new item order + folder membership via `onItemsChange`
    // and the folder array via `onFoldersChange`.
    import type { Snippet } from "svelte";
    import { ChevronDownIcon, ChevronRightIcon, EllipsisVerticalIcon, FolderIcon, FolderPlusIcon, SearchIcon } from "@lucide/svelte";
    import type { SortableEvent } from "sortablejs";
    import { v4 as uuidv4 } from "uuid";
    import { language } from "src/lang";
    import { alertConfirm, alertInput, alertSelect } from "src/ts/alert";
    import { groupByFolder } from "src/ts/folders";
    import type { PromptPresetFolder } from "src/ts/storage/database.svelte";
    import ShSortableList from "./GUI/ShSortableList.svelte";
    import ShButton from "./GUI/ShButton.svelte";
    import ShDropdownMenu from "./GUI/ShDropdownMenu.svelte";
    import ShDropdownMenuTrigger from "./GUI/ShDropdownMenuTrigger.svelte";
    import ShDropdownMenuContent from "./GUI/ShDropdownMenuContent.svelte";
    import ShDropdownMenuItem from "./GUI/ShDropdownMenuItem.svelte";
    import ShDropdownMenuSeparator from "./GUI/ShDropdownMenuSeparator.svelte";

    export interface FolderedItemPlacement {
        /** Index into the parent's current item array. */
        index: number
        folderId: string | undefined
    }

    interface Props {
        folders: PromptPresetFolder[];
        /** One entry per item, parallel to the parent's item array. */
        itemFolderIds: (string | undefined)[];
        /** Text used for the search filter, parallel to the item array. */
        itemSearchTexts: string[];
        selectedIndex?: number;
        searchPlaceholder?: string;
        /** localStorage key for remembering collapsed folders on this device. */
        storageKey?: string;
        onSelect: (index: number) => void;
        onItemsChange: (placements: FolderedItemPlacement[]) => void;
        onFoldersChange: (folders: PromptPresetFolder[]) => void;
        /** Optional per-item menu actions. Rendered only when provided. */
        onDuplicate?: (index: number) => void;
        onExport?: (index: number) => void;
        onDelete?: (index: number) => void;
        itemContent: Snippet<[number]>;
        /** Optional inline panel rendered under items for which `isExpanded` returns true.
         *  Unlike itemContent it sits outside the click/hover header, so it can hold inputs. */
        itemPanel?: Snippet<[number]>;
        isExpanded?: (index: number) => boolean;
        /** Extra menu entries per item, rendered before the destructive ones. */
        itemMenu?: Snippet<[number]>;
        /** Toolbar content shown top-left, opposite the "new folder" button. */
        actions?: Snippet;
    }

    let {
        folders,
        itemFolderIds,
        itemSearchTexts,
        selectedIndex = -1,
        searchPlaceholder = language.search,
        storageKey,
        onSelect,
        onItemsChange,
        onFoldersChange,
        onDuplicate,
        onExport,
        onDelete,
        itemContent,
        itemPanel,
        isExpanded = () => false,
        itemMenu,
        actions,
    }: Props = $props();

    let rootEl: HTMLDivElement = $state();
    let searchQuery = $state('');
    let collapsed = $state<Set<string>>(loadCollapsed());

    const groups = $derived(groupByFolder(itemFolderIds, folders));
    const query = $derived(searchQuery.trim().toLocaleLowerCase());
    // Dragging while a search filter hides rows would reorder against an
    // incomplete DOM, so drag is disabled during search (menus still work).
    const dragDisabled = $derived(query.length > 0);

    function matches(index: number) {
        return !query || (itemSearchTexts[index] ?? '').toLocaleLowerCase().includes(query);
    }

    function loadCollapsed(): Set<string> {
        if (!storageKey) return new Set();
        try {
            const raw = localStorage.getItem(storageKey);
            return new Set(raw ? JSON.parse(raw) as string[] : []);
        } catch {
            return new Set();
        }
    }

    function toggleCollapsed(folderId: string) {
        const next = new Set(collapsed);
        if (next.has(folderId)) next.delete(folderId);
        else next.add(folderId);
        collapsed = next;
        if (storageKey) {
            try { localStorage.setItem(storageKey, JSON.stringify([...next])); } catch {}
        }
    }

    /** Current placements as rendered in the DOM (source of truth right after a drop). */
    function placementsFromDom(): FolderedItemPlacement[] {
        const out: FolderedItemPlacement[] = [];
        rootEl.querySelectorAll<HTMLElement>('[data-folder-container]').forEach(container => {
            const folderId = container.dataset.folderContainer || undefined;
            // Items sit one level down inside the ShSortableList wrapper div.
            container.querySelectorAll<HTMLElement>('[data-sortable-key]').forEach(item => {
                out.push({ index: Number(item.dataset.sortableKey), folderId });
            });
        });
        return out;
    }

    /** Current placements from data (for menu-driven edits). */
    function placementsFromData(): FolderedItemPlacement[] {
        return groups.flatMap(group => group.indexes.map(index => ({ index, folderId: group.folder?.id })));
    }

    function onItemDrop(_orderedKeys: string[], _event: SortableEvent) {
        onItemsChange(placementsFromDom());
    }

    function onFolderDrop(orderedIds: string[]) {
        const byId = new Map(folders.map(folder => [folder.id, folder]));
        onFoldersChange(orderedIds.map(id => byId.get(id)).filter((folder): folder is PromptPresetFolder => !!folder));
    }

    async function createFolder() {
        const name = (await alertInput(language.folderNameInput))?.trim();
        if (!name) return;
        const id = uuidv4();
        onFoldersChange([...folders, { id, name }]);
    }

    async function renameFolder(folder: PromptPresetFolder) {
        const name = (await alertInput(language.folderNameInput, [], folder.name))?.trim();
        if (!name || name === folder.name) return;
        onFoldersChange(folders.map(f => f.id === folder.id ? { ...f, name } : f));
    }

    async function deleteFolder(folder: PromptPresetFolder) {
        if (!await alertConfirm(language.folderDeleteKeepItems)) return;
        onItemsChange(placementsFromData().map(p => p.folderId === folder.id ? { ...p, folderId: undefined } : p));
        onFoldersChange(folders.filter(f => f.id !== folder.id));
    }

    function moveFolder(folder: PromptPresetFolder, delta: -1 | 1) {
        const from = folders.findIndex(f => f.id === folder.id);
        const to = from + delta;
        if (from < 0 || to < 0 || to >= folders.length) return;
        const next = [...folders];
        next.splice(from, 1);
        next.splice(to, 0, folder);
        onFoldersChange(next);
    }

    async function moveItemToFolder(index: number) {
        const options = [...folders.map(f => f.name), language.folderUncategorized, language.cancel];
        const sel = parseInt(await alertSelect(options));
        if (Number.isNaN(sel) || sel >= options.length - 1) return;
        const folderId = sel < folders.length ? folders[sel].id : undefined;
        const placements = placementsFromData().filter(p => p.index !== index);
        // Append at the end of the chosen group.
        const lastInGroup = placements.map(p => p.folderId).lastIndexOf(folderId);
        placements.splice(lastInGroup + 1, 0, { index, folderId });
        onItemsChange(placements);
    }

    function moveItem(index: number, delta: -1 | 1) {
        const placements = placementsFromData();
        const from = placements.findIndex(p => p.index === index);
        const to = from + delta;
        if (from < 0 || to < 0 || to >= placements.length) return;
        if (placements[to].folderId !== placements[from].folderId) return;
        const [moved] = placements.splice(from, 1);
        placements.splice(to, 0, moved);
        onItemsChange(placements);
    }
</script>

<div class="flex flex-col gap-2" bind:this={rootEl}>
    <div class="flex items-center gap-2">
        {@render actions?.()}
        <div class="grow"></div>
        <ShButton size="sm" variant="outline" onclick={createFolder}><FolderPlusIcon />{language.folderNew}</ShButton>
    </div>
    <div class="risu-field-border flex items-center gap-2 rounded-md px-3">
        <SearchIcon size={18} class="text-textcolor2 shrink-0"/>
        <input bind:value={searchQuery} placeholder={searchPlaceholder}
            class="w-full py-2 bg-transparent text-textcolor outline-none"/>
    </div>

    <ShSortableList
        className="flex flex-col gap-2"
        disabled={dragDisabled}
        draggable="[data-folder-key]"
        dataAttribute="data-folder-key"
        options={{ group: 'foldered-list-folders' }}
        onReorder={onFolderDrop}
    >
        {#each groups as group (group.folder?.id ?? '')}
            {#if group.folder}
                {@const folder = group.folder}
                {@const isCollapsed = collapsed.has(folder.id)}
                <div data-folder-key={folder.id} class="rounded-md border border-darkborderc bg-darkbg">
                    <div class="flex items-center gap-2 px-2 py-2 text-textcolor cursor-pointer select-none"
                        role="button" tabindex="0"
                        onclick={() => toggleCollapsed(folder.id)}
                        onkeydown={(e) => { if (e.key === 'Enter') toggleCollapsed(folder.id) }}>
                        {#if isCollapsed}<ChevronRightIcon size={16} class="shrink-0 text-textcolor2"/>{:else}<ChevronDownIcon size={16} class="shrink-0 text-textcolor2"/>{/if}
                        <FolderIcon size={16} class="shrink-0 text-textcolor2"/>
                        <span class="truncate grow">{folder.name}</span>
                        <span class="text-xs text-textcolor2">{group.indexes.length}</span>
                        {@render folderMenu(folder)}
                    </div>
                    <div data-folder-container={folder.id} class:hidden={isCollapsed}>
                        <ShSortableList
                            className="flex flex-col px-2 pb-2 gap-0.5 min-h-8"
                            disabled={dragDisabled}
                            options={{ group: 'foldered-list-items' }}
                            onReorder={onItemDrop}
                        >
                            {#each group.indexes as index (index)}
                                {@render row(index)}
                            {:else}
                                <div class="no-sort text-xs text-textcolor2 text-center py-1">{language.none}</div>
                            {/each}
                        </ShSortableList>
                    </div>
                </div>
            {/if}
        {/each}
    </ShSortableList>

    {#each groups as group (group.folder?.id ?? '')}
        {#if !group.folder}
            {@const isCollapsed = collapsed.has('')}
            <div class="rounded-md border border-darkborderc bg-darkbg">
                <!-- Always shown (even with no folders) so users discover that folders exist. -->
                    <!-- Same structure/sizing as a folder header (icon + menu-width spacer) so rows line up. -->
                    <div class="flex items-center gap-2 px-2 py-2 text-textcolor2 cursor-pointer select-none"
                        role="button" tabindex="0"
                        onclick={() => toggleCollapsed('')}
                        onkeydown={(e) => { if (e.key === 'Enter') toggleCollapsed('') }}>
                        {#if isCollapsed}<ChevronRightIcon size={16} class="shrink-0"/>{:else}<ChevronDownIcon size={16} class="shrink-0"/>{/if}
                        <FolderIcon size={16} class="shrink-0"/>
                        <span class="truncate grow">{language.folderUncategorized}</span>
                        <span class="text-xs">{group.indexes.length}</span>
                        <span class="shrink-0 p-1 w-6 h-6" aria-hidden="true"></span>
                    </div>
                <div data-folder-container="" class:hidden={isCollapsed}>
                    <ShSortableList
                        className="flex flex-col px-2 pb-2 gap-0.5 min-h-8"
                        disabled={dragDisabled}
                        options={{ group: 'foldered-list-items' }}
                        onReorder={onItemDrop}
                    >
                        {#each group.indexes as index (index)}
                            {@render row(index)}
                        {/each}
                    </ShSortableList>
                </div>
            </div>
        {/if}
    {/each}
</div>

{#snippet row(index)}
    <div data-sortable-key={String(index)} data-sortable-no-scale class:hidden={!matches(index)}>
    <!-- Header line is the only click/hover target; an expanded panel below it is inert. -->
    <div
        class="flex items-center gap-2 rounded-md px-2 min-h-11 py-1 text-textcolor cursor-pointer {index === selectedIndex ? 'bg-selected' : 'risu-interactive-surface'}"
        role="button" tabindex="0"
        onclick={() => onSelect(index)}
        onkeydown={(e) => {
            // Only the header itself — inputs rendered inside itemContent must keep their Space/Enter.
            if (e.target !== e.currentTarget) return
            if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onSelect(index) }
        }}>
        {@render itemContent(index)}
        <ShDropdownMenu>
            <ShDropdownMenuTrigger>
                {#snippet child({ props })}
                    <button {...props} class="no-sort shrink-0 p-1 rounded text-textcolor2 risu-interactive-accent" aria-label="menu"
                        onclick={(e) => { e.stopPropagation(); (props as { onclick?: (e: MouseEvent) => void }).onclick?.(e) }}>
                        <EllipsisVerticalIcon size={16}/>
                    </button>
                {/snippet}
            </ShDropdownMenuTrigger>
            <ShDropdownMenuContent align="end" class="min-w-40">
                {@render itemMenu?.(index)}
                <ShDropdownMenuItem onSelect={() => moveItemToFolder(index)}><FolderIcon /><span>{language.folderMoveTo}</span></ShDropdownMenuItem>
                <ShDropdownMenuItem onSelect={() => moveItem(index, -1)}><span>{language.moveUp}</span></ShDropdownMenuItem>
                <ShDropdownMenuItem onSelect={() => moveItem(index, 1)}><span>{language.moveDown}</span></ShDropdownMenuItem>
                {#if onDuplicate || onExport || onDelete}
                    <ShDropdownMenuSeparator />
                    {#if onDuplicate}<ShDropdownMenuItem onSelect={() => onDuplicate(index)}><span>{language.personaDuplicate}</span></ShDropdownMenuItem>{/if}
                    {#if onExport}<ShDropdownMenuItem onSelect={() => onExport(index)}><span>{language.export}</span></ShDropdownMenuItem>{/if}
                    {#if onDelete}<ShDropdownMenuItem variant="destructive" onSelect={() => onDelete(index)}><span>{language.remove}</span></ShDropdownMenuItem>{/if}
                {/if}
            </ShDropdownMenuContent>
        </ShDropdownMenu>
    </div>
    {#if itemPanel && isExpanded(index)}
        <div class="no-sort px-2 pb-2 cursor-default">
            {@render itemPanel(index)}
        </div>
    {/if}
    </div>
{/snippet}

{#snippet folderMenu(folder)}
    <ShDropdownMenu>
        <ShDropdownMenuTrigger>
            {#snippet child({ props })}
                <button {...props} class="no-sort shrink-0 p-1 rounded text-textcolor2 risu-interactive-accent" aria-label="menu"
                    onclick={(e) => { e.stopPropagation(); (props as { onclick?: (e: MouseEvent) => void }).onclick?.(e) }}>
                    <EllipsisVerticalIcon size={16}/>
                </button>
            {/snippet}
        </ShDropdownMenuTrigger>
        <ShDropdownMenuContent align="end" class="min-w-40">
            <ShDropdownMenuItem onSelect={() => renameFolder(folder)}><span>{language.renameFolder}</span></ShDropdownMenuItem>
            <ShDropdownMenuItem onSelect={() => moveFolder(folder, -1)}><span>{language.moveUp}</span></ShDropdownMenuItem>
            <ShDropdownMenuItem onSelect={() => moveFolder(folder, 1)}><span>{language.moveDown}</span></ShDropdownMenuItem>
            <ShDropdownMenuSeparator />
            <ShDropdownMenuItem variant="destructive" onSelect={() => deleteFolder(folder)}><span>{language.remove}</span></ShDropdownMenuItem>
        </ShDropdownMenuContent>
    </ShDropdownMenu>
{/snippet}

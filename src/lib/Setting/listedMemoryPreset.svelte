<script lang="ts">
    // Read-only long-term memory preset picker (sidebar / quick menu). Grouped
    // by folder; editing and folder management live in Settings → Long Term Memory.
    import { ChevronDownIcon, ChevronRightIcon, FolderIcon, SearchIcon, SettingsIcon, XIcon } from "@lucide/svelte";
    import { language } from "../../lang";
    import { DBState, selectedCharID } from 'src/ts/stores.svelte';
    import { groupByFolder } from "src/ts/folders";
    import { openSettings, SettingsRoute } from "src/ts/routing";
    import { MEMORY_PRESET_DEFAULT, MEMORY_PRESET_OFF, getMemoryBinding, getMemoryPreset } from "src/ts/process/memory/memoryPresets";

    interface Props {
        close?: () => void;
        /** Receives a preset id, 'off' or 'default'. */
        onSelect?: ((value: string) => void) | null;
    }

    let { close = () => {}, onSelect = null }: Props = $props();
    let searchQuery = $state('');
    // Folders start collapsed; searching shows everything that matches.
    // Folders start collapsed; the uncategorized group (key '') starts open,
    // so for that key the set records "collapsed" instead. Always shown as a
    // header so the list reads the same with or without folders.
    let expanded = $state<Set<string>>(new Set());

    function toggle(key: string) {
        const next = new Set(expanded);
        if (next.has(key)) next.delete(key); else next.add(key);
        expanded = next;
    }

    const query = $derived(searchQuery.trim().toLocaleLowerCase());
    const presets = $derived(DBState.db.memoryPresets ?? []);
    const groups = $derived(groupByFolder(presets.map(p => p.folderId), DBState.db.memoryPresetFolders ?? []));
    const defaultName = $derived(getMemoryPreset(DBState.db, DBState.db.memoryPresetId)?.name ?? language.memoryPresetOff);
    const current = $derived.by(() => {
        const char = DBState.db.characters[$selectedCharID];
        return getMemoryBinding(char, char?.chats?.[char?.chatPage]);
    });

    function matches(index: number) {
        return !query || presets[index].name.toLocaleLowerCase().includes(query);
    }

    function select(value: string) {
        onSelect?.(value)
        close()
    }
</script>

<div class="absolute w-full h-full z-40 bg-black/50 flex justify-center items-center">
    <div class="bg-darkbg p-4 break-any rounded-md flex flex-col max-w-3xl w-96 max-h-full overflow-y-auto max-sm:w-full max-sm:h-full max-sm:max-w-none max-sm:rounded-none">
        <div class="flex items-center text-textcolor mb-3">
            <h2 class="mt-0 mb-0 font-bold">{language.longTermMemory}</h2>
            <div class="grow flex justify-end">
                <button class="text-textcolor2 hover:text-primary mr-2 cursor-pointer items-center" onclick={close}>
                    <XIcon size={24}/>
                </button>
            </div>
        </div>
        <button onclick={() => select(MEMORY_PRESET_DEFAULT)}
            class="flex items-center gap-2 text-textcolor border-t border-darkborderc p-2 cursor-pointer hover:bg-selected/30"
            class:bg-selected={current === MEMORY_PRESET_DEFAULT}>
            <span class="w-full text-left truncate"><span class="font-medium">{language.memoryPresetInherit}</span><span class="opacity-75"> ({defaultName})</span></span>
        </button>
        <button onclick={() => select(MEMORY_PRESET_OFF)}
            class="flex items-center gap-2 text-textcolor border-t border-darkborderc p-2 mb-2 cursor-pointer hover:bg-selected/30"
            class:bg-selected={current === MEMORY_PRESET_OFF}>
            <span class="w-full text-left truncate font-medium">{language.memoryPresetOff}</span>
        </button>
        <div class="risu-field-border flex items-center gap-2 rounded-md px-3 my-2">
            <SearchIcon size={16} class="text-textcolor2 shrink-0"/>
            <input bind:value={searchQuery} placeholder={language.memoryPresetSearch}
                class="w-full py-1.5 text-sm bg-transparent text-textcolor outline-none"/>
        </div>
        {#each groups as group (group.folder?.id ?? '')}
            {@const visible = group.indexes.filter(matches)}
            {@const key = group.folder?.id ?? ''}
            {@const hasHeader = true}
            {@const open = !!query || (key === '' ? !expanded.has(key) : expanded.has(key))}
            {#if visible.length > 0}
                {#if hasHeader}
                    <button class="flex items-center gap-2 w-full rounded-md px-2 py-2 mt-1 text-textcolor cursor-pointer hover:bg-selected/30 select-none" onclick={() => toggle(key)}>
                        {#if open}<ChevronDownIcon size={16} class="shrink-0 text-textcolor2"/>{:else}<ChevronRightIcon size={16} class="shrink-0 text-textcolor2"/>{/if}
                        <FolderIcon size={16} class="shrink-0 text-textcolor2"/>
                        <span class="grow text-left truncate {group.folder ? '' : 'text-textcolor2'}">{group.folder?.name ?? language.folderUncategorized}</span>
                        <span class="text-xs text-textcolor2">{visible.length}</span>
                    </button>
                {/if}
                {#each open ? visible : [] as i}
                    {@const preset = presets[i]}
                    <button onclick={() => select(preset.id)}
                        class="flex items-center gap-2 text-textcolor border-t border-darkborderc p-2 pl-7 cursor-pointer hover:bg-selected/30"
                        class:bg-selected={current === preset.id}>
                        <span class="overflow-x-auto whitespace-nowrap w-full text-left">
                            <span class="font-medium">{preset.name}</span>
                            {#if preset.id === DBState.db.memoryPresetId}
                                <span class="opacity-75 text-xs"> · {language.memoryPresetDefault}</span>
                            {/if}
                        </span>
                    </button>
                {/each}
            {/if}
        {/each}
        <button class="mt-3 pt-2 border-t border-darkborderc flex items-center gap-2 text-sm text-textcolor2 hover:text-primary cursor-pointer"
            onclick={() => { close(); openSettings(SettingsRoute.LongTermMemory) }}>
            <SettingsIcon size={16}/><span>{language.memoryPresetManage}</span>
        </button>
    </div>
</div>

<style>
    .break-any{
        word-break: normal;
        overflow-wrap: anywhere;
    }
</style>

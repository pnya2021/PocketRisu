<script lang="ts">
    // Read-only model preset picker (chat/character model binding). Grouped by
    // folder; editing and folder management live in Settings → Model Presets.
    import { ChevronDownIcon, ChevronRightIcon, FolderIcon, SearchIcon, SettingsIcon, XIcon } from "@lucide/svelte";
    import { language } from "../../lang";
    import { DBState, modelPresetSelectCallback } from 'src/ts/stores.svelte';
    import { get } from 'svelte/store';
    import { openSettings, SettingsRoute } from 'src/ts/routing';
    import { groupByFolder } from "src/ts/folders";

    interface Props {
        close?: () => void;
    }

    let { close = () => {} }: Props = $props();

    // Clear any pending model-preset-select callback when the modal unmounts
    // so a stale callback can't fire on a later open.
    $effect(() => {
        return () => {
            modelPresetSelectCallback.set(null);
        };
    });

    let searchQuery = $state('');
    // Folders start collapsed; searching shows everything that matches.
    // Folders start collapsed; the uncategorized group (key '') starts open,
    // so for that key the set records "collapsed" instead. Always shown as a
    // header so the list reads the same with or without folders.
    let expanded = $state<Set<string>>(new Set());

    const query = $derived(searchQuery.trim().toLocaleLowerCase());
    const groups = $derived(groupByFolder(DBState.db.modelPresets.map(p => p.folderId), DBState.db.modelPresetFolders ?? []));

    function matches(index: number) {
        const preset = DBState.db.modelPresets[index];
        return !query || `${preset?.name ?? ''}\n${preset?.profileSnapshot?.profileId ?? ''}`.toLocaleLowerCase().includes(query);
    }

    function toggle(key: string) {
        const next = new Set(expanded);
        if (next.has(key)) next.delete(key); else next.add(key);
        expanded = next;
    }

    function select(index: number) {
        const cb = get(modelPresetSelectCallback)
        if (cb) {
            modelPresetSelectCallback.set(null)
            cb(DBState.db.modelPresets[index].id)
            close()
        }
        // No callback = chat-binding flow never opened the modal; there is no
        // "active" model preset concept, so plain selection is a no-op.
    }
</script>

<div class="absolute w-full h-full z-40 bg-black/50 flex justify-center items-center">
    <div class="bg-darkbg p-4 break-any rounded-md flex flex-col max-w-3xl w-124 max-h-full overflow-y-auto max-sm:w-full max-sm:h-full max-sm:max-w-none max-sm:rounded-none">
        <div class="flex items-center text-textcolor mb-3">
            <h2 class="mt-0 mb-0">{language.modelPresets}</h2>
            <div class="grow flex justify-end">
                <button class="text-textcolor2 hover:text-primary mr-2 cursor-pointer items-center" onclick={close}>
                    <XIcon size={24}/>
                </button>
            </div>
        </div>
        <div class="risu-field-border flex items-center gap-2 rounded-md px-3 mb-2">
            <SearchIcon size={16} class="text-textcolor2 shrink-0"/>
            <input bind:value={searchQuery} placeholder={language.search}
                class="w-full py-1.5 text-sm bg-transparent text-textcolor outline-none"/>
        </div>
        {#if DBState.db.modelPresets.length === 0}
            <div class="text-textcolor2 text-sm text-center py-8">{language.modelPresetEmpty}</div>
        {/if}
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
                    {@const preset = DBState.db.modelPresets[i]}
                    <button onclick={() => select(i)}
                        class="flex items-center gap-2 text-textcolor border-t border-darkborderc p-2 pl-7 cursor-pointer hover:bg-selected/30 text-left">
                        <span class="min-w-0 grow truncate">{preset.name}</span>
                        {#if preset.profileSnapshot?.profileId}
                            <span class="text-textcolor2 text-xs shrink-0 opacity-70">{preset.profileSnapshot.profileId}</span>
                        {/if}
                    </button>
                {/each}
            {/if}
        {/each}
        <button class="mt-3 pt-2 border-t border-darkborderc flex items-center gap-2 text-sm text-textcolor2 hover:text-primary cursor-pointer"
            onclick={() => { close(); openSettings(SettingsRoute.ModelPreset) }}>
            <SettingsIcon size={16}/><span>{language.presetManage}</span>
        </button>
    </div>
</div>

<style>
    .break-any{
        word-break: normal;
        overflow-wrap: anywhere;
    }
</style>

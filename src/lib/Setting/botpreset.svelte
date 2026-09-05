<script lang="ts">
    // Read-only prompt preset picker (sidebar / chat). Grouped by folder;
    // editing and folder management live in Settings → Prompt.
    import { ChevronDownIcon, ChevronRightIcon, FolderIcon, GitCompare, SearchIcon, SettingsIcon, XIcon } from "@lucide/svelte";
    import { language } from "../../lang";
    import { changeToPreset } from "../../ts/storage/database.svelte";
    import { DBState, presetSelectCallback, selectedCharID } from 'src/ts/stores.svelte';
    import { get } from 'svelte/store';
    import { openSettings, SettingsRoute } from 'src/ts/routing';
    import { groupByFolder } from "src/ts/folders";
    import PromptDiffModal from "../Others/PromptDiffModal.svelte";

    interface Props {
        close?: () => void;
    }

    let { close = () => {} }: Props = $props();

    // Clear any pending preset-select callback when the modal unmounts,
    // so a stale callback can't fire on a later open.
    $effect(() => {
        return () => {
            presetSelectCallback.set(null);
        };
    });

    let searchQuery = $state('');
    // Folders start collapsed; searching shows everything that matches.
    // Folders start collapsed; the uncategorized group (key '') starts open,
    // so for that key the set records "collapsed" instead. Always shown as a
    // header so the list reads the same with or without folders.
    let expanded = $state<Set<string>>(new Set());

    const query = $derived(searchQuery.trim().toLocaleLowerCase());
    // Binding mode (opened from the sidebar binding button): a top "default"
    // row unbinds and the highlighted item is the chat's bound preset.
    const bindingMode = $derived($presetSelectCallback !== null);
    const boundIndex = $derived.by(() => {
        if (!bindingMode) return -1
        const char = DBState.db.characters[$selectedCharID]
        const id = char?.chats?.[char?.chatPage]?.bindedBotPreset
        return id ? DBState.db.botPresets.findIndex(p => p.id === id) : -1
    });
    const highlightIndex = $derived(bindingMode ? boundIndex : DBState.db.botPresetsId);
    const groups = $derived(groupByFolder(DBState.db.botPresets.map(p => p.folderId), DBState.db.promptPresetFolders ?? []));

    function matches(index: number) {
        return !query || (DBState.db.botPresets[index]?.name ?? '').toLocaleLowerCase().includes(query);
    }

    function toggle(key: string) {
        const next = new Set(expanded);
        if (next.has(key)) next.delete(key); else next.add(key);
        expanded = next;
    }

    function select(index: number) {
        const cb = get(presetSelectCallback)
        if (cb) {
            presetSelectCallback.set(null)
            cb(index)
        } else {
            changeToPreset(index)
        }
        close()
    }

    let showDiffModal = $state(false)
    let selectedDiffPreset = $state<number | null>(null)
    let firstPresetId = $state<number | null>(null);
    let secondPresetId = $state<number | null>(null);

    function handleDiffMode(id: number) {
        if (selectedDiffPreset === id) {
            selectedDiffPreset = null
            firstPresetId = null
            secondPresetId = null
            return
        }
        selectedDiffPreset = id
        if (firstPresetId === null) {
            firstPresetId = id
            secondPresetId = null
            return
        }
        secondPresetId = id
        selectedDiffPreset = null
        showDiffModal = true
    }

    function closeDiff() {
        showDiffModal = false;
        firstPresetId = null;
        secondPresetId = null;
        selectedDiffPreset = null;
    }
</script>

<div class="absolute w-full h-full z-40 bg-black/50 flex justify-center items-center">
    <div class="bg-darkbg p-4 break-any rounded-md flex flex-col max-w-3xl w-124 max-h-full overflow-y-auto max-sm:w-full max-sm:h-full max-sm:max-w-none max-sm:rounded-none">
        <div class="flex items-center text-textcolor mb-3">
            <h2 class="mt-0 mb-0">{language.promptPresets}</h2>
            <div class="grow flex justify-end">
                <button class="text-textcolor2 hover:text-primary mr-2 cursor-pointer items-center" onclick={close}>
                    <XIcon size={24}/>
                </button>
            </div>
        </div>
        {#if bindingMode}
            <button onclick={() => select(-1)}
                class="flex items-center gap-2 text-textcolor border-t border-darkborderc p-2 mb-2 cursor-pointer hover:bg-selected/30"
                class:bg-selected={boundIndex < 0}>
                <span class="min-w-0 grow truncate text-left"><span class="font-medium">{language.memoryPresetInherit}</span><span class="opacity-75"> ({DBState.db.botPresets[DBState.db.botPresetsId]?.name ?? language.none})</span></span>
            </button>
        {/if}
        <div class="risu-field-border flex items-center gap-2 rounded-md px-3 mb-2">
            <SearchIcon size={16} class="text-textcolor2 shrink-0"/>
            <input bind:value={searchQuery} placeholder={language.search}
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
                    {@const preset = DBState.db.botPresets[i]}
                    <button onclick={() => select(i)}
                        class="flex items-center gap-2 text-textcolor border-t border-darkborderc p-2 pl-7 cursor-pointer hover:bg-selected/30"
                        class:bg-selected={i === highlightIndex}>
                        {#if preset.image}
                            <img src={preset.image} alt="" class="h-7 w-7 shrink-0 rounded-md object-cover" decoding="async"/>
                        {/if}
                        <span class="min-w-0 grow truncate text-left">{preset.name}</span>
                        {#if DBState.db.showPromptComparison}
                            <span class="{selectedDiffPreset === i ? 'text-green-500' : 'text-textcolor2 hover:text-primary'} shrink-0" role="button" tabindex="0"
                                onclick={(e) => { e.stopPropagation(); handleDiffMode(i) }}
                                onkeydown={(e) => { if (e.key === 'Enter') { e.stopPropagation(); handleDiffMode(i) } }}>
                                <GitCompare size={18}/>
                            </span>
                        {/if}
                    </button>
                {/each}
            {/if}
        {/each}
        <button class="mt-3 pt-2 border-t border-darkborderc flex items-center gap-2 text-sm text-textcolor2 hover:text-primary cursor-pointer"
            onclick={() => { close(); openSettings(SettingsRoute.PromptPreset) }}>
            <SettingsIcon size={16}/><span>{language.presetManage}</span>
        </button>
    </div>
</div>

{#if showDiffModal && firstPresetId !== null && secondPresetId !== null}
  <PromptDiffModal
    firstPresetId={firstPresetId}
    secondPresetId={secondPresetId}
    onClose={closeDiff}
  />
{/if}

<style>
    .break-any{
        word-break: normal;
        overflow-wrap: anywhere;
    }
</style>

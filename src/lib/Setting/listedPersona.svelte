<script lang="ts">
    // Read-only persona picker (sidebar / chat). Grouped by folder; editing and
    // folder management live in Settings → Persona.
    import { ChevronDownIcon, ChevronRightIcon, FolderIcon, SearchIcon, SettingsIcon, XIcon } from "@lucide/svelte";
    import { language } from "../../lang";
    import { DBState, selectedCharID } from 'src/ts/stores.svelte';
    import { changeUserPersona } from "src/ts/persona";
    import { getCharImage } from "src/ts/characters";
    import { groupByFolder } from "src/ts/folders";
    import { openSettings, SettingsRoute } from "src/ts/routing";

    interface Props {
        close?: () => void;
        onSelect?: ((index: number) => void) | null;
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
    // Binding mode (opened from the sidebar binding button): a top "default"
    // row unbinds and the highlighted item is the chat's bound persona.
    const bindingMode = $derived(onSelect !== null);
    const boundIndex = $derived.by(() => {
        if (!bindingMode) return -1
        const char = DBState.db.characters[$selectedCharID]
        const id = char?.chats?.[char?.chatPage]?.bindedPersona
        return id ? DBState.db.personas.findIndex(p => p.id === id) : -1
    });
    const highlightIndex = $derived(bindingMode ? boundIndex : DBState.db.selectedPersona);
    const groups = $derived(groupByFolder(DBState.db.personas.map(p => p.folderId), DBState.db.personaFolders ?? []));

    function matches(index: number) {
        const persona = DBState.db.personas[index];
        return !query || `${persona.name ?? ''}\n${persona.note ?? ''}`.toLocaleLowerCase().includes(query);
    }

    function select(index: number) {
        if (onSelect) onSelect(index)
        else changeUserPersona(index)
        close()
    }
</script>

<div class="absolute w-full h-full z-40 bg-black/50 flex justify-center items-center">
    <div class="bg-darkbg p-4 break-any rounded-md flex flex-col max-w-3xl w-96 max-h-full overflow-y-auto max-sm:w-full max-sm:h-full max-sm:max-w-none max-sm:rounded-none">
        <div class="flex items-center text-textcolor mb-3">
            <h2 class="mt-0 mb-0 font-bold">{language.persona}</h2>
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
                <span class="overflow-x-auto whitespace-nowrap w-full text-left"><span class="font-medium">{language.memoryPresetInherit}</span><span class="opacity-75"> ({DBState.db.personas[DBState.db.selectedPersona]?.name ?? 'User'})</span></span>
            </button>
        {/if}
        <div class="risu-field-border flex items-center gap-2 rounded-md px-3 mb-2">
            <SearchIcon size={16} class="text-textcolor2 shrink-0"/>
            <input bind:value={searchQuery} placeholder={language.personaSearch}
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
                    {@const persona = DBState.db.personas[i]}
                    <button onclick={() => select(i)}
                        class="flex items-center gap-2 text-textcolor border-t border-darkborderc p-2 pl-7 cursor-pointer hover:bg-selected/30"
                        class:bg-selected={i === highlightIndex}>
                        <div class="h-7 w-7 shrink-0 overflow-hidden rounded-md bg-textcolor2">
                            {#if persona.icon}
                                {#await getCharImage(persona.icon, 'css') then im}
                                    <div class="h-full w-full bg-cover bg-center" style={im}></div>
                                {/await}
                            {/if}
                        </div>
                        <span class="overflow-x-auto whitespace-nowrap w-full text-left">
                            <span class="font-medium">{persona.name}</span>
                            {#if persona.note}
                                <span class="opacity-75"> / {persona.note}</span>
                            {/if}
                        </span>
                    </button>
                {/each}
            {/if}
        {/each}
        <button class="mt-3 pt-2 border-t border-darkborderc flex items-center gap-2 text-sm text-textcolor2 hover:text-primary cursor-pointer"
            onclick={() => { close(); openSettings(SettingsRoute.Persona) }}>
            <SettingsIcon size={16}/><span>{language.personaManage}</span>
        </button>
    </div>
</div>

<style>
    .break-any{
        word-break: normal;
        overflow-wrap: anywhere;
    }
</style>

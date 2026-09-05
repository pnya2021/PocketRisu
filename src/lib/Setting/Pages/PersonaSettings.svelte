<script lang="ts">
    import { language } from "src/lang";
    import SettingPage from "src/lib/UI/GUI/SettingPage.svelte";
    import ShButton from "src/lib/UI/GUI/ShButton.svelte";
    import Check from "src/lib/UI/GUI/CheckInput.svelte";
    import Help from "src/lib/Others/Help.svelte";
    import TextAreaInput from "src/lib/UI/GUI/TextAreaInput.svelte";
    import TextInput from "src/lib/UI/GUI/TextInput.svelte";
    import FolderedList, { type FolderedItemPlacement } from "src/lib/UI/FolderedList.svelte";
    import { HardDriveUploadIcon, PlusIcon, StarIcon } from "@lucide/svelte";
    import { alertConfirm } from "src/ts/alert";
    import { getCharImage } from "src/ts/characters";
    import { changeUserPersona, exportUserPersona, importUserPersona, saveUserPersona, selectUserImg } from "src/ts/persona";
    import { onDestroy } from "svelte";
    import { DBState } from 'src/ts/stores.svelte';
    import { requestImmediateSave } from "src/ts/globalApi.svelte";
    import { v4 } from "uuid"

    // selectedPersona can point past the array (persona removed by a plugin or
    // stale index in an imported DB) — clamp before the template dereferences it.
    if(!DBState.db.personas[DBState.db.selectedPersona] && DBState.db.personas.length > 0){
        DBState.db.selectedPersona = 0
    }

    // Tapping a row activates that persona and expands the editor inline
    // beneath it (same pattern as the plugin page). The editor edits the DB
    // top-level persona fields (username/personaPrompt/...), which always
    // mirror the *selected* persona — so only the selected row can be open.
    let expanded = $state(false)

    const folders = $derived(DBState.db.personaFolders ?? [])

    function ensureId(persona: typeof DBState.db.personas[number]) {
        persona.id ??= v4()
        return persona.id
    }

    function toggleRow(index: number) {
        if (index === DBState.db.selectedPersona) {
            expanded = !expanded
            if (!expanded) saveUserPersona()
            return
        }
        changeUserPersona(index)
        expanded = true
    }

    /** Rebuilds `db.personas` from the list's reported order/folder membership. */
    function applyPlacements(placements: FolderedItemPlacement[]) {
        saveUserPersona()
        const personas = DBState.db.personas
        const selectedId = ensureId(personas[DBState.db.selectedPersona])
        const next = placements.map(({ index, folderId }) => ({ ...personas[index], folderId }))
        if (next.length !== personas.length) return
        DBState.db.personas = next
        changeUserPersona(Math.max(0, next.findIndex(p => p.id === selectedId)), 'noSave')
        void requestImmediateSave()
    }

    function createPersona() {
        saveUserPersona()
        DBState.db.personas = [...DBState.db.personas, {
            id: v4(),
            name: 'New Persona',
            icon: '',
            personaPrompt: '',
            note: '',
        }]
        changeUserPersona(DBState.db.personas.length - 1, 'noSave')
        expanded = true
        void requestImmediateSave()
    }

    async function importPersona() {
        saveUserPersona()
        const before = DBState.db.personas.length
        await importUserPersona()
        if (DBState.db.personas.length > before) changeUserPersona(DBState.db.personas.length - 1, 'noSave')
        void requestImmediateSave()
    }

    function duplicatePersona(index: number) {
        saveUserPersona()
        const clone = $state.snapshot(DBState.db.personas[index])
        DBState.db.personas = [...DBState.db.personas, { ...clone, name: clone.name + ' (Copy)', id: v4() }]
        void requestImmediateSave()
    }

    async function exportPersona(index: number) {
        saveUserPersona()
        await exportUserPersona(index)
    }

    async function deletePersona(index: number) {
        const persona = DBState.db.personas[index]
        if (!persona || DBState.db.personas.length === 1) return
        if (!await alertConfirm(`${language.removeConfirm}${persona.name}`)) return
        saveUserPersona()
        const selected = DBState.db.personas[DBState.db.selectedPersona]
        const next = DBState.db.personas.filter((_, i) => i !== index)
        DBState.db.personas = next
        const selectedIndex = next.indexOf(selected)
        changeUserPersona(selectedIndex >= 0 ? selectedIndex : 0, 'noSave')
        // Don't pop open whichever persona became selected after the removal.
        if (selectedIndex < 0) expanded = false
        void requestImmediateSave()
    }

    onDestroy(() => {
        saveUserPersona()
    })
</script>

<SettingPage title={language.persona}>
    <FolderedList
        {folders}
        itemFolderIds={DBState.db.personas.map(p => p.folderId)}
        itemSearchTexts={DBState.db.personas.map(p => `${p.name ?? ''}\n${p.note ?? ''}`)}
        searchPlaceholder={language.personaSearch}
        selectedIndex={DBState.db.selectedPersona}
        isExpanded={(index) => expanded && index === DBState.db.selectedPersona}
        storageKey="risu-persona-folders-collapsed"
        onSelect={toggleRow}
        onItemsChange={applyPlacements}
        onFoldersChange={(next) => { DBState.db.personaFolders = next; void requestImmediateSave() }}
        onDuplicate={duplicatePersona}
        onExport={exportPersona}
        onDelete={deletePersona}
    >
        {#snippet actions()}
            <ShButton size="sm" onclick={createPersona}><PlusIcon />{language.createfromScratch}</ShButton>
            <ShButton size="sm" variant="outline" onclick={importPersona}><HardDriveUploadIcon />{language.import}</ShButton>
        {/snippet}
        {#snippet itemContent(index)}
            {@const persona = DBState.db.personas[index]}
            <div class="h-8 w-8 shrink-0 overflow-hidden rounded-md bg-textcolor2">
                {#if persona.icon}
                    {#await getCharImage(persona.icon, 'css') then im}
                        <div class="h-full w-full bg-cover bg-center" style={im}></div>
                    {/await}
                {/if}
            </div>
            <div class="min-w-0 grow truncate">
                <span>{persona.name}</span>
                {#if persona.note}<span class="text-textcolor2"> / {persona.note}</span>{/if}
            </div>
            <!-- Active persona marker (same convention as the memory preset default star). -->
            {#if index === DBState.db.selectedPersona}
                <StarIcon size={14} class="shrink-0 text-primary" />
            {/if}
        {/snippet}
        {#snippet itemPanel(index)}
            {@const persona = DBState.db.personas[index]}
            <div class="flex flex-wrap gap-4 bg-dark-900/50 p-3 rounded-md">
                <button class="shrink-0 self-start" onclick={() => {selectUserImg()}}>
                    {#if DBState.db.userIcon === ''}
                        <div class="rounded-md h-28 w-28 shadow-lg bg-textcolor2 cursor-pointer hover:text-primary"></div>
                    {:else}
                        {#await getCharImage(DBState.db.userIcon, persona.largePortrait ? 'lgcss' : 'css')}
                            <div class="rounded-md h-28 w-28 shadow-lg bg-textcolor2 cursor-pointer hover:text-primary"></div>
                        {:then im}
                            <div class="rounded-md h-28 w-28 shadow-lg bg-textcolor2 cursor-pointer hover:text-primary" style={im}></div>
                        {/await}
                    {/if}
                </button>
                <div class="flex grow flex-col min-w-0 basis-64">
                    <span class="text-sm text-textcolor2">{language.name} <Help key="personaName" /></span>
                    <TextInput className="mt-2" marginBottom placeholder="User" bind:value={DBState.db.username}/>
                    <span class="text-sm text-textcolor2">{language.note} <Help key="personaNote" /></span>
                    {#if DBState.db.personaNote}
                        <TextInput className="mt-2" marginBottom bind:value={DBState.db.userNote} placeholder={`Put a unique identifier for this persona here.\nExample: [Alternate Hunters persona]`} />
                    {/if}
                    <span class="text-sm text-textcolor2">{language.description} <Help key="personaDescription" /></span>
                    <TextAreaInput className="mt-2 mb-4" autocomplete="off" bind:value={DBState.db.personaPrompt} placeholder={`Put the description of this persona here.\nExample: [<user> is a 20 year old girl.]`} />
                    <div class="flex gap-2 max-w-full flex-wrap items-center">
                        <ShButton size="sm" variant="outline" onclick={() => exportPersona(index)}>{language.export}</ShButton>
                        <ShButton size="sm" variant="outline" onclick={() => {
                            duplicatePersona(index)
                            changeUserPersona(DBState.db.personas.length - 1, 'noSave')
                        }}>{language.personaDuplicate}</ShButton>
                        <ShButton size="sm" variant="destructive" onclick={() => deletePersona(index)}>{language.remove}</ShButton>
                        <Check bind:check={DBState.db.personas[DBState.db.selectedPersona].largePortrait} name={language.largePortrait}/>
                        <Help key="personaLargePortrait" />
                    </div>
                </div>
            </div>
        {/snippet}
    </FolderedList>
</SettingPage>

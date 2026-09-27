<script lang="ts">
    import { alertConfirm, notifyError } from "../../ts/alert";
    import { language } from "../../lang";
    import { changeToThemePreset, copyThemePreset, downloadThemePreset, importThemePreset, themePresetTemplate } from "../../ts/storage/database.svelte";
    import { DBState } from 'src/ts/stores.svelte';
    import { CopyIcon, Share2Icon, PencilIcon, HardDriveUploadIcon, PlusIcon, TrashIcon, XIcon } from "@lucide/svelte";
    import TextInput from "../UI/GUI/TextInput.svelte";
    import { updateColorScheme, updateTextThemeAndCSS } from "src/ts/gui/colorscheme";
    import { updateAnimationSpeed } from "src/ts/gui/animation";
    import { updateGuisize } from "src/ts/gui/guisize";
    import ShSortableList from "../UI/GUI/ShSortableList.svelte";
    import ShButton from "../UI/GUI/ShButton.svelte";

    let editMode = $state(false)

    interface Props {
        close?: any;
    }

    let { close = () => {} }: Props = $props();

    // SortableJS (via ShSortableList) reorders the DOM and hands back the
    // original indexes in their new order. It handles touch natively, unlike
    // the previous HTML5 drag, which needed a polyfill that never fired on iOS.
    function reorderPresets(orderedKeys: string[]) {
        const presets = DBState.db.themePresets
        const order = orderedKeys.map(Number).filter((i) => Number.isInteger(i) && i >= 0 && i < presets.length)
        if (order.length !== presets.length || new Set(order).size !== presets.length) return
        const selected = DBState.db.themePresetsId
        DBState.db.themePresets = order.map((i) => presets[i])
        const nextSelected = order.indexOf(selected)
        if (nextSelected !== -1) DBState.db.themePresetsId = nextSelected
    }

    function applyThemeVisuals() {
        updateColorScheme()
        updateTextThemeAndCSS()
        updateAnimationSpeed()
        updateGuisize()
    }

</script>

<div class="absolute w-full h-full z-40 bg-black/50 flex justify-center items-center">
    <div class="bg-darkbg p-4 break-any rounded-md flex flex-col max-w-3xl w-124 max-h-full overflow-y-auto">
        <div class="flex items-center justify-between text-textcolor mb-3">
            <h2 class="mt-0 mb-0 text-lg font-semibold">{language.themePresets}</h2>
            <ShButton variant="ghost" size="icon-sm" aria-label="Close" onclick={close}>
                <XIcon />
            </ShButton>
        </div>
        <ShSortableList className="flex flex-col" disabled={editMode} onReorder={reorderPresets}>
        {#each DBState.db.themePresets as preset, i (i)}
            <button onclick={() => {
                if(!editMode){
                    changeToThemePreset(i)
                    applyThemeVisuals()
                    close()
                }
            }}
            class="flex items-center text-textcolor border-t-1 border-solid border-0 border-darkborderc px-3 h-11 rounded-md cursor-pointer hover:bg-selected/30"
            class:bg-selected={i === DBState.db.themePresetsId}
            data-sortable-key={i}>
                {#if editMode}
                    <TextInput bind:value={DBState.db.themePresets[i].name} placeholder="string" padding={false}/>
                {:else}
                    <span>{preset.name}</span>
                {/if}
                <div class="grow flex justify-end no-sort">
                    <div class="text-textcolor2 hover:text-primary cursor-pointer mr-2" role="button" tabindex="0" onclick={(e) => {
                        e.stopPropagation()
                        copyThemePreset(i)
                    }} onkeydown={(e) => {
                        if(e.key === 'Enter' && e.currentTarget instanceof HTMLElement){
                            e.currentTarget.click()
                        }
                    }}>
                        <CopyIcon size={18}/>
                    </div>
                    <div class="text-textcolor2 hover:text-primary cursor-pointer mr-2" role="button" tabindex="0" onclick={async (e) => {
                        e.stopPropagation()
                        downloadThemePreset(i, 'json')
                    }} onkeydown={(e) => {
                        if(e.key === 'Enter' && e.currentTarget instanceof HTMLElement){
                            e.currentTarget.click()
                        }
                    }}>
                        <Share2Icon size={18} />
                    </div>
                    <div class="text-textcolor2 hover:text-red-400 cursor-pointer" role="button" tabindex="0" onclick={async (e) => {
                        e.stopPropagation()
                        if(DBState.db.themePresets.length === 1){
                            notifyError(language.errors.onlyOneChat)
                            return
                        }
                        const d = await alertConfirm(`${language.removeConfirm}${preset.name}`)
                        if(d){
                            changeToThemePreset(0)
                            applyThemeVisuals()
                            let themePresets = DBState.db.themePresets
                            themePresets.splice(i, 1)
                            DBState.db.themePresets = themePresets
                            changeToThemePreset(0, false)
                            applyThemeVisuals()
                        }
                    }} onkeydown={(e) => {
                        if(e.key === 'Enter' && e.currentTarget instanceof HTMLElement){
                            e.currentTarget.click()
                        }
                    }}>
                        <TrashIcon size={18}/>
                    </div>
                </div>
            </button>
        {/each}
        </ShSortableList>

        <div class="flex flex-wrap gap-2 mt-3 pt-3 border-t border-darkborderc">
            <ShButton variant="outline" size="sm" onclick={() => {
                let themePresets = DBState.db.themePresets
                let newPreset = safeStructuredClone(themePresetTemplate)
                newPreset.name = `New Theme`
                themePresets.push(newPreset)
                DBState.db.themePresets = themePresets
            }}>
                <PlusIcon />{language.settingActionAdd}
            </ShButton>
            <ShButton variant="outline" size="sm" onclick={() => {
                importThemePreset()
            }}>
                <HardDriveUploadIcon />{language.settingActionImport}
            </ShButton>
            <ShButton variant={editMode ? 'default' : 'ghost'} size="sm" className="ml-auto" onclick={() => {
                editMode = !editMode
            }}>
                <PencilIcon />{language.settingActionRename}
            </ShButton>
        </div>
    </div>
</div>

<style>
    .break-any{
        word-break: normal;
        overflow-wrap: anywhere;
    }
</style>

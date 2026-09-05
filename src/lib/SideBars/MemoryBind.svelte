<script lang="ts">
    import { DBState, selectedCharID, openMemoryPresetList, memoryPresetSelectCallback } from "src/ts/stores.svelte";
    import { language } from "src/lang";
    import { BrainIcon } from "@lucide/svelte";
    import { notifySuccess } from "src/ts/alert";
    import ShButton from "../UI/GUI/ShButton.svelte";
    import Help from "../Others/Help.svelte";
    import { MEMORY_PRESET_DEFAULT, MEMORY_PRESET_OFF, getMemoryBinding, getMemoryPreset, setChatMemoryPreset } from "src/ts/process/memory/memoryPresets";

    let char = $derived(DBState.db.characters[$selectedCharID])
    let chat = $derived(char?.chats?.[char?.chatPage])
    // Highlighted only when this chat picked something itself; chats on the
    // default (or legacy chats with no value) read as unbound, like the other bindings.
    let active = $derived(chat?.memoryPresetId !== undefined && chat.memoryPresetId !== MEMORY_PRESET_DEFAULT)
    let label = $derived.by(() => {
        const binding = getMemoryBinding(char, chat)
        const inherit = `${language.memoryPresetInherit} (${getMemoryPreset(DBState.db, DBState.db.memoryPresetId)?.name ?? language.memoryPresetOff})`
        if (binding === MEMORY_PRESET_OFF) return language.memoryPresetOff
        if (binding === MEMORY_PRESET_DEFAULT) return inherit
        // a binding to a deleted preset resolves to the default
        return getMemoryPreset(DBState.db, binding)?.name ?? inherit
    })

    function openPicker() {
        memoryPresetSelectCallback.set((value) => {
            const c = DBState.db.characters[$selectedCharID]
            const target = c?.chats?.[c.chatPage]
            if (!target) return
            setChatMemoryPreset(DBState.db, c, target, value)
            notifySuccess(language.memoryPresetBound)
        })
        openMemoryPresetList.set(true)
    }
</script>

<div class="text-[11px] text-textcolor2 mt-4 px-1 flex items-center gap-1">
    <span>{language.memoryBindingLabel}</span>
    <Help key="memoryPresetBinding" />
</div>
<div class="flex gap-1 mt-1 items-stretch">
    <ShButton
        className={`flex-1 min-w-0 justify-start ${active
            ? 'border-selected text-textcolor'
            : 'text-textcolor2 opacity-75 hover:opacity-100'}`}
        onclick={openPicker}
    >
        <BrainIcon size={16} class="shrink-0" />
        <span class="truncate">{label}</span>
    </ShButton>
</div>

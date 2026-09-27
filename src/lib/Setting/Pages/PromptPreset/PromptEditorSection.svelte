<script lang="ts">
    import SettingFieldLabel from "src/lib/Setting/Wrappers/SettingFieldLabel.svelte";
    import { language } from "src/lang";
    import { DBState } from "src/ts/stores.svelte";
    import TextAreaInput from "src/lib/UI/GUI/TextAreaInput.svelte";
    import ShSwitch from "src/lib/UI/GUI/ShSwitch.svelte";
    import DropList from "src/lib/SideBars/DropList.svelte";
    import PromptSettings from "../PromptSettings.svelte";
    import SettingRowLayout from "../../Wrappers/SettingRowLayout.svelte";
</script>


{#if !DBState.db.promptTemplate}
    <!-- Row-layout field grammar: full-width prompts, format order, preprocess switch. -->
    <div class="flex flex-col [&>*:first-child]:border-t-0">
        <div class="py-3 border-t border-darkborderc">
            <SettingFieldLabel label={language.mainPrompt} helpKey="mainprompt" />
            <TextAreaInput className="mt-2" fullwidth autocomplete="off" height={"32"} bind:value={DBState.db.mainPrompt}></TextAreaInput>
        </div>
        <div class="py-3 border-t border-darkborderc">
            <SettingFieldLabel label={language.jailbreakPrompt} helpKey="jailbreak" />
            <TextAreaInput className="mt-2" fullwidth autocomplete="off" height={"32"} bind:value={DBState.db.jailbreak}></TextAreaInput>
        </div>
        <div class="py-3 border-t border-darkborderc">
            <SettingFieldLabel label={language.globalNote} helpKey="globalNote" />
            <TextAreaInput className="mt-2" fullwidth autocomplete="off" height={"32"} bind:value={DBState.db.globalNote}></TextAreaInput>
        </div>
        <div class="py-3 border-t border-darkborderc flex flex-col">
            <SettingFieldLabel label={language.formatingOrder} helpKey="formatOrder" />
            <div class="mt-2 flex flex-col"><DropList bind:list={DBState.db.formatingOrder} /></div>
        </div>
        <SettingRowLayout item={{ id: 'promptPreset.promptPreprocess', type: 'custom', fallbackLabel: language.promptPreprocess, helpKey: 'promptPreprocess' }}>
            {#snippet control()}
                <ShSwitch checked={!!DBState.db.promptPreprocess} onCheckedChange={(v) => DBState.db.promptPreprocess = v} />
            {/snippet}
        </SettingRowLayout>
    </div>
{:else}
    <PromptSettings mode='inline' />
{/if}

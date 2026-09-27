<script lang="ts">
    import { language } from "src/lang";
    import { DBState } from "src/ts/stores.svelte";
    import ShSwitch from "src/lib/UI/GUI/ShSwitch.svelte";
    import PromptSettings from "../PromptSettings.svelte";
    import SettingRowLayout from "../../Wrappers/SettingRowLayout.svelte";
</script>

{#if DBState.db.promptTemplate}
    <PromptSettings mode='inline' subMenu={1} />
{:else}
    <div class="[&>*:first-child]:border-t-0">
        <SettingRowLayout item={{ id: 'promptPreset.usePromptTemplate', type: 'custom', fallbackLabel: language.usePromptTemplate, helpKey: 'usePromptTemplate' }}>
            {#snippet control()}
                <!-- One-way opt-in (as before): switching on creates an empty template. -->
                <ShSwitch checked={false} onCheckedChange={(v) => { if (v) DBState.db.promptTemplate = []; }} />
            {/snippet}
        </SettingRowLayout>
    </div>
{/if}

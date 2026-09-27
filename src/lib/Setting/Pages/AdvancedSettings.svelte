<script lang="ts">
    import {
        advancedPromptLorebookItems,
        advancedPromptTextItems,
        advancedPromptResponseItems,
        advancedPromptToolItems,
        advancedRequestItems,
        advancedAssetItems,
        advancedDevVisibilityItems,
        advancedDevToolItems,
        advancedExperimentalItems,
        advancedUnrecommendedItems,
    } from "src/ts/setting/advancedSettingsData";
    import SettingRenderer from "../SettingRenderer.svelte";
    import SettingPage from "src/lib/UI/GUI/SettingPage.svelte";
    import SettingTabs from "src/lib/UI/GUI/SettingTabs.svelte";
    import ShAlert from "src/lib/UI/GUI/ShAlert.svelte";
    import { TriangleAlertIcon } from "@lucide/svelte";
    import { language } from "src/lang";
    import { AdvancedSubmenuIndex, DBState } from "src/ts/stores.svelte";
</script>

<SettingPage title={language.advancedSettings}>
<ShAlert variant="warning" className="mb-4">
    {#snippet icon()}<TriangleAlertIcon />{/snippet}
    {language.advancedSettingsWarn}
</ShAlert>
<SettingTabs
    tabs={[
        { label: language.advTabPrompt, value: 0 },
        { label: language.advTabRequest, value: 1 },
        { label: language.advTabAssets, value: 2 },
        { label: language.advTabDev, value: 3 },
    ]}
    bind:selected={$AdvancedSubmenuIndex}
/>

{#if $AdvancedSubmenuIndex === 0}
    <h3 class="text-base font-bold mt-2 mb-1">{language.loreBook}</h3>
    <SettingRenderer items={advancedPromptLorebookItems} layout="row" />

    <h3 class="text-base font-bold mt-8 mb-1">{language.prompt}</h3>
    <SettingRenderer items={advancedPromptTextItems} layout="row" />

    <h3 class="text-base font-bold mt-8 mb-1">{language.advSectionResponse}</h3>
    <SettingRenderer items={advancedPromptResponseItems} layout="row" />

    <h3 class="text-base font-bold mt-8 mb-1">{language.tools}</h3>
    <SettingRenderer items={advancedPromptToolItems} layout="row" />
{:else if $AdvancedSubmenuIndex === 1}
    <SettingRenderer items={advancedRequestItems} layout="row" />
{:else if $AdvancedSubmenuIndex === 2}
    <SettingRenderer items={advancedAssetItems} layout="row" />
{:else if $AdvancedSubmenuIndex === 3}
    <SettingRenderer items={advancedDevVisibilityItems} layout="row" />

    <h3 class="text-base font-bold mt-8 mb-1">{language.advSectionDevTools}</h3>
    <SettingRenderer items={advancedDevToolItems} layout="row" />

    <h3 class="text-base font-bold mt-8 mb-1">{language.advSectionExperimental}</h3>
    <SettingRenderer items={advancedExperimentalItems} layout="row" />

    {#if DBState.db.showUnrecommended}
        <h3 class="text-base font-bold mt-8 mb-1">{language.unrecommended}</h3>
        <SettingRenderer items={advancedUnrecommendedItems} layout="row" />
    {/if}
{/if}
</SettingPage>

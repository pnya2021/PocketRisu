<script lang="ts">
    import SettingFieldLabel from "src/lib/Setting/Wrappers/SettingFieldLabel.svelte";

    import SettingPage from "src/lib/UI/GUI/SettingPage.svelte";
    import SettingTabs from "src/lib/UI/GUI/SettingTabs.svelte";
    import { language } from "src/lang";
    import Help from "src/lib/Others/Help.svelte";
    
    import { DBState, BotSubmenuIndex } from 'src/ts/stores.svelte';
    import { customProviderStore } from "src/ts/plugins/plugins.svelte";
    import { tokenizerList } from "src/ts/tokenizer";
    import ModelList from "src/lib/UI/ModelList.svelte";
    import { PlusIcon, TrashIcon, TriangleAlertIcon, InfoIcon, ArrowRightIcon, DownloadIcon, HardDriveUploadIcon } from "@lucide/svelte";
    import ShAlert from "src/lib/UI/GUI/ShAlert.svelte";
    import ShButton from "src/lib/UI/GUI/ShButton.svelte";
    import { openSettings, SettingsRoute } from "src/ts/routing";
    import TextInput from "src/lib/UI/GUI/TextInput.svelte";
    import NumberInput from "src/lib/UI/GUI/NumberInput.svelte";
    import ShSlider from "src/lib/UI/GUI/ShSlider.svelte";
    import ShSwitch from "src/lib/UI/GUI/ShSwitch.svelte";
    import ShToggle from "src/lib/UI/GUI/ShToggle.svelte";
    import ShAccordion from "src/lib/UI/GUI/ShAccordion.svelte";
    import SettingRowLayout from "src/lib/Setting/Wrappers/SettingRowLayout.svelte";
    import type { SettingItem } from "src/ts/setting/types";
    import TextAreaInput from "src/lib/UI/GUI/TextAreaInput.svelte";
    import SelectInput from "src/lib/UI/GUI/SelectInput.svelte";
    import OptionInput from "src/lib/UI/GUI/OptionInput.svelte";
    import SegmentedControl from "src/lib/UI/GUI/SegmentedControl.svelte";
    import { getOpenRouterModels, toModelGridItem as orToGridItem } from "src/ts/model/openrouter";
    import { getNanoGPTModels, getNanoGPTSubscriptionModels, toModelGridItem as ngToGridItem } from "src/ts/model/nanogpt";
    import ModelGrid from "src/lib/UI/ModelGrid.svelte";
    import NanoGPTDashboard from "src/lib/UI/NanoGPTDashboard.svelte";
    import NanoGPTProviderPicker from "src/lib/UI/NanoGPTProviderPicker.svelte";
    import type { ModelGridPinnedItem } from "src/ts/model/modelGrid";
    import OobaSettings from "./OobaSettings.svelte";
    import OpenrouterSettings from "./OpenrouterSettings.svelte";
    import ChatFormatSettings from "./ChatFormatSettings.svelte";
    import { getModelInfo, LLMFlags, LLMFormat, LLMProvider } from "src/ts/model/modellist";
    import SettingRenderer from "../SettingRenderer.svelte";
    import { allBasicParameterItems } from "src/ts/setting/botSettingsParamsData";
    import SeparateParametersSection from "./SeparateParametersSection.svelte";
    import AuxModelSelectors from './Model/AuxModelSelectors.svelte'
    import CustomModelsSettings from './Model/CustomModelsSettings.svelte'
    import { downloadFile } from "src/ts/globalApi.svelte";
    import { selectSingleFile } from "src/ts/util";
    import { alertError } from "src/ts/alert";

    // Generation reads each entry as [token string, finite weight].
    function isBiasList(value: unknown): value is [string, number][] {
        return Array.isArray(value) && value.every((entry) =>
            Array.isArray(entry) && entry.length === 2
            && typeof entry[0] === 'string'
            && typeof entry[1] === 'number' && Number.isFinite(entry[1]))
    }
    
    const openrouterPinnedItems: ModelGridPinnedItem[] = [
        { id: 'risu/free',       displayName: 'Free Auto',       providerName: 'Risu'       },
        { id: 'openrouter/auto', displayName: 'OpenRouter Auto', providerName: 'OpenRouter' },
    ]

    // Reset model selection and display name when subscription mode toggles
    let _nanogptSubModeInitialized = false
    $effect(() => {
        const _sub = DBState.db.nanogptUseSubscriptionEndpoint
        if (!_nanogptSubModeInitialized) { _nanogptSubModeInitialized = true; return }
        DBState.db.nanogptRequestModel = ''
        DBState.db.nanogptRequestModelName = ''
    })

    // Reset provider selection to Auto when the model or subscription mode changes
    let _nanogptProviderResetInitialized = false
    $effect(() => {
        const _model = DBState.db.nanogptRequestModel
        const _sub   = DBState.db.nanogptUseSubscriptionEndpoint
        if (!_nanogptProviderResetInitialized) { _nanogptProviderResetInitialized = true; return }
        DBState.db.nanogptProvider = ''
    })

    // Reset subscription mode (and related state) when API key is cleared
    let _nanogptKeyInitialized = false
    $effect(() => {
        const _key = DBState.db.nanogptKey
        if (!_nanogptKeyInitialized) { _nanogptKeyInitialized = true; return }
        if (!_key) {
            DBState.db.nanogptUseSubscriptionEndpoint = false
            DBState.db.nanogptSubscriptionState = ''
            DBState.db.nanogptRequestModel = ''
            DBState.db.nanogptRequestModelName = ''
            DBState.db.nanogptProvider = ''
        }
    })


    $effect.pre(() => {
        if(DBState.db.aiModel === 'textgen_webui' || DBState.db.subModel === 'mancer'){
            DBState.db.useStreaming = DBState.db.textgenWebUIStreamURL.startsWith("wss://")
        }
    });

    function clearVertexToken() {
        DBState.db.vertexAccessToken = '';
        DBState.db.vertexAccessTokenExpires = 0;
        console.log('Vertex AI token cleared');
    }

    let modelInfo = $derived(getModelInfo(DBState.db.aiModel))
    let subModelInfo = $derived(getModelInfo(DBState.db.subModel))
    let nanogptInputMode = $state<'list' | 'manual'>(DBState.db.nanogptRequestModel && !DBState.db.nanogptRequestModelName ? 'manual' : 'list')
    // svelte-ignore state_referenced_locally
    let prevNanogptInputMode = nanogptInputMode;
    $effect(() => {
        if (nanogptInputMode !== prevNanogptInputMode) {
            DBState.db.nanogptRequestModel = '';
            DBState.db.nanogptRequestModelName = '';
            prevNanogptInputMode = nanogptInputMode;
        }
    });

    // Row-layout field descriptor for SettingRowLayout (label + inline help).
    function f(id: string, label: string, helpKey?: string): SettingItem {
        return { id: `bot.${id}`, type: 'custom', fallbackLabel: label, helpKey }
    }
</script>

<SettingPage title={language.chatBot}>
<ShAlert variant="info" className="mb-4">
    {#snippet icon()}<InfoIcon />{/snippet}
    {language.botSettingsPresetMovedDesc}
    {#snippet action()}
        <ShButton variant="outline" size="sm" onclick={() => openSettings(SettingsRoute.PromptPreset)}>
            {language.promptPresetMenu}
            <ArrowRightIcon size={14} />
        </ShButton>
    {/snippet}
</ShAlert>
<SettingTabs tabs={[
    { label: language.model, value: 0 },
    { label: language.parameters, value: 1 },
    { label: language.customModels, value: 2 },
]} bind:selected={$BotSubmenuIndex} />

{#if $BotSubmenuIndex === 0}
    <ShAlert variant="warning" className="mt-4">
        {#snippet icon()}<TriangleAlertIcon />{/snippet}
        {#snippet title()}{language.botSettingsLegacyTitle}{/snippet}
        {language.botSettingsLegacyDesc}
        {#snippet action()}
            <ShButton variant="outline" size="sm" onclick={() => openSettings(SettingsRoute.ModelPreset)}>
                {language.modelPresetMenu}
                <ArrowRightIcon size={14} />
            </ShButton>
        {/snippet}
    </ShAlert>
<div class="py-3 border-t border-darkborderc flex flex-col gap-2">
        <SettingFieldLabel label={language.model} helpKey="model" />
    <ModelList bind:value={DBState.db.aiModel}/>
    </div>

<div class="py-3 border-t border-darkborderc flex flex-col gap-2">
        <SettingFieldLabel label={language.submodel} helpKey="submodel" />
    <ModelList bind:value={DBState.db.subModel}/>
    </div>

    {#if modelInfo.provider === LLMProvider.GoogleCloud || subModelInfo.provider === LLMProvider.GoogleCloud}
        <SettingRowLayout item={f('bot2', `GoogleAI API Key`, 'googleAIKey')} wideControl>
    {#snippet control()}<TextInput className="sm:w-64 h-8" size="sm" padding fullwidth placeholder="..." hideText={DBState.db.hideApiKey} bind:value={DBState.db.google.accessToken}/>{/snippet}
</SettingRowLayout>
    {/if}
    {#if modelInfo.provider === LLMProvider.VertexAI || subModelInfo.provider === LLMProvider.VertexAI}
        <SettingRowLayout item={f('bot3', `Project ID`, 'vertexProjectId')} wideControl>
    {#snippet control()}<TextInput className="sm:w-64 h-8" size="sm" padding fullwidth placeholder="..." bind:value={DBState.db.google.projectId} oninput={clearVertexToken}/>{/snippet}
</SettingRowLayout>
        <SettingRowLayout item={f('bot4', `Vertex Client Email`, 'vertexClientEmail')} wideControl>
    {#snippet control()}<TextInput className="sm:w-64 h-8" size="sm" padding fullwidth placeholder="..." bind:value={DBState.db.vertexClientEmail} oninput={clearVertexToken}/>{/snippet}
</SettingRowLayout>
        <SettingRowLayout item={f('bot5', `Vertex Private Key`, 'vertexPrivateKey')} wideControl>
    {#snippet control()}<TextInput className="sm:w-64 h-8" size="sm" padding fullwidth placeholder="..." hideText={DBState.db.hideApiKey} bind:value={DBState.db.vertexPrivateKey} oninput={clearVertexToken}/>{/snippet}
</SettingRowLayout>
        <SettingRowLayout item={f('bot29', `Region`, 'vertexRegion')}>
    {#snippet control()}
    <SelectInput className="w-48" size="sm" value={DBState.db.vertexRegion} onchange={(e) => {
            DBState.db.vertexRegion = e.currentTarget.value
            clearVertexToken()
        }}>
            <OptionInput value={'global'}>
                global
            </OptionInput>
            <OptionInput value={'us-central1'}>
                us-central1
            </OptionInput>
            <OptionInput value={'us-west1'}>
                us-west1
            </OptionInput>
        </SelectInput>
    {/snippet}
</SettingRowLayout>    
    {/if}
    {#if modelInfo.provider === LLMProvider.NovelList || subModelInfo.provider === LLMProvider.NovelList}
        <SettingRowLayout item={f('bot6', `NovelList ${language.apiKey}`, 'novellistKey')} wideControl>
    {#snippet control()}<TextInput className="sm:w-64 h-8" size="sm" padding fullwidth hideText={DBState.db.hideApiKey} placeholder="..." bind:value={DBState.db.novellistAPI}/>{/snippet}
</SettingRowLayout>
    {/if}
    {#if DBState.db.aiModel.startsWith('mancer') || DBState.db.subModel.startsWith('mancer')}
        <SettingRowLayout item={f('bot7', `Mancer ${language.apiKey}`, 'mancerKey')} wideControl>
    {#snippet control()}<TextInput className="sm:w-64 h-8" size="sm" padding fullwidth hideText={DBState.db.hideApiKey} placeholder="..." bind:value={DBState.db.mancerHeader}/>{/snippet}
</SettingRowLayout>
    {/if}
    {#if modelInfo.provider === LLMProvider.Anthropic || subModelInfo.provider === LLMProvider.Anthropic
            || modelInfo.provider === LLMProvider.AWS || subModelInfo.provider === LLMProvider.AWS }
        <SettingRowLayout item={f('bot8', `Claude ${language.apiKey}`, 'claudeApiKey')} wideControl>
    {#snippet control()}<TextInput className="sm:w-64 h-8" size="sm" padding fullwidth hideText={DBState.db.hideApiKey} placeholder="..." bind:value={DBState.db.claudeAPIKey}/>{/snippet}
</SettingRowLayout>
    {/if}
    {#if modelInfo.provider === LLMProvider.Mistral || subModelInfo.provider === LLMProvider.Mistral}
        <SettingRowLayout item={f('bot9', `Mistral ${language.apiKey}`, 'mistralKey')} wideControl>
    {#snippet control()}<TextInput className="sm:w-64 h-8" size="sm" padding fullwidth hideText={DBState.db.hideApiKey} placeholder="..." bind:value={DBState.db.mistralKey}/>{/snippet}
</SettingRowLayout>
    {/if}
    {#if modelInfo.provider === LLMProvider.NovelAI || subModelInfo.provider === LLMProvider.NovelAI}
        <SettingRowLayout item={f('bot10', `NovelAI Bearer Token`, 'novelaiToken')} wideControl>
    {#snippet control()}<TextInput className="sm:w-64 h-8" size="sm" padding fullwidth bind:value={DBState.db.novelai.token}/>{/snippet}
</SettingRowLayout>
    {/if}
    {#if DBState.db.aiModel === 'reverse_proxy' || DBState.db.subModel === 'reverse_proxy'}
        <SettingRowLayout item={f('bot11', `URL`, 'forceUrl')} wideControl>
    {#snippet control()}<TextInput className="sm:w-64 h-8" size="sm" padding fullwidth bind:value={DBState.db.forceReplaceUrl} placeholder="https//..."/>{/snippet}
</SettingRowLayout>
        <SettingRowLayout item={f('bot12', `${language.proxyAPIKey}`, 'proxyAPIKey')} wideControl>
    {#snippet control()}<TextInput className="sm:w-64 h-8" size="sm" padding fullwidth hideText={DBState.db.hideApiKey} placeholder="leave it blank if it hasn't password" bind:value={DBState.db.proxyKey}/>{/snippet}
</SettingRowLayout>
        <SettingRowLayout item={f('bot13', `${language.proxyRequestModel}`, 'proxyRequestModel')} wideControl>
    {#snippet control()}<TextInput className="sm:w-64 h-8" size="sm" padding fullwidth bind:value={DBState.db.customProxyRequestModel} placeholder="Name"/>{/snippet}
</SettingRowLayout>
        <SettingRowLayout item={f('bot30', `${language.format}`, 'proxyFormat')}>
    {#snippet control()}
    <SelectInput className="w-48" size="sm" value={DBState.db.customAPIFormat.toString()} onchange={(e) => {
            DBState.db.customAPIFormat = parseInt(e.currentTarget.value) as LLMFormat
        }}>
            <OptionInput value={LLMFormat.OpenAICompatible.toString()}>
                OpenAI Compatible
            </OptionInput>
            <OptionInput value={LLMFormat.OpenAIResponseAPI.toString()}>
                OpenAI Response API
            </OptionInput>
            <OptionInput value={LLMFormat.Anthropic.toString()}>
                Anthropic Claude
            </OptionInput>
            <OptionInput value={LLMFormat.Mistral.toString()}>
                Mistral
            </OptionInput>
            <OptionInput value={LLMFormat.GoogleCloud.toString()}>
                Google Cloud
            </OptionInput>
            <OptionInput value={LLMFormat.Cohere.toString()}>
                Cohere
            </OptionInput>
        </SelectInput>
    {/snippet}
</SettingRowLayout>
    {/if}
    {#if modelInfo.provider === LLMProvider.Cohere || subModelInfo.provider === LLMProvider.Cohere}
        <SettingRowLayout item={f('bot14', `Cohere ${language.apiKey}`, 'cohereKey')} wideControl>
    {#snippet control()}<TextInput className="sm:w-64 h-8" size="sm" padding fullwidth hideText={DBState.db.hideApiKey} bind:value={DBState.db.cohereAPIKey}/>{/snippet}
</SettingRowLayout>
    {/if}
    {#if DBState.db.aiModel === 'ollama-hosted'}
        <SettingRowLayout item={f('bot15', `Ollama URL`, 'ollamaURL')} wideControl>
    {#snippet control()}<TextInput className="sm:w-64 h-8" size="sm" padding fullwidth bind:value={DBState.db.ollamaURL}/>{/snippet}
</SettingRowLayout>

        <SettingRowLayout item={f('bot16', `Ollama Model`, 'ollamaModel')} wideControl>
    {#snippet control()}<TextInput className="sm:w-64 h-8" size="sm" padding fullwidth bind:value={DBState.db.ollamaModel}/>{/snippet}
</SettingRowLayout>
    {/if}
    {#if DBState.db.aiModel === 'nanogpt' || DBState.db.subModel === 'nanogpt'}
        <SettingRowLayout item={f('bot17', `NanoGPT ${language.apiKey}`, 'nanogptKey')} wideControl>
    {#snippet control()}<TextInput className="sm:w-64 h-8" size="sm" padding fullwidth hideText={DBState.db.hideApiKey} bind:value={DBState.db.nanogptKey}/>{/snippet}
</SettingRowLayout>

        <NanoGPTDashboard apiKey={DBState.db.nanogptKey} />

        {#if DBState.db.nanogptSubscriptionState === 'active' || DBState.db.nanogptSubscriptionState === 'grace'}
            <SettingRowLayout item={f('bot33', `${language.nanoGPTUseSubscriptionEndpoint}`, 'nanoGPTUseSubscriptionEndpoint')}>
    {#snippet control()}<ShSwitch checked={!!DBState.db.nanogptUseSubscriptionEndpoint} onCheckedChange={(v) => DBState.db.nanogptUseSubscriptionEndpoint = v} />{/snippet}
</SettingRowLayout>
        {/if}

        <div class="pt-3 border-t border-darkborderc flex flex-col mb-2"><SettingFieldLabel label={`NanoGPT ${language.model}`} helpKey="nanogptModelMode" /></div>
        <SegmentedControl
            bind:value={nanogptInputMode}
            options={[
                { value: 'list', label: (language as any).nanoGPTSelectFromList || 'Select from List' },
                { value: 'manual', label: (language as any).nanoGPTManualInput || 'Manual Input' }
            ]}
            size="md"
        />

        {#if nanogptInputMode === 'manual'}
            <TextInput className="mt-2" marginBottom={false} bind:value={DBState.db.nanogptRequestModel} placeholder={(language as any).nanoGPTManualModelSelect || "Manual Model Select"} oninput={() => DBState.db.nanogptRequestModelName = ''}/>
        {:else}
            {#await Promise.all([getNanoGPTModels(), getNanoGPTSubscriptionModels(DBState.db.nanogptKey)])}
                <ModelGrid bind:value={DBState.db.nanogptRequestModel} loading={true} />
            {:then [regular, sub]}
                <ModelGrid
                    bind:value={DBState.db.nanogptRequestModel}
                    items={DBState.db.nanogptUseSubscriptionEndpoint ? (sub ?? []).map(ngToGridItem) : (regular ?? []).map(ngToGridItem)}
                    showSubBadge={DBState.db.nanogptUseSubscriptionEndpoint}
                    selectedLabelOverride={DBState.db.nanogptRequestModel && !DBState.db.nanogptRequestModelName ? DBState.db.nanogptRequestModel : undefined}
                    onselect={(_id, name) => { DBState.db.nanogptRequestModelName = name }}
                />
                {#if !DBState.db.nanogptUseSubscriptionEndpoint}
                    <NanoGPTProviderPicker
                        apiKey={DBState.db.nanogptKey}
                        modelId={DBState.db.nanogptRequestModel}
                        bind:value={DBState.db.nanogptProvider}
                    />
                {/if}
            {/await}
        {/if}
    {/if}
    {#if DBState.db.aiModel === 'openrouter' || DBState.db.subModel === 'openrouter'}
        <SettingRowLayout item={f('bot18', `OpenRouter ${language.apiKey}`, 'openrouterKey')} wideControl>
    {#snippet control()}<TextInput className="sm:w-64 h-8" size="sm" padding fullwidth hideText={DBState.db.hideApiKey} bind:value={DBState.db.openrouterKey}/>{/snippet}
</SettingRowLayout>

        <div class="pt-3 border-t border-darkborderc flex flex-col mb-2"><SettingFieldLabel label={`OpenRouter ${language.model}`} helpKey="openrouterModel" /></div>
        {#await getOpenRouterModels()}
            <ModelGrid bind:value={DBState.db.openrouterRequestModel} pinnedItems={openrouterPinnedItems} loading={true} />
        {:then m}
            <ModelGrid bind:value={DBState.db.openrouterRequestModel} items={(m ?? []).map(orToGridItem)} pinnedItems={openrouterPinnedItems} />
        {/await}
    {/if}
    {#if DBState.db.aiModel === 'openrouter' || DBState.db.aiModel === 'reverse_proxy'}
        <SettingRowLayout item={f('bot31', `${language.tokenizer}`, 'tokenizer')}>
    {#snippet control()}
    <SelectInput className="w-48" size="sm" bind:value={DBState.db.customTokenizer}>
            {#each tokenizerList as entry}
                <OptionInput value={entry[0]}>{entry[1]}</OptionInput>
            {/each}
        </SelectInput>
    {/snippet}
</SettingRowLayout>
    {/if}
    {#if modelInfo.provider === LLMProvider.OpenAI || subModelInfo.provider === LLMProvider.OpenAI}
        <SettingRowLayout item={f('bot19', `OpenAI ${language.apiKey}`, 'oaiapikey')} wideControl>
    {#snippet control()}<TextInput className="sm:w-64 h-8" size="sm" padding fullwidth hideText={DBState.db.hideApiKey} bind:value={DBState.db.openAIKey} placeholder="sk-XXXXXXXXXXXXXXXXXXXX"/>{/snippet}
</SettingRowLayout>
    {/if}

    {#if modelInfo.keyIdentifier}
        <SettingRowLayout item={f('bot20', `${modelInfo.name} ${language.apiKey}`)} wideControl>
    {#snippet control()}<TextInput className="sm:w-64 h-8" size="sm" padding fullwidth hideText={DBState.db.hideApiKey} bind:value={DBState.db.OaiCompAPIKeys[modelInfo.keyIdentifier]} placeholder="..."/>{/snippet}
</SettingRowLayout>
    {/if}

    {#if subModelInfo.keyIdentifier && subModelInfo.keyIdentifier !== modelInfo.keyIdentifier}
        <SettingRowLayout item={f('bot21', `${subModelInfo.name} ${language.apiKey}`)} wideControl>
    {#snippet control()}<TextInput className="sm:w-64 h-8" size="sm" padding fullwidth hideText={DBState.db.hideApiKey} bind:value={DBState.db.OaiCompAPIKeys[subModelInfo.keyIdentifier]} placeholder="..."/>{/snippet}
</SettingRowLayout>
    {/if}

    <div class="flex flex-col">
        {#if modelInfo.flags.includes(LLMFlags.hasStreaming) || subModelInfo.flags.includes(LLMFlags.hasStreaming)}
            <SettingRowLayout item={f('bot34', `Response ${language.streaming}`, 'streaming')}>
    {#snippet control()}<ShSwitch checked={!!DBState.db.useStreaming} onCheckedChange={(v) => DBState.db.useStreaming = v} />{/snippet}
</SettingRowLayout>

            {#if DBState.db.useStreaming && (modelInfo.flags.includes(LLMFlags.geminiThinking) || subModelInfo.flags.includes(LLMFlags.geminiThinking))}
                <SettingRowLayout item={f('bot35', `Stream Gemini Thoughts`, 'streamGeminiThoughts')}>
    {#snippet control()}<ShSwitch checked={!!DBState.db.streamGeminiThoughts} onCheckedChange={(v) => DBState.db.streamGeminiThoughts = v} />{/snippet}
</SettingRowLayout>
            {/if}
        {/if}

        {#if DBState.db.aiModel === 'reverse_proxy' || DBState.db.subModel === 'reverse_proxy'}
            <SettingRowLayout item={f('bot36', `${language.reverseProxyOobaMode}`, 'reverseProxyOobaMode')}>
    {#snippet control()}<ShSwitch checked={!!DBState.db.reverseProxyOobaMode} onCheckedChange={(v) => DBState.db.reverseProxyOobaMode = v} />{/snippet}
</SettingRowLayout>
        {/if}
        {#if modelInfo.provider === LLMProvider.NovelAI || subModelInfo.provider === LLMProvider.NovelAI}
            <SettingRowLayout item={f('bot37', `${language.textAdventureNAI}`, 'textAdventureNAI')}>
    {#snippet control()}<ShSwitch checked={!!DBState.db.NAIadventure} onCheckedChange={(v) => DBState.db.NAIadventure = v} />{/snippet}
</SettingRowLayout>

            <SettingRowLayout item={f('bot38', `${language.appendNameNAI}`, 'appendNameNAI')}>
    {#snippet control()}<ShSwitch checked={!!DBState.db.NAIappendName} onCheckedChange={(v) => DBState.db.NAIappendName = v} />{/snippet}
</SettingRowLayout>
        {/if}
    </div>

    {#if DBState.db.aiModel === 'custom' || DBState.db.subModel === 'custom'}
        <SettingRowLayout item={f('bot32', `${language.plugin}`, 'customPlugin')}>
    {#snippet control()}
    <SelectInput className="w-48" size="sm" bind:value={DBState.db.currentPluginProvider}>
            <OptionInput value="">None</OptionInput>
            {#each $customProviderStore as plugin}
                <OptionInput value={plugin}>{plugin}</OptionInput>
            {/each}
        </SelectInput>
    {/snippet}
</SettingRowLayout>
    {/if}

    {#if DBState.db.aiModel === "kobold" || DBState.db.subModel === "kobold"}
        <SettingRowLayout item={f('bot22', `Kobold URL`, 'koboldURL')} wideControl>
    {#snippet control()}<TextInput className="sm:w-64 h-8" size="sm" padding fullwidth bind:value={DBState.db.koboldURL}/>{/snippet}
</SettingRowLayout>
    {/if}

    {#if DBState.db.aiModel === 'echo_model' || DBState.db.subModel === 'echo_model'}
        <div class="py-3 border-t border-darkborderc flex flex-col">
    <SettingFieldLabel label={`Echo Message`} helpKey="echoMessage" />
    <TextAreaInput className="mt-2" bind:value={DBState.db.echoMessage} placeholder={"The message you want to receive as the bot's response\n(e.g., Lumi tilts her head, her white hair sliding down as her pretty green and aqua eyes sparkle…)"}/>
</div>
        <SettingRowLayout item={f('bot1', `Echo Delay (Seconds)`, 'echoDelay')}>
    {#snippet control()}<NumberInput className="w-24" size="sm" padding bind:value={DBState.db.echoDelay} min={0}/>{/snippet}
</SettingRowLayout>
    {/if}

    {#if DBState.db.aiModel.startsWith("horde") || DBState.db.subModel.startsWith("horde") }
        <SettingRowLayout item={f('bot23', `Horde ${language.apiKey}`, 'hordeKey')} wideControl>
    {#snippet control()}<TextInput className="sm:w-64 h-8" size="sm" padding fullwidth hideText={DBState.db.hideApiKey} bind:value={DBState.db.hordeConfig.apiKey}/>{/snippet}
</SettingRowLayout>
    {/if}
    {#if DBState.db.aiModel === 'textgen_webui' || DBState.db.subModel === 'textgen_webui'
        || DBState.db.aiModel === 'mancer' || DBState.db.subModel === 'mancer'}
        <SettingRowLayout item={f('bot24', `Blocking ${language.providerURL}`, 'textgenBlockingURL')} wideControl>
    {#snippet control()}<TextInput className="sm:w-64 h-8" size="sm" padding fullwidth bind:value={DBState.db.textgenWebUIBlockingURL} placeholder="https://..."/>{/snippet}
</SettingRowLayout>
        <ShAlert variant="warning" className="my-2">{#snippet icon()}<TriangleAlertIcon />{/snippet}You must use textgen webui with --public-api</ShAlert>
        <SettingRowLayout item={f('bot25', `Stream ${language.providerURL}`, 'textgenStreamURL')} wideControl>
    {#snippet control()}<TextInput className="sm:w-64 h-8" size="sm" padding fullwidth bind:value={DBState.db.textgenWebUIStreamURL} placeholder="wss://..."/>{/snippet}
</SettingRowLayout>
        <ShAlert variant="warning" className="my-2">{#snippet icon()}<TriangleAlertIcon />{/snippet}Warning: For Ooba version over 1.7, use "Ooba" as model, and use url like http://127.0.0.1:5000/v1/chat/completions</ShAlert>
    {/if}
    {#if DBState.db.aiModel === 'ooba' || DBState.db.subModel === 'ooba'}
        <SettingRowLayout item={f('bot26', `Ooba ${language.providerURL}`, 'oogaboogaURL')} wideControl>
    {#snippet control()}<TextInput className="sm:w-64 h-8" size="sm" padding fullwidth bind:value={DBState.db.textgenWebUIBlockingURL} placeholder="https://..."/>{/snippet}
</SettingRowLayout>
    {/if}
    {#if DBState.db.aiModel.startsWith("horde") || DBState.db.aiModel === 'kobold' }
        <ChatFormatSettings />
    {/if}

    <AuxModelSelectors />

    {#snippet CustomFlagButton(name:string,flag:LLMFlags)}
        <ShToggle size="sm" pressed={DBState.db.customFlags.includes(flag as LLMFlags)} onPressedChange={() => {
            if(DBState.db.customFlags.includes(flag as LLMFlags)){
                DBState.db.customFlags = DBState.db.customFlags.filter((f) => f !== flag)
            }
            else{
                DBState.db.customFlags.push(flag as LLMFlags)
            }
        }}>
            {name}
        </ShToggle>
    {/snippet}

    <ShAlert variant="warning" className="mt-4">
        {#snippet icon()}<TriangleAlertIcon />{/snippet}
        {language.botSettingsCustomFlagsScopeDesc}
    </ShAlert>

    <div class="pt-2">
    <ShAccordion name={language.customFlags} variant="card" bodyClass="[&>*:first-child]:border-t-0">
        {#snippet extras()}<Help key="customFlags"/>{/snippet}
        <SettingRowLayout item={f('bot39', `${language.enableCustomFlags}`, 'enableCustomFlags')}>
    {#snippet control()}<ShSwitch checked={!!DBState.db.enableCustomFlags} onCheckedChange={(v) => DBState.db.enableCustomFlags = v} />{/snippet}
</SettingRowLayout>

        {#if DBState.db.enableCustomFlags}
            <div class="flex flex-wrap gap-1.5 py-2">
            {@render CustomFlagButton('hasImageInput', 0)}
            {@render CustomFlagButton('hasImageOutput', 1)}
            {@render CustomFlagButton('hasAudioInput', 2)}
            {@render CustomFlagButton('hasAudioOutput', 3)}
            {@render CustomFlagButton('hasPrefill', 4)}
            {@render CustomFlagButton('hasCache', 5)}
            {@render CustomFlagButton('hasFullSystemPrompt', 6)}
            {@render CustomFlagButton('hasFirstSystemPrompt', 7)}
            {@render CustomFlagButton('hasStreaming', 8)}
            {@render CustomFlagButton('requiresAlternateRole', 9)}
            {@render CustomFlagButton('mustStartWithUserInput', 10)}
            {@render CustomFlagButton('hasVideoInput', 12)}
            {@render CustomFlagButton('OAICompletionTokens', 13)}
            {@render CustomFlagButton('DeveloperRole', 14)}
            {@render CustomFlagButton('geminiThinking', 15)}
            {@render CustomFlagButton('geminiBlockOff', 16)}
            {@render CustomFlagButton('deepSeekPrefix', 17)}
            {@render CustomFlagButton('deepSeekThinkingInput', 18)}
            {@render CustomFlagButton('deepSeekThinkingOutput', 19)}
            {@render CustomFlagButton('noCivilIntegrity', 20)}
            {@render CustomFlagButton('claudeThinking', 21)}
            {@render CustomFlagButton('claudeAdaptiveThinking', 22)}
            </div>
        {/if}
    </ShAccordion>
    </div>
{/if}

{#if $BotSubmenuIndex === 1}
    <ShAlert variant="warning" className="mt-4 mb-2">
        {#snippet icon()}<TriangleAlertIcon />{/snippet}
        {language.botSettingsParamScopeDesc}
        {#snippet action()}
            <ShButton variant="outline" size="sm" onclick={() => openSettings(SettingsRoute.ModelPreset)}>
                {language.modelPresetMenu}
                <ArrowRightIcon size={14} />
            </ShButton>
        {/snippet}
    </ShAlert>
    <!-- Data-driven basic parameters -->
    <SettingRenderer items={allBasicParameterItems} {modelInfo} {subModelInfo} layout="block" />
    {#if DBState.db.aiModel === 'textgen_webui' || DBState.db.aiModel === 'mancer' || DBState.db.aiModel.startsWith('local_') || DBState.db.aiModel.startsWith('hf:::')}
        <div class="py-3 border-t border-darkborderc flex flex-col">
    <SettingFieldLabel label={`Repetition Penalty`} />
    <ShSlider className="mt-2" inputWidth="w-16" min={1} max={1.5} step={0.01} bind:value={DBState.db.ooba.repetition_penalty} />
</div>
        <div class="py-3 border-t border-darkborderc flex flex-col">
    <SettingFieldLabel label={`Length Penalty`} />
    <ShSlider className="mt-2" inputWidth="w-16" min={-5} max={5} step={0.05} bind:value={DBState.db.ooba.length_penalty} />
</div>
        <div class="py-3 border-t border-darkborderc flex flex-col">
    <SettingFieldLabel label={`Top K`} />
    <ShSlider className="mt-2" inputWidth="w-16" min={0} max={100} step={1} bind:value={DBState.db.ooba.top_k} />
</div>
        <div class="py-3 border-t border-darkborderc flex flex-col">
    <SettingFieldLabel label={`Top P`} />
    <ShSlider className="mt-2" inputWidth="w-16" min={0} max={1} step={0.01} bind:value={DBState.db.ooba.top_p} />
</div>
        <div class="py-3 border-t border-darkborderc flex flex-col">
    <SettingFieldLabel label={`Typical P`} />
    <ShSlider className="mt-2" inputWidth="w-16" min={0} max={1} step={0.01} bind:value={DBState.db.ooba.typical_p} />
</div>
        <div class="py-3 border-t border-darkborderc flex flex-col">
    <SettingFieldLabel label={`Top A`} />
    <ShSlider className="mt-2" inputWidth="w-16" min={0} max={1} step={0.01} bind:value={DBState.db.ooba.top_a} />
</div>
        <div class="py-3 border-t border-darkborderc flex flex-col">
    <SettingFieldLabel label={`No Repeat n-gram Size`} />
    <ShSlider className="mt-2" inputWidth="w-16" min={0} max={20} step={1} bind:value={DBState.db.ooba.no_repeat_ngram_size} />
</div>
        <SettingRowLayout item={f('bot40', `Do Sample`)}>
    {#snippet control()}<ShSwitch checked={!!DBState.db.ooba.do_sample} onCheckedChange={(v) => DBState.db.ooba.do_sample = v} />{/snippet}
</SettingRowLayout>
        <SettingRowLayout item={f('bot41', `Add BOS Token`)}>
    {#snippet control()}<ShSwitch checked={!!DBState.db.ooba.add_bos_token} onCheckedChange={(v) => DBState.db.ooba.add_bos_token = v} />{/snippet}
</SettingRowLayout>
        <SettingRowLayout item={f('bot42', `Ban EOS Token`)}>
    {#snippet control()}<ShSwitch checked={!!DBState.db.ooba.ban_eos_token} onCheckedChange={(v) => DBState.db.ooba.ban_eos_token = v} />{/snippet}
</SettingRowLayout>
        <SettingRowLayout item={f('bot43', `Skip Special Tokens`)}>
    {#snippet control()}<ShSwitch checked={!!DBState.db.ooba.skip_special_tokens} onCheckedChange={(v) => DBState.db.ooba.skip_special_tokens = v} />{/snippet}
</SettingRowLayout>
        <SettingRowLayout item={f('customStopWords', language.customStopWords)}>
            {#snippet control()}
                <ShSwitch checked={!!DBState.db.localStopStrings} onCheckedChange={() => {
                    if(!DBState.db.localStopStrings){
                        DBState.db.localStopStrings = []
                    }
                    else{
                        DBState.db.localStopStrings = null
                    }
                }} />
            {/snippet}
        </SettingRowLayout>
        {#if DBState.db.localStopStrings}
            <div class="flex flex-col p-2 rounded-sm border border-selected mt-2 gap-1">
                <div class="p-2">
                    <button class="font-medium flex justify-center items-center h-full cursor-pointer hover:text-primary w-full" onclick={() => {
                        let localStopStrings = DBState.db.localStopStrings
                        localStopStrings.push('')
                        DBState.db.localStopStrings = localStopStrings
                    }}><PlusIcon /></button>
                </div>
                {#each DBState.db.localStopStrings as stopString, i}
                    <div class="flex w-full">
                        <div class="grow">
                            <TextInput marginBottom bind:value={DBState.db.localStopStrings[i]} fullwidth fullh/>
                        </div>
                        <div>
                            <button class="font-medium flex justify-center items-center h-full cursor-pointer hover:text-red-400 w-full" onclick={() => {
                                let localStopStrings = DBState.db.localStopStrings
                                localStopStrings.splice(i, 1)
                                DBState.db.localStopStrings = localStopStrings
                            }}><TrashIcon /></button>
                        </div>
                    </div>
                {/each}
            </div>
        {/if}
        <div class="flex flex-col p-3 rounded-md border-selected border mt-4">
            <ChatFormatSettings />
        </div>
        <SettingRowLayout item={f('useNamePrefix', language.useNamePrefix)}>
            {#snippet control()}<ShSwitch checked={!!DBState.db.ooba.formating.useName} onCheckedChange={(v) => DBState.db.ooba.formating.useName = v} />{/snippet}
        </SettingRowLayout>
    
    {:else if modelInfo.format === LLMFormat.NovelAI}
        <div class="text-textcolor2 text-xs mt-4 mb-2 p-2 rounded-md border border-darkborderc">
            These parameters follow NovelAI's own definitions. See the official NovelAI documentation for details.
        </div>
        <div class="flex flex-col p-3 bg-darkbg mt-4">
            <SettingRowLayout item={f('bot27', `Starter`)} wideControl>
    {#snippet control()}<TextInput className="sm:w-64 h-8" size="sm" padding fullwidth bind:value={DBState.db.NAIsettings.starter} placeholder={'⁂'}/>{/snippet}
</SettingRowLayout>
            <SettingRowLayout item={f('bot28', `Seperator`)} wideControl>
    {#snippet control()}<TextInput className="sm:w-64 h-8" size="sm" padding fullwidth bind:value={DBState.db.NAIsettings.seperator} placeholder={"\\n"}/>{/snippet}
</SettingRowLayout>
        </div>
        <div class="py-3 border-t border-darkborderc flex flex-col">
    <SettingFieldLabel label={`Top P`} />
    <ShSlider className="mt-2" inputWidth="w-16" min={0} max={1} step={0.01} bind:value={DBState.db.NAIsettings.topP} />
</div>
        <div class="py-3 border-t border-darkborderc flex flex-col">
    <SettingFieldLabel label={`Top K`} />
    <ShSlider className="mt-2" inputWidth="w-16" min={0} max={100} step={1} bind:value={DBState.db.NAIsettings.topK} />
</div>
        <div class="py-3 border-t border-darkborderc flex flex-col">
    <SettingFieldLabel label={`Top A`} />
    <ShSlider className="mt-2" inputWidth="w-16" min={0} max={1} step={0.01} bind:value={DBState.db.NAIsettings.topA} />
</div>
        <div class="py-3 border-t border-darkborderc flex flex-col">
    <SettingFieldLabel label={`Tailfree Sampling`} />
    <ShSlider className="mt-2" inputWidth="w-16" min={0} max={1} step={0.001} bind:value={DBState.db.NAIsettings.tailFreeSampling} />
</div>
        <div class="py-3 border-t border-darkborderc flex flex-col">
    <SettingFieldLabel label={`Typical P`} />
    <ShSlider className="mt-2" inputWidth="w-16" min={0} max={1} step={0.01} bind:value={DBState.db.NAIsettings.typicalp} />
</div>
        <div class="py-3 border-t border-darkborderc flex flex-col">
    <SettingFieldLabel label={`Repetition Penalty`} />
    <ShSlider className="mt-2" inputWidth="w-16" min={0} max={3} step={0.01} bind:value={DBState.db.NAIsettings.repetitionPenalty} />
</div>
        <div class="py-3 border-t border-darkborderc flex flex-col">
    <SettingFieldLabel label={`Repetition Penalty Range`} />
    <ShSlider className="mt-2" inputWidth="w-16" min={0} max={8192} step={1} bind:value={DBState.db.NAIsettings.repetitionPenaltyRange} />
</div>
        <div class="py-3 border-t border-darkborderc flex flex-col">
    <SettingFieldLabel label={`Repetition Penalty Slope`} />
    <ShSlider className="mt-2" inputWidth="w-16" min={0} max={10} step={0.01} bind:value={DBState.db.NAIsettings.repetitionPenaltySlope} />
</div>
        <div class="py-3 border-t border-darkborderc flex flex-col">
    <SettingFieldLabel label={`Frequency Penalty`} />
    <ShSlider className="mt-2" inputWidth="w-16" min={-2} max={2} step={0.01} bind:value={DBState.db.NAIsettings.frequencyPenalty} />
</div>
        <div class="py-3 border-t border-darkborderc flex flex-col">
    <SettingFieldLabel label={`Presence Penalty`} />
    <ShSlider className="mt-2" inputWidth="w-16" min={-2} max={2} step={0.01} bind:value={DBState.db.NAIsettings.presencePenalty} />
</div>
        <div class="py-3 border-t border-darkborderc flex flex-col">
    <SettingFieldLabel label={`Mirostat LR`} />
    <ShSlider className="mt-2" inputWidth="w-16" min={0} max={1} step={0.01} bind:value={DBState.db.NAIsettings.mirostat_lr} />
</div>
        <div class="py-3 border-t border-darkborderc flex flex-col">
    <SettingFieldLabel label={`Mirostat Tau`} />
    <ShSlider className="mt-2" inputWidth="w-16" min={0} max={6} step={0.01} bind:value={DBState.db.NAIsettings.mirostat_tau} />
</div>
        <div class="py-3 border-t border-darkborderc flex flex-col">
    <SettingFieldLabel label={`Cfg Scale`} />
    <ShSlider className="mt-2" inputWidth="w-16" min={1} max={3} step={0.01} bind:value={DBState.db.NAIsettings.cfg_scale} />
</div>

    {:else if modelInfo.format === LLMFormat.NovelList}
        <div class="text-textcolor2 text-xs mt-4 mb-2 p-2 rounded-md border border-darkborderc">
            These parameters follow NovelList's own definitions. See the official NovelList documentation for details.
        </div>
        <div class="py-3 border-t border-darkborderc flex flex-col">
    <SettingFieldLabel label={`Top P`} />
    <ShSlider className="mt-2" inputWidth="w-16" min={0} max={2} step={0.01} bind:value={DBState.db.ainconfig.top_p} />
</div>
        <div class="py-3 border-t border-darkborderc flex flex-col">
    <SettingFieldLabel label={`Reputation Penalty`} />
    <ShSlider className="mt-2" inputWidth="w-16" min={0} max={2} step={0.01} bind:value={DBState.db.ainconfig.rep_pen} />
</div>
        <div class="py-3 border-t border-darkborderc flex flex-col">
    <SettingFieldLabel label={`Reputation Penalty Range`} />
    <ShSlider className="mt-2" inputWidth="w-16" min={0} max={2048} step={1} bind:value={DBState.db.ainconfig.rep_pen_range} />
</div>
        <div class="py-3 border-t border-darkborderc flex flex-col">
    <SettingFieldLabel label={`Reputation Penalty Slope`} />
    <ShSlider className="mt-2" inputWidth="w-16" min={0} max={10} step={0.1} bind:value={DBState.db.ainconfig.rep_pen_slope} />
</div>
        <div class="py-3 border-t border-darkborderc flex flex-col">
    <SettingFieldLabel label={`Top K`} />
    <ShSlider className="mt-2" inputWidth="w-16" min={1} max={500} step={1} bind:value={DBState.db.ainconfig.top_k} />
</div>
        <div class="py-3 border-t border-darkborderc flex flex-col">
    <SettingFieldLabel label={`Top A`} />
    <ShSlider className="mt-2" inputWidth="w-16" min={0} max={1} step={0.01} bind:value={DBState.db.ainconfig.top_a} />
</div>
        <div class="py-3 border-t border-darkborderc flex flex-col">
    <SettingFieldLabel label={`Typical P`} />
    <ShSlider className="mt-2" inputWidth="w-16" min={0} max={1} step={0.01} bind:value={DBState.db.ainconfig.typical_p} />
</div>
    {:else}
        <!-- Standard parameters now handled by SettingRenderer above -->
    {/if}

    {#if (DBState.db.reverseProxyOobaMode && DBState.db.aiModel === 'reverse_proxy') || (DBState.db.aiModel === 'ooba')}
        <OobaSettings instructionMode={DBState.db.aiModel === 'ooba'} />
    {/if}

    {#if DBState.db.aiModel.startsWith('openrouter')}
        <OpenrouterSettings />
    {/if}

    <!-- Separate Parameters - handled by custom component -->
    <SeparateParametersSection />

    <!-- Global bias is still applied to every request and saved in prompt
         presets; its editor went missing when this menu was split. -->
    <ShAccordion name="Bias" variant="card" class="mt-4">
        <table class="contain w-full max-w-full tabler">
            <tbody>
            <tr>
                <th class="font-medium">Bias <Help key="bias"/></th>
                <th class="font-medium">{language.value}</th>
                <th>
                    <button class="font-medium cursor-pointer hover:text-primary w-full flex justify-center items-center" aria-label="add" onclick={() => {
                        DBState.db.bias = [...(DBState.db.bias ?? []), ['', 0]]
                    }}><PlusIcon /></button>
                </th>
            </tr>
            {#if (DBState.db.bias ?? []).length === 0}
                <tr>
                    <td colspan="3" class="text-textcolor2">{language.noBias}</td>
                </tr>
            {/if}
            {#each DBState.db.bias ?? [] as _bias, i}
                <tr>
                    <td class="font-medium truncate">
                        <TextInput bind:value={DBState.db.bias[i][0]} fullwidth/>
                    </td>
                    <td class="font-medium truncate">
                        <NumberInput bind:value={DBState.db.bias[i][1]} max={100} min={-101} fullwidth/>
                    </td>
                    <td>
                        <button class="font-medium flex justify-center items-center h-full cursor-pointer hover:text-red-400 w-full" aria-label="remove" onclick={() => {
                            DBState.db.bias = DBState.db.bias.filter((_, index) => index !== i)
                        }}><TrashIcon /></button>
                    </td>
                </tr>
            {/each}
            </tbody>
        </table>
        <div class="text-textcolor2 mt-2 flex items-center gap-2">
            <button class="font-medium cursor-pointer hover:text-textcolor" aria-label="export" onclick={() => {
                downloadFile('bias.json', JSON.stringify(DBState.db.bias ?? [], null, 2))
            }}><DownloadIcon /></button>
            <button class="font-medium cursor-pointer hover:text-textcolor" aria-label="import" onclick={async () => {
                const sel = await selectSingleFile(['json'])
                if (!sel) return
                try {
                    const parsed = JSON.parse(new TextDecoder().decode(sel.data))
                    if (!isBiasList(parsed)) throw new Error('invalid bias list')
                    DBState.db.bias = parsed
                } catch {
                    alertError(language.errors.noData)
                }
            }}><HardDriveUploadIcon /></button>
        </div>
    </ShAccordion>
{/if}

{#if $BotSubmenuIndex === 2}
    <CustomModelsSettings noAccordion />
{/if}



</SettingPage>

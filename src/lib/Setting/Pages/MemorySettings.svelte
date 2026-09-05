<script lang="ts">
    import { language } from "src/lang";
    import SettingPage from "src/lib/UI/GUI/SettingPage.svelte";
    import SettingTabs from "src/lib/UI/GUI/SettingTabs.svelte";
    import ShButton from "src/lib/UI/GUI/ShButton.svelte";
    import ShBadge from "src/lib/UI/GUI/ShBadge.svelte";
    import ShDropdownMenuItem from "src/lib/UI/GUI/ShDropdownMenuItem.svelte";
    import Check from "src/lib/UI/GUI/CheckInput.svelte";
    import Help from "src/lib/Others/Help.svelte";
    import TextAreaInput from "src/lib/UI/GUI/TextAreaInput.svelte";
    import TextInput from "src/lib/UI/GUI/TextInput.svelte";
    import NumberInput from "src/lib/UI/GUI/NumberInput.svelte";
    import SelectInput from "src/lib/UI/GUI/SelectInput.svelte";
    import OptionInput from "src/lib/UI/GUI/OptionInput.svelte";
    import SliderInput from "src/lib/UI/GUI/SliderInput.svelte";
    import Accordion from "src/lib/UI/Accordion.svelte";
    import FolderedList, { type FolderedItemPlacement } from "src/lib/UI/FolderedList.svelte";
    import { ArrowLeftIcon, HardDriveUploadIcon, PlusIcon, StarIcon } from "@lucide/svelte";
    import { alertConfirm, alertError, notifyError, notifySuccess } from "src/ts/alert";
    import { DBState, selectedCharID } from 'src/ts/stores.svelte';
    import { downloadFile, requestImmediateSave } from "src/ts/globalApi.svelte";
    import { selectSingleFile } from "src/ts/util";
    import { tokenizePreset } from "src/ts/process/prompt";
    import { getCharToken } from "src/ts/tokenizer";
    import { MEMORY_PRESET_OFF, createMemoryPreset, syncMemoryMirror } from "src/ts/process/memory/memoryPresets";
    import { onDestroy, untrack } from "svelte";
    import { v4 } from "uuid";

    // The page opens on the preset list; tapping an item switches to the
    // editor in place. Editing and "default" are separate: the default preset
    // is what chats on 'Default' run with, the edited one is just open.
    let editingId = $state<string | null>(null)
    // 0 = presets, 1 = embedding (app-wide, shared by every preset)
    let tab = $state(0)

    const presets = $derived(DBState.db.memoryPresets ?? [])
    const folders = $derived(DBState.db.memoryPresetFolders ?? [])
    const editingPreset = $derived(editingId ? presets.find(p => p.id === editingId) ?? null : null)
    const defaultIndex = $derived(presets.findIndex(p => p.id === DBState.db.memoryPresetId))

    $effect(() => {
        if (editingId && !editingPreset) editingId = null
    })

    // Form fields bind straight into the preset; keep the legacy HypaV3 mirror
    // (what a .bin export carries for upstream) in step with every edit.
    $effect(() => {
        if (!editingPreset) return
        JSON.stringify(editingPreset)
        untrack(() => syncMemoryMirror(DBState.db))
    })

    function save() {
        syncMemoryMirror(DBState.db)
        void requestImmediateSave()
    }

    function createPreset() {
        const preset = createMemoryPreset('New Preset', v4())
        DBState.db.memoryPresets = [...presets, preset]
        save()
        editingId = preset.id
    }

    function duplicate(index: number) {
        const source = $state.snapshot(presets[index])
        DBState.db.memoryPresets = [...presets, { ...source, id: v4(), name: source.name + ' (Copy)' }]
        save()
    }

    async function remove(index: number) {
        const preset = presets[index]
        if (!preset) return
        if (presets.length <= 1) {
            notifyError(language.memoryPresetLastOne)
            return
        }
        if (!await alertConfirm(`${language.removeConfirm}${preset.name}`)) return
        DBState.db.memoryPresets = presets.filter((_, i) => i !== index)
        if (DBState.db.memoryPresetId === preset.id) DBState.db.memoryPresetId = MEMORY_PRESET_OFF
        if (editingId === preset.id) editingId = null
        save()
    }

    function setDefault(id: string) {
        DBState.db.memoryPresetId = id
        save()
    }

    /** Rebuilds `db.memoryPresets` from the list's reported order/folder membership. */
    function applyPlacements(placements: FolderedItemPlacement[]) {
        const next = placements.map(({ index, folderId }) => ({ ...presets[index], folderId }))
        if (next.length !== presets.length) return
        DBState.db.memoryPresets = next
        save()
    }

    // Export keeps the pre-existing HypaV3 preset file format so files move
    // between PocketRisu and upstream RisuAI in both directions.
    async function exportPreset(index: number) {
        const preset = presets[index]
        if (!preset?.canon) return
        try {
            const bytesExport = Buffer.from(JSON.stringify({
                type: 'risu',
                ver: 1,
                data: { name: preset.name, settings: preset.canon.settings }
            }), 'utf-8')
            await downloadFile(`hypaV3_export_${preset.name}.json`, bytesExport)
            notifySuccess(language.successExport)
        } catch (error) {
            alertError(`${error}`)
        }
    }

    async function importPreset() {
        try {
            const bytesImport = (await selectSingleFile(['json']))?.data
            if (!bytesImport) return
            const objImport = JSON.parse(Buffer.from(bytesImport).toString('utf-8'))
            if (objImport.type !== 'risu' || !objImport.data) return
            const data = objImport.data
            const preset = createMemoryPreset(data.name || 'Imported Preset', v4(), data.settings ?? data.canon?.settings ?? {})
            DBState.db.memoryPresets = [...presets, preset]
            save()
            notifySuccess(language.successImport)
        } catch (error) {
            alertError(`${error}`)
        }
    }

    // HypaV3 ratio guards: the two ratios share a 0..1 budget.
    $effect(() => {
        const settings = editingPreset?.canon?.settings
        const currentValue = settings?.similarMemoryRatio
        if (!currentValue) return
        untrack(() => {
            const newValue = Math.min(currentValue, 1)
            settings.similarMemoryRatio = newValue
            if (newValue + settings.recentMemoryRatio > 1) {
                settings.recentMemoryRatio = 1 - newValue
            }
        })
    })

    $effect(() => {
        const settings = editingPreset?.canon?.settings
        const currentValue = settings?.recentMemoryRatio
        if (!currentValue) return
        untrack(() => {
            const newValue = Math.min(currentValue, 1)
            settings.recentMemoryRatio = newValue
            if (newValue + settings.similarMemoryRatio > 1) {
                settings.similarMemoryRatio = 1 - newValue
            }
        })
    })

    async function getMaxMemoryRatio(): Promise<number> {
        const char = DBState.db.characters[$selectedCharID]
        const maxContext = DBState.db.maxContext
        if (!char || maxContext === 0) return 0
        const promptTemplateToken = await tokenizePreset(DBState.db.promptTemplate)
        const charToken = await getCharToken(char)
        const maxLoreToken = char.loreSettings?.tokenBudget ?? DBState.db.loreBookToken
        const maxResponse = DBState.db.maxResponse
        const requiredToken = promptTemplateToken + charToken.persistant + Math.min(charToken.dynamic, maxLoreToken) + maxResponse * 3
        const maxMemoryRatio = Math.max((maxContext - requiredToken) / maxContext, 0)
        return parseFloat(maxMemoryRatio.toFixed(2))
    }

    onDestroy(() => {
        syncMemoryMirror(DBState.db)
    })
</script>

{#if !editingPreset}
<SettingPage title={language.longTermMemory}>
    <SettingTabs
        tabs={[
            { label: language.presets, value: 0 },
            { label: language.embedding, value: 1 },
        ]}
        bind:selected={tab}
    />

{#if tab === 1}
    <span class="text-textcolor">{language.embedding} <Help key="embedding"/></span>
    <SelectInput className="mt-2 mb-4" bind:value={DBState.db.hypaModel}>
        {#if 'gpu' in navigator}
            <OptionInput value="MiniLMGPU">MiniLM L6 v2 (GPU)</OptionInput>
            <OptionInput value="nomicGPU">Nomic Embed Text v1.5 (GPU)</OptionInput>
            <OptionInput value="bgeSmallEnGPU">BGE Small English (GPU)</OptionInput>
            <OptionInput value="bgem3GPU">BGE Medium 3 (GPU)</OptionInput>
            <OptionInput value="multiMiniLMGPU">Multilingual MiniLM L12 v2 (GPU)</OptionInput>
            <OptionInput value="bgeM3KoGPU">BGE Medium 3 Korean (GPU)</OptionInput>
        {/if}
        <OptionInput value="MiniLM">MiniLM L6 v2 (CPU)</OptionInput>
        <OptionInput value="nomic">Nomic Embed Text v1.5 (CPU)</OptionInput>
        <OptionInput value="bgeSmallEn">BGE Small English (CPU)</OptionInput>
        <OptionInput value="bgem3">BGE Medium 3 (CPU)</OptionInput>
        <OptionInput value="multiMiniLM">Multilingual MiniLM L12 v2 (CPU)</OptionInput>
        <OptionInput value="bgeM3Ko">BGE Medium 3 Korean (CPU)</OptionInput>
        <OptionInput value="openai3small">OpenAI text-embedding-3-small</OptionInput>
        <OptionInput value="openai3large">OpenAI text-embedding-3-large</OptionInput>
        <OptionInput value="ada">OpenAI Ada</OptionInput>
        <OptionInput value="custom">Custom (OpenAI-compatible)</OptionInput>
        <OptionInput value="voyageContext3">Voyage Context 3</OptionInput>
        <OptionInput value="voyageContext4">Voyage Context 4</OptionInput>
    </SelectInput>

    {#if DBState.db.hypaModel === 'openai3small' || DBState.db.hypaModel === 'openai3large' || DBState.db.hypaModel === 'ada'}
        <span class="text-textcolor">OpenAI API Key <Help key="embeddingOpenAIKey"/></span>
        <TextInput className="mt-2" marginBottom bind:value={DBState.db.supaMemoryKey}/>
    {/if}

    {#if DBState.db.hypaModel === 'custom'}
        <span class="text-textcolor">URL <Help key="embeddingCustomURL"/></span>
        <TextInput className="mt-2" marginBottom bind:value={DBState.db.hypaCustomSettings.url}/>
        <span class="text-textcolor">Key/Password <Help key="embeddingCustomKey"/></span>
        <TextInput className="mt-2" marginBottom bind:value={DBState.db.hypaCustomSettings.key}/>
        <span class="text-textcolor">Request Model <Help key="embeddingCustomModel"/></span>
        <TextInput className="mt-2" marginBottom bind:value={DBState.db.hypaCustomSettings.model}/>
    {/if}

    {#if DBState.db.hypaModel === 'voyageContext3' || DBState.db.hypaModel === 'voyageContext4'}
        <span class="text-textcolor">Voyage API Key <Help key="embeddingVoyageKey"/></span>
        <TextInput className="mt-2" marginBottom hideText={DBState.db.hideApiKey} bind:value={DBState.db.voyageApiKey}/>
    {/if}
{:else}
    <span class="text-textcolor">{language.memoryPresetDefault} <Help key="memoryPresetDefault"/></span>
    <SelectInput className="mt-2 mb-6" bind:value={DBState.db.memoryPresetId} onchange={() => save()}>
        <OptionInput value={MEMORY_PRESET_OFF}>{language.memoryPresetOff}</OptionInput>
        {#each presets as preset (preset.id)}
            <OptionInput value={preset.id}>{preset.name}</OptionInput>
        {/each}
    </SelectInput>

    <FolderedList
        {folders}
        itemFolderIds={presets.map(p => p.folderId)}
        itemSearchTexts={presets.map(p => p.name)}
        searchPlaceholder={language.memoryPresetSearch}
        selectedIndex={defaultIndex}
        storageKey="risu-memory-preset-folders-collapsed"
        onSelect={(index) => { editingId = presets[index].id }}
        onItemsChange={applyPlacements}
        onFoldersChange={(next) => { DBState.db.memoryPresetFolders = next; void requestImmediateSave() }}
        onDuplicate={duplicate}
        onExport={exportPreset}
        onDelete={remove}
    >
        {#snippet actions()}
            <ShButton size="sm" onclick={createPreset}><PlusIcon />{language.memoryPresetCreate}</ShButton>
            <ShButton size="sm" variant="outline" onclick={importPreset}><HardDriveUploadIcon />{language.import}</ShButton>
        {/snippet}
        {#snippet itemContent(index)}
            {@const preset = presets[index]}
            <div class="min-w-0 grow truncate flex items-center gap-2">
                <span class="truncate">{preset.name}</span>
                {#if preset.canon?.source === 'hypaV3'}
                    <ShBadge variant="secondary">Hypa V3</ShBadge>
                {/if}
                {#if preset.id === DBState.db.memoryPresetId}
                    <StarIcon size={14} class="shrink-0 text-primary" />
                {/if}
            </div>
        {/snippet}
        {#snippet itemMenu(index)}
            {#if presets[index].id !== DBState.db.memoryPresetId}
                <ShDropdownMenuItem onSelect={() => setDefault(presets[index].id)}><StarIcon /><span>{language.memoryPresetSetDefault}</span></ShDropdownMenuItem>
            {/if}
        {/snippet}
    </FolderedList>
{/if}
</SettingPage>
{:else}
<div class="flex items-center gap-2 mt-2 mb-4">
    <ShButton size="sm" variant="ghost" onclick={() => { save(); editingId = null }}><ArrowLeftIcon />{language.backToList}</ShButton>
</div>
<div class="flex flex-col">
    <span class="text-textcolor">{language.memoryPresetName}</span>
    <TextInput className="mt-2" marginBottom bind:value={editingPreset.name} />

    <div class="flex items-center gap-2 mb-6 flex-wrap">
        <span class="text-textcolor">{language.memoryPresetMethod}</span>
        {#if editingPreset.canon?.source === 'hypaV3'}
            <ShBadge variant="secondary">Hypa V3</ShBadge>
        {/if}
        {#if editingPreset.id === DBState.db.memoryPresetId}
            <ShBadge><StarIcon size={12} />{language.memoryPresetDefault}</ShBadge>
        {:else}
            <ShButton size="sm" variant="outline" onclick={() => setDefault(editingPreset.id)}><StarIcon />{language.memoryPresetSetDefault}</ShButton>
        {/if}
    </div>

    {#if editingPreset.canon?.source === 'hypaV3'}
        {@const settings = editingPreset.canon.settings}

            <span class="text-textcolor">{language.model} <Help key="hypaV3SummaryModel"/></span>
            <SelectInput className="mt-2 mb-4" bind:value={settings.summarizationModel}>
                <OptionInput value="subModel">{language.submodel}</OptionInput>
                {#if "gpu" in navigator}
                    <OptionInput value="Qwen3-1.7B-q4f32_1-MLC">Qwen3 1.7B (GPU)</OptionInput>
                    <OptionInput value="Qwen3-4B-q4f32_1-MLC">Qwen3 4B (GPU)</OptionInput>
                    <OptionInput value="Qwen3-8B-q4f32_1-MLC">Qwen3 8B (GPU)</OptionInput>
                {/if}
            </SelectInput>
            <span class="text-textcolor">{language.summarizationPrompt} <Help key="summarizationPrompt"/></span>
            <div class="mb-4">
                <TextAreaInput className="mt-2 mb-4" placeholder={language.hypaV3Settings.supaMemoryPromptPlaceHolder} bind:value={settings.summarizationPrompt} />
            </div>
            <span class="text-textcolor">{language.reSummarizationPrompt} <Help key="reSummarizationPrompt"/></span>
            <div class="mb-4">
                <TextAreaInput className="mt-2 mb-4" placeholder={language.hypaV3Settings.supaMemoryPromptPlaceHolder} bind:value={settings.reSummarizationPrompt} />
            </div>
            {#await getMaxMemoryRatio() then maxMemoryRatio}
            <span class="text-textcolor">{language.hypaV3Settings.maxMemoryTokensRatioLabel}</span>
            <NumberInput className="mt-2" marginBottom disabled value={maxMemoryRatio} />
            {:catch error}
            <span class="mb-4 text-red-400">{language.hypaV3Settings.maxMemoryTokensRatioError}</span>
            {/await}
            <span class="text-textcolor">{language.hypaV3Settings.memoryTokensRatioLabel} <Help key="hypaV3MemoryTokensRatio"/></span>
            <SliderInput className="mt-2" marginBottom min={0} max={1} step={0.01} fixed={2} bind:value={settings.memoryTokensRatio} />
            <span class="text-textcolor">{language.hypaV3Settings.extraSummarizationRatioLabel} <Help key="hypaV3ExtraSummarizationRatio"/></span>
            <SliderInput className="mt-2" marginBottom min={0} max={1 - settings.memoryTokensRatio} step={0.01} fixed={2} bind:value={settings.extraSummarizationRatio} />
            <span class="text-textcolor">{language.hypaV3Settings.maxChatsPerSummaryLabel} <Help key="hypaV3MaxChatsPerSummary"/></span>
            <NumberInput className="mt-2" marginBottom min={1} bind:value={settings.maxChatsPerSummary} />
            <span class="text-textcolor">{language.hypaV3Settings.queryChatCountLabel} <Help key="hypaV3QueryChatCount"/></span>
            <NumberInput className="mt-2" marginBottom min={1} max={20} bind:value={settings.queryChatCount} />
            <span class="text-textcolor">{language.hypaV3Settings.summaryChunkSeparatorLabel} <Help key="hypaV3SummaryChunkSeparator"/></span>
            <TextInput className="mt-2" marginBottom bind:value={settings.summaryChunkSeparator} />
            <span class="text-textcolor">{language.hypaV3Settings.recentMemoryRatioLabel} <Help key="hypaV3RecentMemoryRatio"/></span>
            <SliderInput className="mt-2" marginBottom min={0} max={1} step={0.01} fixed={2} bind:value={settings.recentMemoryRatio} />
            <span class="text-textcolor">{language.hypaV3Settings.similarMemoryRatioLabel} <Help key="hypaV3SimilarMemoryRatio"/></span>
            <SliderInput className="mt-2" marginBottom min={0} max={1} step={0.01} fixed={2} bind:value={settings.similarMemoryRatio} />
            <span class="text-textcolor">{language.hypaV3Settings.randomMemoryRatioLabel} <Help key="hypaV3RandomMemoryRatio"/></span>
            <NumberInput className="mt-2" marginBottom disabled value={parseFloat((1 - settings.recentMemoryRatio - settings.similarMemoryRatio).toFixed(2))} />
            <div class="mb-2 flex items-center">
                <Check name={language.hypaV3Settings.preserveOrphanedMemoryLabel} bind:check={settings.preserveOrphanedMemory} />
                <Help key="hypaV3PreserveOrphanedMemory"/>
            </div>
            <div class="mb-2 flex items-center">
                <Check name={language.hypaV3Settings.applyRegexScriptWhenRerollingLabel} bind:check={settings.processRegexScript} />
                <Help key="hypaV3ProcessRegexScript"/>
            </div>
            <div class="mb-2 flex items-center">
                <Check name={language.hypaV3Settings.doNotSummarizeUserMessageLabel} bind:check={settings.doNotSummarizeUserMessage} />
                <Help key="hypaV3DoNotSummarizeUserMessage"/>
            </div>
            <Accordion name="Advanced Settings" styled>
                <div class="mb-2 flex items-center">
                    <Check name="Use Experimental Implementation" bind:check={settings.useExperimentalImpl} />
                    <Help key="hypaV3UseExperimentalImpl"/>
                </div>
                <div class="mb-2 flex items-center">
                    <Check name="Always Toggle On" bind:check={settings.alwaysToggleOn} />
                    <Help key="hypaV3AlwaysToggleOn"/>
                </div>
                {#if settings.useExperimentalImpl}
                    <div>
                        <span class="text-textcolor">Summarization Requests Per Minute <Help key="hypaV3SummarizationRequestsPerMinute"/></span>
                        <NumberInput className="mt-2" marginBottom min={1} bind:value={settings.summarizationRequestsPerMinute} />
                    </div>
                    <div>
                        <span class="text-textcolor">Summarization Max Concurrent <Help key="hypaV3SummarizationMaxConcurrent"/></span>
                        <NumberInput className="mt-2" marginBottom min={1} max={10} bind:value={settings.summarizationMaxConcurrent} />
                    </div>
                    <div>
                        <span class="text-textcolor">Embedding Requests Per Minute <Help key="hypaV3EmbeddingRequestsPerMinute"/></span>
                        <NumberInput className="mt-2" marginBottom min={1} bind:value={settings.embeddingRequestsPerMinute} />
                    </div>
                    <div>
                        <span class="text-textcolor">Embedding Max Concurrent <Help key="hypaV3EmbeddingMaxConcurrent"/></span>
                        <NumberInput className="mt-2" marginBottom min={1} max={10} bind:value={settings.embeddingMaxConcurrent} />
                    </div>
                {:else}
                    <div class="mb-2 flex items-center">
                        <Check name={language.hypaV3Settings.enableSimilarityCorrectionLabel} bind:check={settings.enableSimilarityCorrection} />
                        <Help key="hypaV3EnableSimilarityCorrection"/>
                    </div>
                {/if}
            </Accordion>
    {/if}
</div>
{/if}

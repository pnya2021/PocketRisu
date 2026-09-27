<script lang="ts">
    import SettingFieldLabel from "src/lib/Setting/Wrappers/SettingFieldLabel.svelte";
    import { language } from "src/lang";
    import SettingPage from "src/lib/UI/GUI/SettingPage.svelte";
    import SettingTabs from "src/lib/UI/GUI/SettingTabs.svelte";
    import ShButton from "src/lib/UI/GUI/ShButton.svelte";
    import ShBadge from "src/lib/UI/GUI/ShBadge.svelte";
    import ShDropdownMenuItem from "src/lib/UI/GUI/ShDropdownMenuItem.svelte";
    import ShSwitch from "src/lib/UI/GUI/ShSwitch.svelte";
    import ShSlider from "src/lib/UI/GUI/ShSlider.svelte";
    import ShAccordion from "src/lib/UI/GUI/ShAccordion.svelte";
    import SettingRowLayout from "src/lib/Setting/Wrappers/SettingRowLayout.svelte";
    import type { SettingItem } from "src/ts/setting/types";
    import TextAreaInput from "src/lib/UI/GUI/TextAreaInput.svelte";
    import TextInput from "src/lib/UI/GUI/TextInput.svelte";
    import NumberInput from "src/lib/UI/GUI/NumberInput.svelte";
    import SelectInput from "src/lib/UI/GUI/SelectInput.svelte";
    import OptionInput from "src/lib/UI/GUI/OptionInput.svelte";
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

    // Row-layout field descriptor for SettingRowLayout (label + inline help).
    function field(id: string, label: string, helpKey?: string): SettingItem {
        return { id: `memory.${id}`, type: 'custom', fallbackLabel: label, helpKey }
    }
</script>


<!-- Ratios display at 2 decimals like the legacy SliderInput (fixed=2); the
     ratio guards above can leave float noise such as 0.09999999999999998. -->
{#snippet ratioSlider(value: number, max: number, onchange: (v: number) => void)}
    <div class="w-full sm:w-48">
        <ShSlider min={0} {max} step={0.01} inputWidth="w-16" bind:value={() => Math.round(value * 100) / 100, onchange} />
    </div>
{/snippet}

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
    <div class="[&>*:first-child]:border-t-0">
    <SettingRowLayout item={field('embedding', language.embedding, 'embedding')}>
        {#snippet control()}
    <SelectInput className="w-48 sm:w-56" size="sm" bind:value={DBState.db.hypaModel}>
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
        {/snippet}
    </SettingRowLayout>

    {#if DBState.db.hypaModel === 'openai3small' || DBState.db.hypaModel === 'openai3large' || DBState.db.hypaModel === 'ada'}
        <SettingRowLayout item={field('openaiKey', 'OpenAI API Key', 'embeddingOpenAIKey')} wideControl>
            {#snippet control()}<TextInput className="sm:w-48 h-8" size="sm" padding fullwidth bind:value={DBState.db.supaMemoryKey}/>{/snippet}
        </SettingRowLayout>
    {/if}

    {#if DBState.db.hypaModel === 'custom'}
        <SettingRowLayout item={field('customUrl', 'URL', 'embeddingCustomURL')} wideControl>
            {#snippet control()}<TextInput className="sm:w-48 h-8" size="sm" padding fullwidth bind:value={DBState.db.hypaCustomSettings.url}/>{/snippet}
        </SettingRowLayout>
        <SettingRowLayout item={field('customKey', 'Key/Password', 'embeddingCustomKey')} wideControl>
            {#snippet control()}<TextInput className="sm:w-48 h-8" size="sm" padding fullwidth bind:value={DBState.db.hypaCustomSettings.key}/>{/snippet}
        </SettingRowLayout>
        <SettingRowLayout item={field('customModel', 'Request Model', 'embeddingCustomModel')} wideControl>
            {#snippet control()}<TextInput className="sm:w-48 h-8" size="sm" padding fullwidth bind:value={DBState.db.hypaCustomSettings.model}/>{/snippet}
        </SettingRowLayout>
    {/if}

    {#if DBState.db.hypaModel === 'voyageContext3' || DBState.db.hypaModel === 'voyageContext4'}
        <SettingRowLayout item={field('voyageKey', 'Voyage API Key', 'embeddingVoyageKey')} wideControl>
            {#snippet control()}<TextInput className="sm:w-48 h-8" size="sm" padding fullwidth hideText={DBState.db.hideApiKey} bind:value={DBState.db.voyageApiKey}/>{/snippet}
        </SettingRowLayout>
    {/if}
    </div>
{:else}
    <div class="mb-4 [&>*:first-child]:border-t-0">
    <SettingRowLayout item={field('default', language.memoryPresetDefault, 'memoryPresetDefault')}>
        {#snippet control()}
    <SelectInput className="w-48" size="sm" bind:value={DBState.db.memoryPresetId} onchange={() => save()}>
        <OptionInput value={MEMORY_PRESET_OFF}>{language.memoryPresetOff}</OptionInput>
        {#each presets as preset (preset.id)}
            <OptionInput value={preset.id}>{preset.name}</OptionInput>
        {/each}
    </SelectInput>
        {/snippet}
    </SettingRowLayout>
    </div>
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
<div class="flex items-center gap-2 mt-2 mb-2">
    <ShButton size="sm" variant="ghost" onclick={() => { save(); editingId = null }}><ArrowLeftIcon />{language.backToList}</ShButton>
</div>
<div class="flex flex-col [&>*:first-child]:border-t-0">
    <SettingRowLayout item={field('name', language.memoryPresetName)} wideControl>
        {#snippet control()}<TextInput className="sm:w-48 h-8" size="sm" padding fullwidth bind:value={editingPreset.name} />{/snippet}
    </SettingRowLayout>

    <div class="flex items-center justify-between gap-3 py-3 border-t border-darkborderc flex-wrap">
        <div class="flex items-center gap-2 min-w-0">
            <span class="text-sm text-textcolor">{language.memoryPresetMethod}</span>
            {#if editingPreset.canon?.source === 'hypaV3'}
                <ShBadge variant="secondary">Hypa V3</ShBadge>
            {/if}
        </div>
        {#if editingPreset.id === DBState.db.memoryPresetId}
            <ShBadge><StarIcon size={12} />{language.memoryPresetDefault}</ShBadge>
        {:else}
            <ShButton size="sm" variant="outline" onclick={() => setDefault(editingPreset.id)}><StarIcon />{language.memoryPresetSetDefault}</ShButton>
        {/if}
    </div>

    {#if editingPreset.canon?.source === 'hypaV3'}
        {@const settings = editingPreset.canon.settings}

            <SettingRowLayout item={field('model', language.model, 'hypaV3SummaryModel')}>
                {#snippet control()}
            <SelectInput className="w-48" size="sm" bind:value={settings.summarizationModel}>
                <OptionInput value="subModel">{language.submodel}</OptionInput>
                {#if "gpu" in navigator}
                    <OptionInput value="Qwen3-1.7B-q4f32_1-MLC">Qwen3 1.7B (GPU)</OptionInput>
                    <OptionInput value="Qwen3-4B-q4f32_1-MLC">Qwen3 4B (GPU)</OptionInput>
                    <OptionInput value="Qwen3-8B-q4f32_1-MLC">Qwen3 8B (GPU)</OptionInput>
                {/if}
            </SelectInput>
                {/snippet}
            </SettingRowLayout>
            <div class="py-3 border-t border-darkborderc">
                <SettingFieldLabel label={language.summarizationPrompt} helpKey="summarizationPrompt" />
                <TextAreaInput className="mt-2" placeholder={language.hypaV3Settings.supaMemoryPromptPlaceHolder} bind:value={settings.summarizationPrompt} />
            </div>
            <div class="py-3 border-t border-darkborderc">
                <SettingFieldLabel label={language.reSummarizationPrompt} helpKey="reSummarizationPrompt" />
                <TextAreaInput className="mt-2" placeholder={language.hypaV3Settings.supaMemoryPromptPlaceHolder} bind:value={settings.reSummarizationPrompt} />
            </div>
            {#await getMaxMemoryRatio() then maxMemoryRatio}
            <SettingRowLayout item={field('maxRatio', language.hypaV3Settings.maxMemoryTokensRatioLabel)}>
                {#snippet control()}<NumberInput className="w-24" size="sm" padding disabled value={maxMemoryRatio} />{/snippet}
            </SettingRowLayout>
            {:catch error}
            <div class="py-3 border-t border-darkborderc text-sm text-red-400">{language.hypaV3Settings.maxMemoryTokensRatioError}</div>
            {/await}
            <SettingRowLayout item={field('memoryRatio', language.hypaV3Settings.memoryTokensRatioLabel, 'hypaV3MemoryTokensRatio')} wideControl>
                {#snippet control()}{@render ratioSlider(settings.memoryTokensRatio, 1, (v) => settings.memoryTokensRatio = v)}{/snippet}
            </SettingRowLayout>
            <SettingRowLayout item={field('extraRatio', language.hypaV3Settings.extraSummarizationRatioLabel, 'hypaV3ExtraSummarizationRatio')} wideControl>
                {#snippet control()}{@render ratioSlider(settings.extraSummarizationRatio, 1 - settings.memoryTokensRatio, (v) => settings.extraSummarizationRatio = v)}{/snippet}
            </SettingRowLayout>
            <SettingRowLayout item={field('maxChats', language.hypaV3Settings.maxChatsPerSummaryLabel, 'hypaV3MaxChatsPerSummary')}>
                {#snippet control()}<NumberInput className="w-24" size="sm" padding min={1} bind:value={settings.maxChatsPerSummary} />{/snippet}
            </SettingRowLayout>
            <SettingRowLayout item={field('queryCount', language.hypaV3Settings.queryChatCountLabel, 'hypaV3QueryChatCount')}>
                {#snippet control()}<NumberInput className="w-24" size="sm" padding min={1} max={20} bind:value={settings.queryChatCount} />{/snippet}
            </SettingRowLayout>
            <SettingRowLayout item={field('separator', language.hypaV3Settings.summaryChunkSeparatorLabel, 'hypaV3SummaryChunkSeparator')} wideControl>
                {#snippet control()}<TextInput className="sm:w-48 h-8" size="sm" padding fullwidth bind:value={settings.summaryChunkSeparator} />{/snippet}
            </SettingRowLayout>
            <SettingRowLayout item={field('recentRatio', language.hypaV3Settings.recentMemoryRatioLabel, 'hypaV3RecentMemoryRatio')} wideControl>
                {#snippet control()}{@render ratioSlider(settings.recentMemoryRatio, 1, (v) => settings.recentMemoryRatio = v)}{/snippet}
            </SettingRowLayout>
            <SettingRowLayout item={field('similarRatio', language.hypaV3Settings.similarMemoryRatioLabel, 'hypaV3SimilarMemoryRatio')} wideControl>
                {#snippet control()}{@render ratioSlider(settings.similarMemoryRatio, 1, (v) => settings.similarMemoryRatio = v)}{/snippet}
            </SettingRowLayout>
            <SettingRowLayout item={field('randomRatio', language.hypaV3Settings.randomMemoryRatioLabel, 'hypaV3RandomMemoryRatio')}>
                {#snippet control()}<NumberInput className="w-24" size="sm" padding disabled value={parseFloat((1 - settings.recentMemoryRatio - settings.similarMemoryRatio).toFixed(2))} />{/snippet}
            </SettingRowLayout>
            <SettingRowLayout item={field('preserveOrphaned', language.hypaV3Settings.preserveOrphanedMemoryLabel, 'hypaV3PreserveOrphanedMemory')}>
                {#snippet control()}<ShSwitch checked={!!settings.preserveOrphanedMemory} onCheckedChange={(v) => settings.preserveOrphanedMemory = v} />{/snippet}
            </SettingRowLayout>
            <SettingRowLayout item={field('processRegex', language.hypaV3Settings.applyRegexScriptWhenRerollingLabel, 'hypaV3ProcessRegexScript')}>
                {#snippet control()}<ShSwitch checked={!!settings.processRegexScript} onCheckedChange={(v) => settings.processRegexScript = v} />{/snippet}
            </SettingRowLayout>
            <SettingRowLayout item={field('noUserSummary', language.hypaV3Settings.doNotSummarizeUserMessageLabel, 'hypaV3DoNotSummarizeUserMessage')}>
                {#snippet control()}<ShSwitch checked={!!settings.doNotSummarizeUserMessage} onCheckedChange={(v) => settings.doNotSummarizeUserMessage = v} />{/snippet}
            </SettingRowLayout>
            <div class="pt-3 border-t border-darkborderc">
            <ShAccordion name="Advanced Settings" variant="card">
                <div class="flex flex-col [&>*:first-child]:border-t-0">
                <SettingRowLayout item={field('experimental', 'Use Experimental Implementation', 'hypaV3UseExperimentalImpl')}>
                    {#snippet control()}<ShSwitch checked={!!settings.useExperimentalImpl} onCheckedChange={(v) => settings.useExperimentalImpl = v} />{/snippet}
                </SettingRowLayout>
                <SettingRowLayout item={field('alwaysOn', 'Always Toggle On', 'hypaV3AlwaysToggleOn')}>
                    {#snippet control()}<ShSwitch checked={!!settings.alwaysToggleOn} onCheckedChange={(v) => settings.alwaysToggleOn = v} />{/snippet}
                </SettingRowLayout>
                {#if settings.useExperimentalImpl}
                    <SettingRowLayout item={field('sumRpm', 'Summarization Requests Per Minute', 'hypaV3SummarizationRequestsPerMinute')}>
                        {#snippet control()}<NumberInput className="w-24" size="sm" padding min={1} bind:value={settings.summarizationRequestsPerMinute} />{/snippet}
                    </SettingRowLayout>
                    <SettingRowLayout item={field('sumConcurrent', 'Summarization Max Concurrent', 'hypaV3SummarizationMaxConcurrent')}>
                        {#snippet control()}<NumberInput className="w-24" size="sm" padding min={1} max={10} bind:value={settings.summarizationMaxConcurrent} />{/snippet}
                    </SettingRowLayout>
                    <SettingRowLayout item={field('embRpm', 'Embedding Requests Per Minute', 'hypaV3EmbeddingRequestsPerMinute')}>
                        {#snippet control()}<NumberInput className="w-24" size="sm" padding min={1} bind:value={settings.embeddingRequestsPerMinute} />{/snippet}
                    </SettingRowLayout>
                    <SettingRowLayout item={field('embConcurrent', 'Embedding Max Concurrent', 'hypaV3EmbeddingMaxConcurrent')}>
                        {#snippet control()}<NumberInput className="w-24" size="sm" padding min={1} max={10} bind:value={settings.embeddingMaxConcurrent} />{/snippet}
                    </SettingRowLayout>
                {:else}
                    <SettingRowLayout item={field('similarityCorrection', language.hypaV3Settings.enableSimilarityCorrectionLabel, 'hypaV3EnableSimilarityCorrection')}>
                        {#snippet control()}<ShSwitch checked={!!settings.enableSimilarityCorrection} onCheckedChange={(v) => settings.enableSimilarityCorrection = v} />{/snippet}
                    </SettingRowLayout>
                {/if}
                </div>
            </ShAccordion>
            </div>
    {/if}
</div>
{/if}

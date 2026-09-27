<script lang="ts">
    import SettingFieldLabel from "src/lib/Setting/Wrappers/SettingFieldLabel.svelte";
    import { ArrowLeft, PlusIcon, TrashIcon, TriangleAlertIcon } from "@lucide/svelte";
    import { language } from "src/lang";
    import SettingPage from "src/lib/UI/GUI/SettingPage.svelte";
    import PromptDataItem from "src/lib/UI/PromptDataItem.svelte";
    import { tokenizePreset, type PromptItem } from "src/ts/process/prompt";
    import { templateCheck } from "src/ts/process/templates/templateCheck";
    
    import { DBState } from 'src/ts/stores.svelte';
    import ShSwitch from "src/lib/UI/GUI/ShSwitch.svelte";
    import ShButton from "src/lib/UI/GUI/ShButton.svelte";
    import ShAlert from "src/lib/UI/GUI/ShAlert.svelte";
    import ShAccordion from "src/lib/UI/GUI/ShAccordion.svelte";
    import SettingTabs from "src/lib/UI/GUI/SettingTabs.svelte";
    import SettingRowLayout from "src/lib/Setting/Wrappers/SettingRowLayout.svelte";
    import type { SettingItem } from "src/ts/setting/types";
    import TextInput from "src/lib/UI/GUI/TextInput.svelte";
    import NumberInput from "src/lib/UI/GUI/NumberInput.svelte";
    import TextAreaInput from "src/lib/UI/GUI/TextAreaInput.svelte";
    import SelectInput from "src/lib/UI/GUI/SelectInput.svelte";
    import OptionInput from "src/lib/UI/GUI/OptionInput.svelte";
    import ModelList from "src/lib/UI/ModelList.svelte";
    import { onDestroy, onMount } from "svelte";
    import {defaultAutoSuggestPrompt} from "../../../ts/storage/defaultPrompts";

    let sorted = 0
    let warns: string[] = $state([])
    let tokens = $state(0)
    let extokens = $state(0)
    let draggedIndex = $state(-1)
    let dragOverIndex = $state(-1)
    let openedItemIndices = $state(new Set<number>())
    executeTokenize(DBState.db.promptTemplate)
  interface Props {
    onGoBack?: () => void;
    mode?: 'independent'|'inline';
    subMenu?: number;
  }

  let { onGoBack = () => {}, mode = 'independent', subMenu = $bindable(0) }: Props = $props();

    async function executeTokenize(prest: PromptItem[]){
        tokens = await tokenizePreset(prest, true)
        extokens = await tokenizePreset(prest, false)
    }

    $effect.pre(() => {
    warns = templateCheck(DBState.db)
  });
  $effect.pre(() => {
    executeTokenize(DBState.db.promptTemplate)
  });

  function getDisplayTemplate() {
    return DBState.db.promptTemplate.map((item, i) => ({
      item,
      originalIndex: i,
      displayIndex: i
    }))
  }

  function getReorderedTemplate() {
    if (draggedIndex === -1 || dragOverIndex === -1 || draggedIndex === dragOverIndex) {
      return getDisplayTemplate()
    }

    const items = getDisplayTemplate()
    const [movedItem] = items.splice(draggedIndex, 1)

    const adjustedDropIndex = draggedIndex < dragOverIndex ? dragOverIndex - 1 : dragOverIndex
    items.splice(adjustedDropIndex, 0, movedItem)

    return items.map((item, displayIndex) => ({
      ...item,
      displayIndex
    }))
  }

  function handlePromptDrop() {
    if (draggedIndex === -1 || dragOverIndex === -1 || draggedIndex === dragOverIndex) {
      return
    }

    const templates = [...DBState.db.promptTemplate]
    const [movedItem] = templates.splice(draggedIndex, 1)

    const adjustedDropIndex = draggedIndex < dragOverIndex ? dragOverIndex - 1 : dragOverIndex
    templates.splice(adjustedDropIndex, 0, movedItem)

    const newOpenedIndices = new Set<number>()
    openedItemIndices.forEach((index) => {
      if (index === draggedIndex) {
        newOpenedIndices.add(adjustedDropIndex)
      } else if (draggedIndex < adjustedDropIndex) {
        if (index > draggedIndex && index <= adjustedDropIndex) {
          newOpenedIndices.add(index - 1)
        } else {
          newOpenedIndices.add(index)
        }
      } else {
        if (index >= adjustedDropIndex && index < draggedIndex) {
          newOpenedIndices.add(index + 1)
        } else {
          newOpenedIndices.add(index)
        }
      }
    })
    openedItemIndices = newOpenedIndices

    DBState.db.promptTemplate = templates
    draggedIndex = -1
    dragOverIndex = -1
  }

  const handleKeyDown = (e: KeyboardEvent) => {
    if (e.ctrlKey && e.altKey && e.key === 'o') {
      if (openedItemIndices.size === DBState.db.promptTemplate.length) {
        openedItemIndices = new Set<number>()
      } else {
        openedItemIndices = new Set(DBState.db.promptTemplate.map((_, i) => i))
      }
    }
  }

  onMount(() => {
    document.addEventListener('keydown', handleKeyDown)
  })

  onDestroy(() => {
    document.removeEventListener('keydown', handleKeyDown)
  })

    // Row-layout field descriptor for SettingRowLayout (label + inline help).
    function field(id: string, label: string, helpKey?: string, helpUnrecommended = false): SettingItem {
        return { id: `promptSettings.${id}`, type: 'custom', fallbackLabel: label, helpKey, helpUnrecommended }
    }
</script>

{#snippet switchRow(id: string, label: string, get: () => boolean | undefined, set: (v: boolean) => void)}
    <SettingRowLayout item={field(id, label)}>
        {#snippet control()}<ShSwitch checked={!!get()} onCheckedChange={set} />{/snippet}
    </SettingRowLayout>
{/snippet}

{#if mode === 'independent'}
    <SettingTabs
        tabs={[
            { label: language.template, value: 0 },
            { label: language.settings, value: 1 },
        ]}
        bind:selected={subMenu}
    />
{/if}
{#if warns.length > 0 && subMenu === 0}
    <ShAlert variant="destructive" className="mt-4">
        {#snippet icon()}<TriangleAlertIcon />{/snippet}
        {#snippet title()}Warning{/snippet}
        <ul class="list-disc pl-4">
            {#each warns as warn}
                <li>{warn}</li>
            {/each}
        </ul>
    </ShAlert>
{/if}

{#if subMenu === 0}
    <div class="contain w-full max-w-full mt-4 flex flex-col p-3 rounded-md">
        {#if DBState.db.promptTemplate.length === 0}
                <div class="text-textcolor2">No Format</div>
        {/if}
        {#key sorted}
            {#each getReorderedTemplate() as { item: prompt, originalIndex, displayIndex }}
                <PromptDataItem
                    bind:promptItem={DBState.db.promptTemplate[originalIndex]}
                    isDragging={draggedIndex === originalIndex}
                    isOpened={openedItemIndices.has(originalIndex)}
                    bind:draggedIndex
                    bind:dragOverIndex
                    bind:openedItemIndices
                    currentIndex={originalIndex}
                    displayIndex={displayIndex}
                    onDrop={handlePromptDrop}
                    onRemove={() => {
                        let templates = DBState.db.promptTemplate
                        templates.splice(originalIndex, 1)
                        DBState.db.promptTemplate = templates

                        const newOpenedIndices = new Set<number>()
                        openedItemIndices.forEach((index) => {
                            if (index === originalIndex) {
                                return
                            } else if (index > originalIndex) {
                                newOpenedIndices.add(index - 1)
                            } else {
                                newOpenedIndices.add(index)
                            }
                        })
                        openedItemIndices = newOpenedIndices

                        draggedIndex = -1
                        dragOverIndex = -1
                    }}
                    moveDown={() => {
                        if(originalIndex === DBState.db.promptTemplate.length - 1){
                            return
                        }
                        let templates = DBState.db.promptTemplate
                        let temp = templates[originalIndex]
                        templates[originalIndex] = templates[originalIndex + 1]
                        templates[originalIndex + 1] = temp
                        DBState.db.promptTemplate = templates

                        const newOpenedIndices = new Set<number>()
                        openedItemIndices.forEach((index) => {
                            if (index === originalIndex) {
                                newOpenedIndices.add(originalIndex + 1)
                            } else if (index === originalIndex + 1) {
                                newOpenedIndices.add(originalIndex)
                            } else {
                                newOpenedIndices.add(index)
                            }
                        })
                        openedItemIndices = newOpenedIndices
                    }}
                    moveUp={() => {
                        if(originalIndex === 0){
                            return
                        }
                        let templates = DBState.db.promptTemplate
                        let temp = templates[originalIndex]
                        templates[originalIndex] = templates[originalIndex - 1]
                        templates[originalIndex - 1] = temp
                        DBState.db.promptTemplate = templates

                        const newOpenedIndices = new Set<number>()
                        openedItemIndices.forEach((index) => {
                            if (index === originalIndex) {
                                newOpenedIndices.add(originalIndex - 1)
                            } else if (index === originalIndex - 1) {
                                newOpenedIndices.add(originalIndex)
                            } else {
                                newOpenedIndices.add(index)
                            }
                        })
                        openedItemIndices = newOpenedIndices
                    }} />
            {/each}
        {/key}
    </div>

    <ShButton variant="outline" size="sm" className="self-start" aria-label="Add prompt item" onclick={() => {
        let value = DBState.db.promptTemplate ?? []
        value.push({
            type: "plain",
            text: "",
            role: "system",
            type2: 'normal'
        })
        DBState.db.promptTemplate = value
    }}><PlusIcon /></ShButton>

    <span class="text-textcolor2 text-sm mt-2">{tokens} {language.fixedTokens}</span>
    <span class="text-textcolor2 mb-6 text-sm mt-2">{extokens} {language.exactTokens}</span>
{:else}
<div class="flex flex-col [&>*:first-child]:border-t-0">
    <SettingRowLayout item={field('postEndInnerFormat', language.postEndInnerFormat, 'postEndInnerFormat')} wideControl>
        {#snippet control()}<TextInput className="sm:w-48 h-8" size="sm" padding fullwidth bind:value={DBState.db.promptSettings.postEndInnerFormat}/>{/snippet}
    </SettingRowLayout>

    {@render switchRow('sendChatAsSystem', language.sendChatAsSystem, () => DBState.db.promptSettings.sendChatAsSystem, (v) => DBState.db.promptSettings.sendChatAsSystem = v)}
    {@render switchRow('sendName', language.formatGroupInSingle, () => DBState.db.promptSettings.sendName, (v) => DBState.db.promptSettings.sendName = v)}
    {@render switchRow('trimStartNewChat', language.trimStartNewChat, () => DBState.db.promptSettings.trimStartNewChat, (v) => DBState.db.promptSettings.trimStartNewChat = v)}
    {@render switchRow('utilOverride', language.utilOverride, () => DBState.db.promptSettings.utilOverride, (v) => DBState.db.promptSettings.utilOverride = v)}
    {@render switchRow('jsonSchemaEnabled', language.enableJsonSchema, () => DBState.db.jsonSchemaEnabled, (v) => DBState.db.jsonSchemaEnabled = v)}
    {@render switchRow('outputImageModal', language.outputImageModal, () => DBState.db.outputImageModal, (v) => DBState.db.outputImageModal = v)}
    {@render switchRow('strictJsonSchema', language.strictJsonSchema, () => DBState.db.strictJsonSchema, (v) => DBState.db.strictJsonSchema = v)}

    {#if DBState.db.showUnrecommended}
        <SettingRowLayout item={field('customChainOfThought', language.customChainOfThought, 'customChainOfThought', true)}>
            {#snippet control()}<ShSwitch checked={!!DBState.db.promptSettings.customChainOfThought} onCheckedChange={(v) => DBState.db.promptSettings.customChainOfThought = v} />{/snippet}
        </SettingRowLayout>
    {/if}
    <SettingRowLayout item={field('maxThoughtTagDepth', language.maxThoughtTagDepth, 'maxThoughtTagDepth')}>
        {#snippet control()}<NumberInput className="w-24" size="sm" padding bind:value={DBState.db.promptSettings.maxThoughtTagDepth}/>{/snippet}
    </SettingRowLayout>

    <div class="py-3 border-t border-darkborderc">
        <SettingFieldLabel label={language.customPromptTemplateToggle} helpKey="customPromptTemplateToggle" />
        <TextAreaInput className="mt-2" bind:value={DBState.db.customPromptTemplateToggle}/>
    </div>
    <div class="py-3 border-t border-darkborderc">
        <SettingFieldLabel label={language.defaultVariables} helpKey="defaultVariables" />
        <TextAreaInput className="mt-2" bind:value={DBState.db.templateDefaultVariables}/>
    </div>
    <div class="py-3 border-t border-darkborderc">
        <SettingFieldLabel label={language.predictedOutput} helpKey="predictedOutput" />
        <TextAreaInput className="mt-2" bind:value={DBState.db.OAIPrediction}/>
    </div>
    <div class="py-3 border-t border-darkborderc">
        <SettingFieldLabel label={language.autoSuggest} helpKey="autoSuggest" />
        <TextAreaInput className="mt-2" bind:value={DBState.db.autoSuggestPrompt} placeholder={defaultAutoSuggestPrompt}/>
    </div>
    <div class="py-3 border-t border-darkborderc">
        <SettingFieldLabel label={language.groupInnerFormat} helpKey="groupInnerFormat" />
        <TextAreaInput className="mt-2" placeholder={`<{{char}}\'s Message>\n{{slot}}\n</{{char}}\'s Message>`} bind:value={DBState.db.groupTemplate}/>
    </div>
    <div class="py-3 border-t border-darkborderc">
        <SettingFieldLabel label={language.systemContentReplacement} helpKey="systemContentReplacement" />
        <TextAreaInput className="mt-2" bind:value={DBState.db.systemContentReplacement}/>
    </div>
    <SettingRowLayout item={field('systemRoleReplacement', language.systemRoleReplacement, 'systemRoleReplacement')}>
        {#snippet control()}
    <SelectInput className="w-48" size="sm" bind:value={DBState.db.systemRoleReplacement}>
        <OptionInput value="user">User</OptionInput>
        <OptionInput value="assistant">assistant</OptionInput>
    </SelectInput>
        {/snippet}
    </SettingRowLayout>
    {#if DBState.db.jsonSchemaEnabled}
        <div class="py-3 border-t border-darkborderc">
            <SettingFieldLabel label={language.jsonSchema} helpKey="jsonSchema" />
            <TextAreaInput className="mt-2" bind:value={DBState.db.jsonSchema}/>
        </div>
        <SettingRowLayout item={field('extractJson', language.extractJson, 'extractJson')} wideControl>
            {#snippet control()}<TextInput className="sm:w-48 h-8" size="sm" padding fullwidth bind:value={DBState.db.extractJson}/>{/snippet}
        </SettingRowLayout>
    {/if}


    {#snippet fallbackModelList(arg:'model'|'memory'|'translate'|'emotion'|'otherAx')}
        {#each DBState.db.fallbackModels[arg] as model, i}
            <span class="text-sm text-textcolor mt-2">
                {language.model} {i + 1}
            </span>
            <ModelList bind:value={DBState.db.fallbackModels[arg][i]} blankable />
        {/each}
        <div class="flex gap-2 mt-2">
            <ShButton variant="outline" size="icon-sm" aria-label="Add fallback model" onclick={() => {
                let value = DBState.db.fallbackModels[arg] ?? []
                value.push('')
                DBState.db.fallbackModels[arg] = value
            }}><PlusIcon /></ShButton>
            <ShButton variant="destructive" size="icon-sm" aria-label="Remove last fallback model" onclick={() => {
                let value = DBState.db.fallbackModels[arg] ?? []
                value.pop()
                DBState.db.fallbackModels[arg] = value
            }}><TrashIcon /></ShButton>
        </div>
    {/snippet}

    <div class="pt-3 border-t border-darkborderc">
    <ShAccordion name={language.fallbackModel} variant="card">
        <div class="flex flex-col [&>*:first-child]:border-t-0">
            {@render switchRow('fallbackWhenBlankResponse', language.fallbackWhenBlankResponse, () => DBState.db.fallbackWhenBlankResponse, (v) => DBState.db.fallbackWhenBlankResponse = v)}
            {@render switchRow('doNotChangeFallbackModels', language.doNotChangeFallbackModels, () => DBState.db.doNotChangeFallbackModels, (v) => DBState.db.doNotChangeFallbackModels = v)}
        </div>
        <div class="flex flex-col gap-2 mt-2">
            <ShAccordion name={language.model} variant="card">
                <div class="flex flex-col">{@render fallbackModelList('model')}</div>
            </ShAccordion>
            <ShAccordion name={"Memory"} variant="card">
                <div class="flex flex-col">{@render fallbackModelList('memory')}</div>
            </ShAccordion>
            <ShAccordion name={"Translations"} variant="card">
                <div class="flex flex-col">{@render fallbackModelList('translate')}</div>
            </ShAccordion>
            <ShAccordion name={"Emotion"} variant="card">
                <div class="flex flex-col">{@render fallbackModelList('emotion')}</div>
            </ShAccordion>
            <ShAccordion name={"OtherAx"} variant="card">
                <div class="flex flex-col">{@render fallbackModelList('otherAx')}</div>
            </ShAccordion>
        </div>
    </ShAccordion>
    </div>
</div>
{/if}

<script lang="ts">
    import SettingFieldLabel from "src/lib/Setting/Wrappers/SettingFieldLabel.svelte";
    import { DBState } from 'src/ts/stores.svelte';
    import { language } from "src/lang";
    import { LLMFlags, LLMFormat, LLMTokenizer } from "src/ts/model/types";
    import ShButton from "src/lib/UI/GUI/ShButton.svelte";
    import ShToggle from "src/lib/UI/GUI/ShToggle.svelte";
    import ShAccordion from "src/lib/UI/GUI/ShAccordion.svelte";
    import SettingRowLayout from "src/lib/Setting/Wrappers/SettingRowLayout.svelte";
    import type { SettingItem } from "src/ts/setting/types";
    import TextInput from "src/lib/UI/GUI/TextInput.svelte";
    import TextAreaInput from "src/lib/UI/GUI/TextAreaInput.svelte";
    import SelectInput from "src/lib/UI/GUI/SelectInput.svelte";
    import OptionInput from "src/lib/UI/GUI/OptionInput.svelte";
    import { requestImmediateSave } from "src/ts/globalApi.svelte";
    import { PlusIcon, TrashIcon, ArrowUp, ArrowDown } from "@lucide/svelte";
    import { v4 } from "uuid";

    let openedModels = $state(new Set<string>());

    let { noAccordion }:{
        noAccordion?: boolean,
    } = $props()

    // Row-layout field descriptor for SettingRowLayout (label only here).
    function f(id: string, label: string, helpKey?: string): SettingItem {
        return { id: `customModels.${id}`, type: 'custom', fallbackLabel: label, helpKey }
    }
</script>


{#snippet CustomFlagButton(index:number,name:string,flag:LLMFlags)}
    <ShToggle size="sm" pressed={DBState.db.customModels[index].flags.includes(flag)} onPressedChange={() => {
        if(DBState.db.customModels[index].flags.includes(flag)){
            DBState.db.customModels[index].flags = DBState.db.customModels[index].flags.filter((f) => f !== flag)
        }
        else{
            DBState.db.customModels[index].flags.push(flag)
        }
    }}>
        {name}
    </ShToggle>
{/snippet}

{#snippet mainBody()}
    {#each DBState.db.customModels as model, index (model.id)}
        <div class="flex flex-col mt-2 rounded-md border border-darkborderc overflow-hidden">
            <div class="flex items-center justify-between gap-2 pr-2" class:bg-selected={openedModels.has(model.id)}>
            <button class="grow min-w-0 text-left px-3 h-11 text-base font-medium hover:bg-selected/30 truncate"
                aria-expanded={openedModels.has(model.id)}
                onclick={() => {
                    if (openedModels.has(model.id)) {
                        openedModels.delete(model.id)
                    } else {
                        openedModels.add(model.id)
                    }
                    openedModels = new Set(openedModels)
                }}
            >
                {model.name ?? "Unnamed"}
            </button>
                <div class="flex items-center gap-1 shrink-0">
                    <ShButton variant="ghost" size="icon-sm" aria-label="Move up" onclick={(e) => {
                        e.stopPropagation()
                        if(index === 0) return
                        let models = DBState.db.customModels
                        let temp = models[index]
                        models[index] = models[index - 1]
                        models[index - 1] = temp
                        DBState.db.customModels = models
                        void requestImmediateSave()
                    }}>
                        <ArrowUp />
                    </ShButton>
                    <ShButton variant="ghost" size="icon-sm" aria-label="Move down" onclick={(e) => {
                        e.stopPropagation()
                        if(index === DBState.db.customModels.length - 1) return
                        let models = DBState.db.customModels
                        let temp = models[index]
                        models[index] = models[index + 1]
                        models[index + 1] = temp
                        DBState.db.customModels = models
                        void requestImmediateSave()
                    }}>
                        <ArrowDown />
                    </ShButton>
                    <ShButton variant="ghost" size="icon-sm" className="hover:text-red-400" aria-label="Delete" onclick={(e) => {
                        e.stopPropagation()
                        let models = DBState.db.customModels
                        models.splice(index, 1)
                        DBState.db.customModels = models
                        openedModels.delete(model.id)
                        openedModels = new Set(openedModels)
                        void requestImmediateSave()
                    }}>
                        <TrashIcon />
                    </ShButton>
                </div>
            </div>
            {#if openedModels.has(model.id)}
            <div class="flex flex-col border-t border-darkborderc px-3 pb-3 overflow-x-auto [&>*:first-child]:border-t-0">
            <SettingRowLayout item={f('cm1', `${language.name}`)} wideControl>
    {#snippet control()}<TextInput className="sm:w-64 h-8" size="sm" padding fullwidth bind:value={DBState.db.customModels[index].name}/>{/snippet}
</SettingRowLayout>
            <SettingRowLayout item={f('cm2', `${language.proxyRequestModel}`)} wideControl>
    {#snippet control()}<TextInput className="sm:w-64 h-8" size="sm" padding fullwidth bind:value={DBState.db.customModels[index].internalId}/>{/snippet}
</SettingRowLayout>
            <SettingRowLayout item={f('cm3', `URL`)} wideControl>
    {#snippet control()}<TextInput className="sm:w-64 h-8" size="sm" padding fullwidth bind:value={DBState.db.customModels[index].url}/>{/snippet}
</SettingRowLayout>
            <SettingRowLayout item={f('cm5', `${language.tokenizer}`)}>
    {#snippet control()}
    <SelectInput className="w-48" size="sm" value={DBState.db.customModels[index].tokenizer.toString()} onchange={(e) => {
                DBState.db.customModels[index].tokenizer = parseInt(e.currentTarget.value) as LLMTokenizer
            }}>
                <OptionInput value="0">Unknown</OptionInput>
                <OptionInput value="1">tiktokenCl100kBase</OptionInput>
                <OptionInput value="2">tiktokenO200Base</OptionInput>
                <OptionInput value="3">Mistral</OptionInput>
                <OptionInput value="4">Llama</OptionInput>
                <OptionInput value="5">NovelAI</OptionInput>
                <OptionInput value="6">Claude</OptionInput>
                <OptionInput value="7">NovelList</OptionInput>
                <OptionInput value="8">Llama3</OptionInput>
                <OptionInput value="9">Gemma</OptionInput>
                <OptionInput value="10">GoogleCloud</OptionInput>
                <OptionInput value="11">Cohere</OptionInput>
                <OptionInput value="13">DeepSeek</OptionInput>
            </SelectInput>
    {/snippet}
</SettingRowLayout>
            <SettingRowLayout item={f('cm6', `${language.format}`)}>
    {#snippet control()}
    <SelectInput className="w-48" size="sm" value={DBState.db.customModels[index].format.toString()} onchange={(e) => {
                DBState.db.customModels[index].format = parseInt(e.currentTarget.value) as LLMFormat
            }}>
                <OptionInput value="0">OpenAICompatible</OptionInput>
                <OptionInput value="1">OpenAILegacyInstruct</OptionInput>
                <OptionInput value="2">Anthropic</OptionInput>
                <OptionInput value="3">AnthropicLegacy</OptionInput>
                <OptionInput value="4">Mistral</OptionInput>
                <OptionInput value="5">GoogleCloud</OptionInput>
                <OptionInput value="6">VertexAIGemini</OptionInput>
                <OptionInput value="7">NovelList</OptionInput>
                <OptionInput value="8">Cohere</OptionInput>
                <OptionInput value="9">NovelAI</OptionInput>
                <OptionInput value="11">OobaLegacy</OptionInput>
                <OptionInput value="13">Ooba</OptionInput>
                <OptionInput value="14">Kobold</OptionInput>
                <OptionInput value="17">AWSBedrockClaude</OptionInput>
                <OptionInput value="18">OpenAIResponseAPI</OptionInput>
            </SelectInput>
    {/snippet}
</SettingRowLayout>
            <SettingRowLayout item={f('cm4', `${language.proxyAPIKey}`)} wideControl>
    {#snippet control()}<TextInput className="sm:w-64 h-8" size="sm" padding fullwidth bind:value={DBState.db.customModels[index].key}/>{/snippet}
</SettingRowLayout>
            <div class="py-3 border-t border-darkborderc flex flex-col">
    <SettingFieldLabel label={`${language.additionalParams}`} />
    <TextAreaInput className="mt-2" bind:value={DBState.db.customModels[index].params} placeholder={`temperature=0.7
    max_tokens=2000
    reasoning_effort="high"
    header::anthropic-dangerous-direct-browser-access=true
    stop=json::["</s>", "\\n\\n"]
    frequency_penalty={{none}}`}/>
</div>
            <div class="pt-3 border-t border-darkborderc">
            <ShAccordion name={language.flags} variant="card">
                <div class="flex flex-wrap gap-1.5 py-1">
                {@render CustomFlagButton(index,'hasImageInput', 0)}
                {@render CustomFlagButton(index,'hasImageOutput', 1)}
                {@render CustomFlagButton(index,'hasAudioInput', 2)}
                {@render CustomFlagButton(index,'hasAudioOutput', 3)}
                {@render CustomFlagButton(index,'hasPrefill', 4)}
                {@render CustomFlagButton(index,'hasCache', 5)}
                {@render CustomFlagButton(index,'hasFullSystemPrompt', 6)}
                {@render CustomFlagButton(index,'hasFirstSystemPrompt', 7)}
                {@render CustomFlagButton(index,'hasStreaming', 8)}
                {@render CustomFlagButton(index,'requiresAlternateRole', 9)}
                {@render CustomFlagButton(index,'mustStartWithUserInput', 10)}
                {@render CustomFlagButton(index,'hasVideoInput', 12)}
                {@render CustomFlagButton(index,'OAICompletionTokens', 13)}
                {@render CustomFlagButton(index,'DeveloperRole', 14)}
                {@render CustomFlagButton(index,'geminiThinking', 15)}
                {@render CustomFlagButton(index,'geminiBlockOff', 16)}
                {@render CustomFlagButton(index,'deepSeekPrefix', 17)}
                {@render CustomFlagButton(index,'deepSeekThinkingInput', 18)}
                {@render CustomFlagButton(index,'deepSeekThinkingOutput', 19)}
                </div>
            </ShAccordion>
            </div>
                </div>
            {/if}
        </div>
    {/each}
    <div class="flex flex-col mt-2">
        <ShButton variant="outline" className="w-full" aria-label="Add custom model" onclick={() => {
            DBState.db.customModels.push({
                internalId: "",
                url: "",
                tokenizer: 0,
                format: 0,
                id: 'xcustom:::' + v4(),
                key: "",
                name: "Custom Model",
                params: "",
                flags: [],
            })
            void requestImmediateSave()
        }}>
            <PlusIcon />
        </ShButton>
    </div>
    
{/snippet}


{#if noAccordion}
    {@render mainBody()}
{:else}
    <ShAccordion name={language.customModels} variant="card">
        {@render mainBody()}
    </ShAccordion>

{/if}

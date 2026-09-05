<script lang="ts">
    import Check from "src/lib/UI/GUI/CheckInput.svelte";
    import SettingPage from "src/lib/UI/GUI/SettingPage.svelte";
    import SettingTabs from "src/lib/UI/GUI/SettingTabs.svelte";
    import { language } from "src/lang";
    import Help from "src/lib/Others/Help.svelte";
    import { selectSingleFile } from "src/ts/util";
    import { DBState, OtherBotsSubmenuIndex } from 'src/ts/stores.svelte';
    import { saveAsset, globalFetch } from "src/ts/globalApi.svelte";
    import NumberInput from "src/lib/UI/GUI/NumberInput.svelte";
    import TextInput from "src/lib/UI/GUI/TextInput.svelte";
    import SelectInput from "src/lib/UI/GUI/SelectInput.svelte";
    import OptionInput from "src/lib/UI/GUI/OptionInput.svelte";
    import SliderInput from "src/lib/UI/GUI/SliderInput.svelte";
    import { getCharImage } from "src/ts/characters";
    import Accordion from "src/lib/UI/Accordion.svelte";
    import CheckInput from "src/lib/UI/GUI/CheckInput.svelte";
    import { alertError, notifySuccess, notifyError } from "src/ts/alert";



    // wavespeed
    interface WavespeedModel {
        model_id: string;
        name: string;
        base_price: number;
        supportsImageInput: boolean;
        supportsLoras: boolean;
    }
    interface LoraItem {
        path: string;
        scale: number;
    }
    let wavespeedModels = $state<WavespeedModel[]>([]);
    let isWavespeedLoading = $state(false);
    let wavespeedSearchQuery = $state("");
    let wavespeedLoras = $state<LoraItem[]>([
        { path: "", scale: 1.0 },
        { path: "", scale: 1.0 },
        { path: "", scale: 1.0 }
    ]);

    /**
     * Fetch models from WaveSpeed API dynamically
     * https://wavespeed.ai/docs/docs-common-api/models
     */
    async function fetchWavespeedModels() {
        if (!DBState.db.wavespeedImage.key || DBState.db.wavespeedImage.key.trim() === '') {
            notifyError('WaveSpeed API Key not set');
            return [];
        }

        isWavespeedLoading = true;
        try {
            const result = await globalFetch('https://api.wavespeed.ai/api/v3/models', {
                method: 'GET',
                headers: {
                    'Authorization': `Bearer ${DBState.db.wavespeedImage.key}`
                },
            });

            if (!result.ok || !result.data) {
                notifyError('Failed to fetch WaveSpeed models');
                return;
            }

            let responseData;
            try {
                responseData = typeof result.data === 'string' ? JSON.parse(result.data) : result.data;
            } catch (e) {
                notifyError('Failed to parse WaveSpeed response');
                return;
            }

            if (responseData.code !== 200 || !Array.isArray(responseData.data)) {
                notifyError('Invalid WaveSpeed API response');
                return;
            }

            // Filter, transform, and sort models by name
            const filteredModels: WavespeedModel[] = responseData.data
              .filter((model: any) =>
                model.type === 'text-to-image' || model.type === 'image-to-image'
              )
              .map((model: any) => {
                  // Check if model supports LoRAs
                  const supportsLoras = model.api_schema?.api_schemas?.some((schema: any) =>
                    schema.request_schema?.properties?.loras !== undefined
                  ) ?? false;

                  return {
                      model_id: model.model_id,
                      name: model.name,
                      base_price: model.base_price,
                      type: model.type,
                      supportsImageInput: model.type === 'image-to-image',
                      supportsLoras: supportsLoras,
                  };
              })
              .sort((a, b) => a.name.localeCompare(b.model_id));

            wavespeedModels = filteredModels;
            notifySuccess(`Successfully loaded ${filteredModels.length} models`);
        } catch (error) {
            notifyError(`Failed to fetch models: ${error}`);
        } finally {
            isWavespeedLoading = false;
        }
    }

    /**
     * Handle model selection change
     */
    function handleModelChange() {
        const selectedModel = wavespeedModels.find(m => m.model_id === DBState.db.wavespeedImage.model);

        // Reset reference_mode for text-to-image models
        if (selectedModel?.supportsImageInput) {
            DBState.db.wavespeedImage.reference_mode = '';
            DBState.db.wavespeedImage.reference_image = undefined;
            DBState.db.wavespeedImage.reference_base64image = undefined;
        }

        // Reset loras if model doesn't support them
        if (!selectedModel?.supportsLoras) {
            DBState.db.wavespeedImage.loras = undefined;
        }
    }

    /**
     * Get display name for a WaveSpeed model
     * @param model - The model to get display name for
     */
    function getModelDisplayName(model: WavespeedModel): string {
        const imageInputIcon = model.supportsImageInput ? '✓' : '✗';
        const loraIcon = model.supportsLoras ? '✓' : '✗';
        return `${model.name} (price: ${model.base_price}) [${imageInputIcon} Image] [${loraIcon} LoRA]`;
    }

    /**
     * Filter and sort models based on search query
     */
    function getFilteredModels(): WavespeedModel[] {
        if (wavespeedSearchQuery === "") return wavespeedModels;

        const searchTerms = wavespeedSearchQuery.toLowerCase().trim().split(/\s+/);
        return wavespeedModels.filter(model => {
            const modelText = (model.name + " " + model.model_id).toLowerCase();
            return searchTerms.every(term => modelText.includes(term));
        });
    }

    $effect(() => {
        // Sync loras to DB, filtering out empty URLs
        if (DBState.db.wavespeedImage) {
            DBState.db.wavespeedImage.loras = wavespeedLoras
              .filter(item => item.path && item.path.trim() !== "")
              .map(item => ({
                  path: item.path,
                  scale: item.scale
              }));
        }
    });
    // End wavespeed
</script>
<SettingPage title={language.otherBots}>
<SettingTabs tabs={[
    { label: 'TTS', value: 1 },
    { label: language.emotionImage, value: 2 },
    { label: language.imageGeneration, value: 3 },
]} bind:selected={$OtherBotsSubmenuIndex} />

{#if $OtherBotsSubmenuIndex === 3}
    <Accordion name={language.imageGeneration} styled disabled>
        <span class="text-textcolor mt-2">{language.imageGeneration} {language.provider} <Help key="sdProvider"/></span>
        <SelectInput className="mt-2 mb-4" bind:value={DBState.db.sdProvider}>
            <OptionInput value="" >None</OptionInput>
            <OptionInput value="webui" >Stable Diffusion WebUI</OptionInput>
            <OptionInput value="novelai" >Novel AI</OptionInput>
            <OptionInput value="dalle" >Dall-E</OptionInput>
            <OptionInput value="stability" >Stability API</OptionInput>
            <OptionInput value="fal" >Fal.ai</OptionInput>
            <OptionInput value="comfyui" >ComfyUI</OptionInput>
            <OptionInput value="Imagen" >Imagen</OptionInput>
            <OptionInput value="openai-compat" >OpenAI Compatible</OptionInput>
            <OptionInput value="wavespeed" >WaveSpeedAI</OptionInput>

            <!-- Legacy -->
            {#if DBState.db.sdProvider === 'comfy'}
                <OptionInput value="comfy" >ComfyUI (Legacy)</OptionInput>
            {/if}
        </SelectInput>

        {#if DBState.db.sdProvider === 'webui'}
        <span class="text-draculared text-xs mb-2">You must use WebUI with --api flag</span>
            <span class="text-draculared text-xs mb-2">You must use WebUI without agpl license or use unmodified version with agpl license to observe the contents of the agpl license.</span>
            <span class="text-textcolor mt-2">WebUI {language.providerURL} <Help key="webuiUrl"/></span>
            <TextInput className="mt-2" marginBottom placeholder="https://..." bind:value={DBState.db.webUiUrl}/>
            <span class="text-textcolor">Steps <Help key="webuiSteps"/></span>
            <NumberInput className="mt-2" marginBottom min={0} max={100} bind:value={DBState.db.sdSteps}/>

            <span class="text-textcolor">CFG Scale <Help key="webuiCFG"/></span>
            <NumberInput className="mt-2" marginBottom min={0} max={20} bind:value={DBState.db.sdCFG}/>

            <span class="text-textcolor">Width <Help key="webuiWidth"/></span>
            <NumberInput className="mt-2" marginBottom min={0} max={2048} bind:value={DBState.db.sdConfig.width}/>
            <span class="text-textcolor">Height <Help key="webuiHeight"/></span>
            <NumberInput className="mt-2" marginBottom min={0} max={2048} bind:value={DBState.db.sdConfig.height}/>
            <span class="text-textcolor">Sampler <Help key="webuiSampler"/></span>
            <TextInput className="mt-2" marginBottom bind:value={DBState.db.sdConfig.sampler_name}/>

            <div class="flex items-center mt-2">
                <Check bind:check={DBState.db.sdConfig.enable_hr} name='Enable Hires'/>
                <Help key="webuiEnableHr"/>
            </div>
            {#if DBState.db.sdConfig.enable_hr === true}
                <span class="text-textcolor">denoising_strength <Help key="webuiDenoising"/></span>
                <NumberInput className="mt-2" marginBottom min={0} max={10} bind:value={DBState.db.sdConfig.denoising_strength}/>
                <span class="text-textcolor">hr_scale <Help key="webuiHrScale"/></span>
                <NumberInput className="mt-2" marginBottom min={0} max={10} bind:value={DBState.db.sdConfig.hr_scale}/>
                <span class="text-textcolor">Upscaler <Help key="webuiUpscaler"/></span>
                <TextInput className="mt-2" marginBottom bind:value={DBState.db.sdConfig.hr_upscaler}/>
            {/if}
        {/if}

        {#if DBState.db.sdProvider === 'novelai'}
            <span class="text-textcolor mt-2">Novel AI {language.providerURL} <Help key="naiImgUrl"/></span>
            <TextInput className="mt-2" marginBottom placeholder="https://image.novelai.net" bind:value={DBState.db.NAIImgUrl}/>
            <span class="text-textcolor">API Key <Help key="naiImgKey"/></span>
            <TextInput className="mt-2" marginBottom placeholder="pst-..." bind:value={DBState.db.NAIApiKey}/>

            <span class="text-textcolor">Model <Help key="naiModel"/></span>
            <SelectInput className="mt-2 mb-4" bind:value={DBState.db.NAIImgModel} >
                <OptionInput value="nai-diffusion-5-full" >nai-diffusion-5-full</OptionInput>
                <OptionInput value="nai-diffusion-5-curated" >nai-diffusion-5-curated</OptionInput>
                <OptionInput value="nai-diffusion-4-5-full" >nai-diffusion-4-5-full</OptionInput>
                <OptionInput value="nai-diffusion-4-5-curated" >nai-diffusion-4-5-curated</OptionInput>
                <OptionInput value="nai-diffusion-4-full" >nai-diffusion-4-full</OptionInput>
                <OptionInput value="nai-diffusion-4-curated-preview" >nai-diffusion-4-curated-preview</OptionInput>
                <OptionInput value="nai-diffusion-3" >nai-diffusion-3</OptionInput>
                <OptionInput value="nai-diffusion-furry-3" >nai-diffusion-furry-3</OptionInput>
                <OptionInput value="nai-diffusion-2" >nai-diffusion-2</OptionInput>

            </SelectInput>

            <span class="text-textcolor">Width <Help key="naiWidth"/></span>
            <NumberInput className="mt-2" marginBottom min={0} max={2048} bind:value={DBState.db.NAIImgConfig.width}/>
            <span class="text-textcolor">Height <Help key="naiHeight"/></span>
            <NumberInput className="mt-2" marginBottom min={0} max={2048} bind:value={DBState.db.NAIImgConfig.height}/>
            <span class="text-textcolor">Sampler <Help key="naiSampler"/></span>

            {#if DBState.db.NAIImgModel === 'nai-diffusion-4-full'
            || DBState.db.NAIImgModel === 'nai-diffusion-4-curated-preview'
            || DBState.db.NAIImgModel === 'nai-diffusion-4-5-full'
            || DBState.db.NAIImgModel === 'nai-diffusion-4-5-curated'
            || DBState.db.NAIImgModel === 'nai-diffusion-5-full'
            || DBState.db.NAIImgModel === 'nai-diffusion-5-curated'}
                <SelectInput className="mt-2 mb-4" bind:value={DBState.db.NAIImgConfig.sampler}>
                    <OptionInput value="k_euler_ancestral" >Euler Ancestral</OptionInput>
                    <OptionInput value="k_dpmpp_2s_ancestral" >DPM++ 2S Ancestral</OptionInput>
                    <OptionInput value="k_dpmpp_2m_sde" >DPM++ 2M SDE</OptionInput>
                    <OptionInput value="k_euler" >Euler</OptionInput>
                    <OptionInput value="k_dpmpp_2m" >DPM++ 2M</OptionInput>
                    <OptionInput value="k_dpmpp_sde" >DPM++ SDE</OptionInput>
                </SelectInput>
            {:else}
                <SelectInput className="mt-2 mb-4" bind:value={DBState.db.NAIImgConfig.sampler}>
                    <OptionInput value="k_euler_ancestral" >Euler Ancestral</OptionInput>
                    <OptionInput value="k_dpmpp_2s_ancestral" >DPM++ 2S Ancestral</OptionInput>
                    <OptionInput value="k_dpmpp_sde" >DPM++ SDE</OptionInput>
                    <OptionInput value="k_euler" >Euler</OptionInput>
                    <OptionInput value="k_dpmpp_2m" >DPM++ 2M</OptionInput>
                    <OptionInput value="k_dpmpp_2s" >DPM++ 2S</OptionInput>
                    <OptionInput value="ddim_v3" >DDIM</OptionInput>
                </SelectInput>
            {/if}

            <span class="text-textcolor">Noise Schedule <Help key="naiNoiseSchedule"/></span>
            <SelectInput className="mt-2 mb-4" bind:value={DBState.db.NAIImgConfig.noise_schedule}>
                <OptionInput value="native" >native</OptionInput>
                <OptionInput value="karras" >karras</OptionInput>
                <OptionInput value="exponential" >exponential</OptionInput>
                <OptionInput value="polyexponential" >polyexponential</OptionInput>
            </SelectInput>

            <span class="text-textcolor">steps <Help key="naiSteps"/></span>
            <NumberInput className="mt-2" marginBottom min={0} max={2048} bind:value={DBState.db.NAIImgConfig.steps}/>
            <span class="text-textcolor">CFG scale <Help key="naiCFG"/></span>
            <NumberInput className="mt-2" marginBottom min={0} max={2048} bind:value={DBState.db.NAIImgConfig.scale}/>
            <span class="text-textcolor">CFG rescale <Help key="naiCFGRescale"/></span>
            <NumberInput className="mt-2" marginBottom min={0} max={1} bind:value={DBState.db.NAIImgConfig.cfg_rescale}/>

            <span class="text-textcolor">Image Reference <Help key="naiImageReference"/></span>
            <SelectInput className="mt-2 mb-4" bind:value={DBState.db.NAIImgConfig.reference_mode}>
                <OptionInput value="" >None</OptionInput>
                {#if DBState.db.NAIImgModel !== 'nai-diffusion-5-full' && DBState.db.NAIImgModel !== 'nai-diffusion-5-curated'}
                    <OptionInput value="vibe" >Vibe Trasfer</OptionInput>
                {/if}
                {#if DBState.db.NAIImgModel === 'nai-diffusion-4-5-full' || DBState.db.NAIImgModel === 'nai-diffusion-4-5-curated'}
                    <OptionInput value="character" >Character Reference</OptionInput>
                {/if}
            </SelectInput>

            {#if DBState.db.NAIImgConfig.reference_mode === 'vibe'
                && DBState.db.NAIImgModel !== 'nai-diffusion-5-full' && DBState.db.NAIImgModel !== 'nai-diffusion-5-curated'}
                <div class="relative">
                <button class="mb-4" onclick={async () => {
                    const file = await selectSingleFile(['naiv4vibe'])
                    if(!file){
                        return null
                    }
                    try {
                        const vibeData = JSON.parse(new TextDecoder().decode(file.data))
                        if (vibeData.version !== 1 || vibeData.identifier !== "novelai-vibe-transfer") {
                            alertError("Invalid vibe file. Version must be 1.")
                            return
                        }

                        // Store the vibe data
                        DBState.db.NAIImgConfig.vibe_data = vibeData

                        // Set the thumbnail as preview image for display
                        if (vibeData.thumbnail) {
                            // Clear the array and add the thumbnail
                            DBState.db.NAIImgConfig.reference_image_multiple = [];

                            // Set default model selection based on current model
                            if (DBState.db.NAIImgModel.includes('nai-diffusion-4-full')) {
                                DBState.db.NAIImgConfig.vibe_model_selection = 'v4full';
                            } else if (DBState.db.NAIImgModel.includes('nai-diffusion-4-curated')) {
                                DBState.db.NAIImgConfig.vibe_model_selection = 'v4curated';
                            } else if (DBState.db.NAIImgModel.includes('nai-diffusion-4-5-full')) { 
                                DBState.db.NAIImgConfig.vibe_model_selection = 'v4-5full';
                            } else if (DBState.db.NAIImgModel.includes('nai-diffusion-4-5-curated')) {
                                DBState.db.NAIImgConfig.vibe_model_selection = 'v4-5curated';
                            }

                            // Set InfoExtracted to the first value for the selected model
                            const selectedModel = DBState.db.NAIImgConfig.vibe_model_selection;
                            if (selectedModel && vibeData.encodings[selectedModel]) {
                                const encodings = vibeData.encodings[selectedModel];
                                const firstKey = Object.keys(encodings)[0];
                                if (firstKey) {
                                    DBState.db.NAIImgConfig.InfoExtracted = Number(encodings[firstKey].params.information_extracted);
                                }
                            }
                        }

                        // Initialize reference_strength_multiple if not set
                        if (!DBState.db.NAIImgConfig.reference_strength_multiple || !Array.isArray(DBState.db.NAIImgConfig.reference_strength_multiple)) {
                            DBState.db.NAIImgConfig.reference_strength_multiple = [0.7];
                        }
                    } catch (error) {
                        alertError("Error parsing vibe file: " + error)
                    }
                }}>
                    {#if !DBState.db.NAIImgConfig.vibe_data || !DBState.db.NAIImgConfig.vibe_data.thumbnail}
                        <div class="rounded-md h-20 w-20 shadow-lg bg-textcolor2 cursor-pointer hover:text-primary flex items-center justify-center">
                            <span class="text-sm">Upload<br />Vibe</span>
                        </div>
                    {:else}
                        <img src={DBState.db.NAIImgConfig.vibe_data.thumbnail} alt="Vibe Preview" class="rounded-md h-40 shadow-lg bg-textcolor2 cursor-pointer hover:text-primary" />
                    {/if}
                </button>

                {#if DBState.db.NAIImgConfig.vibe_data}
                    <button 
                        onclick={() => {
                            DBState.db.NAIImgConfig.vibe_data = undefined;
                            DBState.db.NAIImgConfig.vibe_model_selection = undefined;
                        }}
                        class="absolute top-2 right-2 bg-red-500 hover:bg-red-700 text-white font-bold py-1 px-2 rounded-sm"
                    >
                        Delete
                    </button>
                {/if}

                </div>

                {#if DBState.db.NAIImgConfig.vibe_data}

                    <span class="text-textcolor">Vibe Model <Help key="naiVibeModel"/></span>
                    <SelectInput className="mt-2 mb-2" bind:value={DBState.db.NAIImgConfig.vibe_model_selection} onchange={(e) => {
                        // When vibe model changes, set InfoExtracted to the first value
                        if (DBState.db.NAIImgConfig.vibe_data?.encodings &&
                            DBState.db.NAIImgConfig.vibe_model_selection &&
                            DBState.db.NAIImgConfig.vibe_data.encodings[DBState.db.NAIImgConfig.vibe_model_selection]) {
                            const encodings = DBState.db.NAIImgConfig.vibe_data.encodings[DBState.db.NAIImgConfig.vibe_model_selection];
                            const firstKey = Object.keys(encodings)[0];
                            if (firstKey) {
                                DBState.db.NAIImgConfig.InfoExtracted = Number(encodings[firstKey].params.information_extracted);
                            }
                        }
                    }}>
                        {#if DBState.db.NAIImgConfig.vibe_data.encodings?.v4full}
                            <OptionInput value="v4full">nai-diffusion-4-full</OptionInput>
                        {/if}
                        {#if DBState.db.NAIImgConfig.vibe_data.encodings?.v4curated}
                            <OptionInput value="v4curated">nai-diffusion-4-curated</OptionInput>
                        {/if}
                        {#if DBState.db.NAIImgConfig.vibe_data.encodings?.['v4-5full']}
                            <OptionInput value="v4-5full">nai-diffusion-4-5-full</OptionInput>
                        {/if}
                        {#if DBState.db.NAIImgConfig.vibe_data.encodings?.['v4-5curated']}
                            <OptionInput value="v4-5curated">nai-diffusion-4-5-curated</OptionInput>
                        {/if}
                    </SelectInput>

                    <span class="text-textcolor">Information Extracted <Help key="naiInfoExtracted"/></span>
                    <SelectInput className="mt-2 mb-2" bind:value={DBState.db.NAIImgConfig.InfoExtracted}>
                        {#if DBState.db.NAIImgConfig.vibe_model_selection && DBState.db.NAIImgConfig.vibe_data.encodings[DBState.db.NAIImgConfig.vibe_model_selection]}
                            {#each Object.entries(DBState.db.NAIImgConfig.vibe_data.encodings[DBState.db.NAIImgConfig.vibe_model_selection]) as [key, value]}
                                <OptionInput value={value.params.information_extracted}>{value.params.information_extracted}</OptionInput>
                            {/each}
                        {/if}
                    </SelectInput>

                    <span class="text-textcolor">Reference Strength Multiple <Help key="naiRefStrength"/></span>
                    <SliderInput className="mt-2" marginBottom min={0} max={1} step={0.1} fixed={2} bind:value={DBState.db.NAIImgConfig.reference_strength_multiple[0]} />
                {/if}
            {/if}

            {#if DBState.db.NAIImgConfig.reference_mode === 'character' && 
                (DBState.db.NAIImgModel === 'nai-diffusion-4-5-full' || DBState.db.NAIImgModel === 'nai-diffusion-4-5-curated')}
                
                <div class="relative">
                    <button class="mb-2" onclick={async () => {
                        const img = await selectSingleFile([
                            'jpg',
                            'jpeg',
                            'png',
                            'webp'
                        ])
                        if(!img){
                            return null
                        }
                        
                        const imageData = img.data;
                        
                        DBState.db.NAIImgConfig.character_base64image = Buffer.from(imageData).toString('base64');
                        const saveId = await saveAsset(imageData)
                        DBState.db.NAIImgConfig.character_image = saveId
                        console.log('Character image set:', DBState.db.NAIImgConfig.character_image)
                    }}>
                        {#if !DBState.db.NAIImgConfig.character_image || DBState.db.NAIImgConfig.character_image === ''}
                            <div class="rounded-md h-20 w-20 shadow-lg bg-textcolor2 cursor-pointer hover:text-primary flex items-center justify-center">
                                <span class="text-sm">Upload<br />Image</span>
                            </div>
                        {:else}
                            {#await getCharImage(DBState.db.NAIImgConfig.character_image, 'plain')}
                                <div class="rounded-md h-20 w-20 shadow-lg bg-textcolor2 cursor-pointer hover:text-primary flex items-center justify-center">
                                    <span class="text-sm">Uploading<br />Image..</span>
                                </div>
                            {:then im}
                                <img src={im} class="rounded-md h-40 shadow-lg bg-textcolor2 cursor-pointer hover:text-primary" alt="Base Preview"/>
                            {/await}
                        {/if}
                    </button>

                    {#if DBState.db.NAIImgConfig.character_image && DBState.db.NAIImgConfig.character_image !== ''}
                        <button 
                            onclick={() => {
                                DBState.db.NAIImgConfig.character_image = undefined;
                                DBState.db.NAIImgConfig.character_base64image = undefined;
                            }}
                            class="absolute top-2 right-2 bg-red-500 hover:bg-red-700 text-white font-bold py-1 px-2 rounded-sm"
                        >
                            Delete
                        </button>
                    {/if}
                </div>
                
                <span class="text-textcolor2 text-xs mb-2 block">Leave blank to use the character's default image.</span>

                <div class="flex items-center mb-4">
                    <Check bind:check={DBState.db.NAIImgConfig.style_aware} name="Style Aware"/>
                    <Help key="naiStyleAware"/>
                </div>

            {/if}




            {#if (DBState.db.NAIImgModel === 'nai-diffusion-3' || DBState.db.NAIImgModel === 'nai-diffusion-furry-3' || DBState.db.NAIImgModel === 'nai-diffusion-2')
            && DBState.db.NAIImgConfig.sampler !== 'ddim_v3'}
                <div class="flex items-center mb-2">
                    <Check bind:check={DBState.db.NAIImgConfig.sm} name="Use SMEA"/>
                    <Help key="naiUseSMEA"/>
                </div>
            {/if}

            {#if DBState.db.NAIImgModel === 'nai-diffusion-3' && DBState.db.NAIImgConfig.sampler !== 'ddim_v3'}
                <div class="flex items-center mb-2">
                    <Check bind:check={DBState.db.NAIImgConfig.sm_dyn} name='Use DYN'/>
                    <Help key="naiUseDYN"/>
                </div>
            {/if}

            {#if DBState.db.NAIImgModel === 'nai-diffusion-4-5-full' || DBState.db.NAIImgModel === 'nai-diffusion-4-5-curated'
            || DBState.db.NAIImgModel === 'nai-diffusion-4-full' || DBState.db.NAIImgModel === 'nai-diffusion-4-curated-preview'
            || DBState.db.NAIImgModel === 'nai-diffusion-3' || DBState.db.NAIImgModel === 'nai-diffusion-furry-3'}
                <div class="flex items-center mb-2">
                    <Check bind:check={DBState.db.NAIImgConfig.variety_plus} name="Variety+"/>
                    <Help key="naiVarietyPlus"/>
                </div>
            {/if}

            {#if DBState.db.NAIImgModel === 'nai-diffusion-3' || DBState.db.NAIImgModel === 'nai-diffusion-furry-3' || DBState.db.NAIImgModel === 'nai-diffusion-2'}
                <div class="flex items-center mb-2">
                    <Check bind:check={DBState.db.NAIImgConfig.decrisp} name="Decrisp"/>
                    <Help key="naiDecrisp"/>
                </div>
            {/if}

            {#if DBState.db.NAIImgModel === 'nai-diffusion-4-full'
            || DBState.db.NAIImgModel === 'nai-diffusion-4-curated-preview'}
                <div class="flex items-center mb-2">
                    <Check bind:check={DBState.db.NAIImgConfig.legacy_uc} name='Use legacy uc'/>
                    <Help key="naiLegacyUC"/>
                </div>
            {/if}

            <div class="flex items-center mt-4 mb-4">
                <Check bind:check={DBState.db.NAII2I} name="Enable I2I"/>
                <Help key="naiEnableI2I"/>
            </div>
            
            {#if DBState.db.NAII2I}
                <div class="relative">
                    <button class="mb-2" onclick={async () => {
                        const img = await selectSingleFile([
                            'jpg',
                            'jpeg',
                            'png',
                            'webp'
                        ])
                        if(!img){
                            return null
                        }
                        DBState.db.NAIImgConfig.base64image = Buffer.from(img.data).toString('base64');
                        const saveId = await saveAsset(img.data)
                        DBState.db.NAIImgConfig.image = saveId
                    }}>
                        {#if !DBState.db.NAIImgConfig.image || DBState.db.NAIImgConfig.image === ''}
                            <div class="rounded-md h-20 w-20 shadow-lg bg-textcolor2 cursor-pointer hover:text-primary flex items-center justify-center">
                                <span class="text-sm">Upload<br />Image</span>
                            </div>
                        {:else}
                            {#await getCharImage(DBState.db.NAIImgConfig.image, 'plain')}
                                <div class="rounded-md h-20 w-20 shadow-lg bg-textcolor2 cursor-pointer hover:text-primary flex items-center justify-center">
                                    <span class="text-sm">Uploading<br />Image..</span>
                                </div>
                            {:then im}
                                <img src={im} class="rounded-md h-40 shadow-lg bg-textcolor2 cursor-pointer hover:text-primary" alt="Base Preview"/>
                            {/await}
                        {/if}
                    </button>

                    {#if DBState.db.NAIImgConfig.image && DBState.db.NAIImgConfig.image !== ''}
                        <button 
                            onclick={() => {
                                DBState.db.NAIImgConfig.image = undefined;
                                DBState.db.NAIImgConfig.base64image = undefined;
                            }}
                            class="absolute top-2 right-2 bg-red-500 hover:bg-red-700 text-white font-bold py-1 px-2 rounded-sm"
                        >
                            Delete
                        </button>
                    {/if}
                </div>
                <span class="text-textcolor2 text-xs block">Leave blank to use the character's default image.</span>


                <span class="text-textcolor mt-2">Strength</span>
                <SliderInput className="mt-2" min={0} max={0.99} step={0.01} fixed={2} bind:value={DBState.db.NAIImgConfig.strength}/>
                <span class="text-textcolor mt-2">Noise</span>
                <SliderInput className="mt-2" min={0} max={0.99} step={0.01} fixed={2} bind:value={DBState.db.NAIImgConfig.noise}/>


            {/if}
        {/if}

         
        
        {#if DBState.db.sdProvider === 'dalle'}
            <span class="text-textcolor">OpenAI API Key <Help key="dalleKey"/></span>
            <TextInput className="mt-2" marginBottom placeholder="sk-..." bind:value={DBState.db.openAIKey}/>

            <span class="text-textcolor mt-4">Dall-E Quality <Help key="dalleQuality"/></span>
            <SelectInput className="mt-2 mb-4" bind:value={DBState.db.dallEQuality}>
                <OptionInput value="standard" >Standard</OptionInput>
                <OptionInput value="hd" >HD</OptionInput>
            </SelectInput>

        {/if}

        {#if DBState.db.sdProvider === 'stability'}
            <span class="text-textcolor">Stability API Key <Help key="stabilityKey"/></span>
            <TextInput className="mt-2" marginBottom placeholder="..." bind:value={DBState.db.stabilityKey}/>

            <span class="text-textcolor">Stability Model <Help key="stabilityModel"/></span>
            <SelectInput className="mt-2 mb-4" bind:value={DBState.db.stabilityModel}>
                <OptionInput value="ultra" >SD Ultra</OptionInput>
                <OptionInput value="core" >SD Core</OptionInput>
                <OptionInput value="sd3-large" >SD3 Large</OptionInput>
                <OptionInput value="sd3-medium" >SD3 Medium</OptionInput>
            </SelectInput>

            {#if DBState.db.stabilityModel === 'core'}
                <span class="text-textcolor">SD Core Style <Help key="stabilityCoreStyle"/></span>
                <SelectInput className="mt-2 mb-4" bind:value={DBState.db.stabllityStyle}>
                    <OptionInput value="" >Unspecified</OptionInput>
                    <OptionInput value="3d-model" >3D Model</OptionInput>
                    <OptionInput value="analog-film" >Analog Film</OptionInput>
                    <OptionInput value="anime" >Anime</OptionInput>
                    <OptionInput value="cinematic" >Cinematic</OptionInput>
                    <OptionInput value="comic-book" >Comic Book</OptionInput>
                    <OptionInput value="digital-art" >Digital Art</OptionInput>
                    <OptionInput value="enhance" >Enhance</OptionInput>
                    <OptionInput value="fantasy-art" >Fantasy Art</OptionInput>
                    <OptionInput value="isometric" >Isometric</OptionInput>
                    <OptionInput value="line-art" >Line Art</OptionInput>
                    <OptionInput value="low-poly" >Low Poly</OptionInput>
                    <OptionInput value="modeling-compound" >Modeling Compound</OptionInput>
                    <OptionInput value="neon-punk" >Neon Punk</OptionInput>
                    <OptionInput value="origami" >Origami</OptionInput>
                    <OptionInput value="photographic" >Photographic</OptionInput>
                    <OptionInput value="pixel-art" >Pixel Art</OptionInput>
                    <OptionInput value="tile-texture" >Tile Texture</OptionInput>
                </SelectInput>
            {/if}
        {/if}

        {#if DBState.db.sdProvider === 'comfyui'}
            <span class="text-textcolor mt-2">ComfyUI {language.providerURL} <Help key="comfyUrl"/></span>
            <TextInput className="mt-2" marginBottom placeholder="http://127.0.0.1:8188" bind:value={DBState.db.comfyUiUrl}/>

            <span class="text-textcolor">Workflow <Help key="comfyWorkflow" /></span>
            <TextInput className="mt-2" marginBottom bind:value={DBState.db.comfyConfig.workflow}/>

            <span class="text-textcolor">Timeout (sec) <Help key="comfyTimeout"/></span>
            <NumberInput className="mt-2" marginBottom bind:value={DBState.db.comfyConfig.timeout} min={1} max={120} />
        {/if}

        {#if DBState.db.sdProvider === 'comfy'}
            <span class="text-draculared text-xs mb-2">The first image generated by the prompt will be selected. </span>
            <span class="text-textcolor mt-2">ComfyUI {language.providerURL}</span>
            <TextInput className="mt-2" marginBottom placeholder="http://127.0.0.1:8188" bind:value={DBState.db.comfyUiUrl}/>
            <span class="text-textcolor">Workflow</span>
            <TextInput className="mt-2" marginBottom placeholder="valid ComfyUI API json (Enable Dev mode Options in ComfyUI)" bind:value={DBState.db.comfyConfig.workflow}/>

            <span class="text-textcolor">Positive Text Node: ID</span>
            <TextInput className="mt-2" marginBottom placeholder="eg. 1, 3, etc" bind:value={DBState.db.comfyConfig.posNodeID}/>
            <span class="text-textcolor">Positive Text Node: Input Field Name</span>
            <TextInput className="mt-2" marginBottom placeholder="eg. text" bind:value={DBState.db.comfyConfig.posInputName}/>
            <span class="text-textcolor">Negative Text Node: ID</span>
            <TextInput className="mt-2" marginBottom placeholder="eg. 1, 3, etc" bind:value={DBState.db.comfyConfig.negNodeID}/>
            <span class="text-textcolor">Positive Text Node: Input Field Name</span>
            <TextInput className="mt-2" marginBottom placeholder="eg. text" bind:value={DBState.db.comfyConfig.negInputName}/>
            <span class="text-textcolor">Timeout (sec)</span>
            <NumberInput className="mt-2" marginBottom bind:value={DBState.db.comfyConfig.timeout} min={1} max={120} />
        {/if}

        {#if DBState.db.sdProvider === 'fal'}
            <span class="text-textcolor">Fal.ai API Key <Help key="falKey"/></span>
            <TextInput className="mt-2" marginBottom placeholder="..." bind:value={DBState.db.falToken}/>

            <span class="text-textcolor mt-4">Width <Help key="falWidth"/></span>
            <NumberInput className="mt-2" marginBottom min={0} max={2048} bind:value={DBState.db.sdConfig.width}/>
            <span class="text-textcolor mt-4">Height <Help key="falHeight"/></span>
            <NumberInput className="mt-2" marginBottom min={0} max={2048} bind:value={DBState.db.sdConfig.height}/>

            <span class="text-textcolor mt-4">Model <Help key="falModel"/></span>
            <SelectInput className="mt-2 mb-4" bind:value={DBState.db.falModel}>
                <OptionInput value="fal-ai/flux/dev" >Flux[Dev]</OptionInput>
                <OptionInput value="fal-ai/flux-lora" >Flux[Dev] with Lora</OptionInput>
                <OptionInput value="fal-ai/flux-pro" >Flux[Pro]</OptionInput>
                <OptionInput value="fal-ai/flux/schnell" >Flux[Schnell]</OptionInput>
            </SelectInput>

            {#if DBState.db.falModel === 'fal-ai/flux-lora'}
                <span class="text-textcolor mt-4">Lora Model URL <Help key="urllora" /></span>
                <TextInput className="mt-2" marginBottom bind:value={DBState.db.falLora}/>

                <span class="text-textcolor mt-4">Lora Weight <Help key="falLoraWeight"/></span>
                <SliderInput className="mt-2" fixed={2} min={0}  max={2} step={0.01} bind:value={DBState.db.falLoraScale}/>
            {/if}


        {/if}

        {#if DBState.db.sdProvider === 'Imagen'}
            <span class="text-textcolor mt-2">GoogleAI API Key <Help key="imagenKey"/></span>
            <TextInput className="mt-2" marginBottom={true} placeholder="..." hideText={DBState.db.hideApiKey} bind:value={DBState.db.google.accessToken}/>

            <span class="text-textcolor">Model <Help key="imagenModel"/></span>
            <SelectInput className="mt-2 mb-4" bind:value={DBState.db.ImagenModel}>
                <OptionInput value="imagen-4.0-generate-001" >Imagen 4</OptionInput>
                <OptionInput value="imagen-4.0-ultra-generate-001" >Imagen 4 Ultra</OptionInput>
                <OptionInput value="imagen-4.0-fast-generate-001" >Imagen 4 Fast</OptionInput>
                <OptionInput value="imagen-3.0-generate-002" >Imagen 3.0</OptionInput>
            </SelectInput>

            {#if DBState.db.ImagenModel === 'imagen-4.0-generate-001' || DBState.db.ImagenModel === 'imagen-4.0-ultra-generate-001'}
                <span class="text-textcolor">Image size <Help key="imagenImageSize"/></span>
                <SelectInput className="mt-2 mb-4" bind:value={DBState.db.ImagenImageSize}>
                    <OptionInput value="1K" >1K</OptionInput>
                    <OptionInput value="2K" >2K</OptionInput>
                </SelectInput>
            {/if}

            <span class="text-textcolor">Aspect ratio <Help key="imagenAspectRatio"/></span>
            <SelectInput className="mt-2 mb-4" bind:value={DBState.db.ImagenAspectRatio}>
                <OptionInput value="1:1" >1:1</OptionInput>
                <OptionInput value="3:4" >3:4</OptionInput>
                <OptionInput value="4:3" >4:3</OptionInput>
                <OptionInput value="9:16" >9:16</OptionInput>
                <OptionInput value="16:9" >16:9</OptionInput>
            </SelectInput>

            <span class="text-textcolor">Person generation <Help key="imagenPersonGeneration"/></span>
            <SelectInput className="mt-2 mb-4" bind:value={DBState.db.ImagenPersonGeneration}>
                <OptionInput value="allow_all" >Allow all</OptionInput>
                <OptionInput value="allow_adult" >Allow adult</OptionInput>
                <OptionInput value="dont_allow" >Don't allow</OptionInput>
            </SelectInput>
        {/if}

        {#if DBState.db.sdProvider === 'openai-compat'}
            <span class="text-textcolor mt-2">API URL <Help key="oaiImgUrl"/></span>
            <TextInput className="mt-2" marginBottom placeholder="https://api.example.com/v1/images/generations" bind:value={DBState.db.openaiCompatImage.url}/>

            <span class="text-textcolor">API Key <Help key="oaiImgKey"/></span>
            <TextInput className="mt-2" marginBottom placeholder="sk-..." hideText={DBState.db.hideApiKey} bind:value={DBState.db.openaiCompatImage.key}/>

            <span class="text-textcolor">Model <Help key="oaiImgModel"/></span>
            <TextInput className="mt-2" marginBottom placeholder="dall-e-3" bind:value={DBState.db.openaiCompatImage.model}/>

            <span class="text-textcolor">Image Size <Help key="oaiImgSize"/></span>
            <SelectInput className="mt-2 mb-4" bind:value={DBState.db.openaiCompatImage.size}>
                <OptionInput value="1024x1024" >1024x1024</OptionInput>
                <OptionInput value="1536x1024" >1536x1024</OptionInput>
                <OptionInput value="1024x1536" >1024x1536</OptionInput>
                <OptionInput value="512x512" >512x512</OptionInput>
                <OptionInput value="256x256" >256x256</OptionInput>
            </SelectInput>

            <span class="text-textcolor">Quality <Help key="oaiImgQuality"/></span>
            <SelectInput className="mt-2 mb-4" bind:value={DBState.db.openaiCompatImage.quality}>
                <OptionInput value="auto" >Auto</OptionInput>
                <OptionInput value="low" >Low</OptionInput>
                <OptionInput value="medium" >Medium</OptionInput>
                <OptionInput value="high" >High</OptionInput>
            </SelectInput>
        {/if}

        {#if DBState.db.sdProvider === 'wavespeed'}
            <span class="text-textcolor">API Key <Help key="waveKey"/></span>
            <TextInput className="mt-2" marginBottom placeholder="sk-..." hideText={DBState.db.hideApiKey} bind:value={DBState.db.wavespeedImage.key}/>

            <span class="text-textcolor">Model <Help key="waveModel"/></span>
            <button
              class="px-3 py-2 bg-darkbutton rounded-md hover:bg-textcolor2 transition-colors disabled:opacity-50"
              disabled={isWavespeedLoading}
              onclick={fetchWavespeedModels}
            >
                {isWavespeedLoading ? 'Loading...' : 'Refresh Models'}
            </button>
            <TextInput
              className="mt-2"
              bind:value={wavespeedSearchQuery}
              placeholder="Search models..."
              marginBottom
            />
            <SelectInput className="mt-2 mb-4" bind:value={DBState.db.wavespeedImage.model} onchange={handleModelChange}>
                <OptionInput value="" >Select a model...</OptionInput>
                {#if wavespeedModels.length > 0}
                    {#each getFilteredModels() as model}
                        <OptionInput value={model.model_id}>
                            {getModelDisplayName(model)}
                        </OptionInput>
                    {/each}
                {:else if DBState.db.wavespeedImage.model}
                    <OptionInput value={DBState.db.wavespeedImage.model}> {DBState.db.wavespeedImage.model} </OptionInput>
                {/if}
            </SelectInput>

            <span class="text-textcolor mt-4">LoRAs <Help key="waveLoras"/></span>
            {#if wavespeedModels.find(m => m.model_id === DBState.db.wavespeedImage.model)?.supportsLoras}
                {#each wavespeedLoras as lora, index}
                    <TextInput
                      className="mt-2"
                      marginBottom
                      marginTop
                      placeholder={`LoRA ${index + 1} URL (optional)`}
                      bind:value={lora.path}
                    />
                    <SliderInput
                      className="mt-2"
                      marginBottom
                      min={0}
                      max={4}
                      step={0.1}
                      fixed={1}
                      bind:value={lora.scale}
                    />
                {/each}
                <span class="text-textcolor2 text-xs mb-2 block">
                    Only .safetensors files are supported. Use owner/model-name (Hugging Face) or direct URL (Civitai).
                </span>
            {:else}
                <span class="text-textcolor2 text-xs mb-2 block">
                    Model does not support LoRA. Or refresh model list to update model status.
                </span>
            {/if}

            <span class="text-textcolor">Image Reference <Help key="waveImageReference"/></span>
            {#if wavespeedModels.find(m => m.model_id === DBState.db.wavespeedImage.model)?.supportsImageInput}
                <SelectInput className="mt-2 mb-4" bind:value={DBState.db.wavespeedImage.reference_mode}>
                    <OptionInput value="" >None</OptionInput>
                    <OptionInput value="image" >Upload Image</OptionInput>
                    <OptionInput value="character" >Use Character Image</OptionInput>
                </SelectInput>

                {#if DBState.db.wavespeedImage.reference_mode === 'image'}
                    <div class="relative">
                        <button class="mb-2" onclick={async () => {
                            const img = await selectSingleFile([
                                'jpg',
                                'jpeg',
                                'png',
                                'webp'
                            ])
                            if(!img){
                                return null
                            }

                            const imageData = img.data;

                            DBState.db.wavespeedImage.reference_base64image = Buffer.from(imageData).toString('base64');
                            const saveId = await saveAsset(imageData)
                            DBState.db.wavespeedImage.reference_image = saveId
                            console.log('Character image set:', DBState.db.wavespeedImage.reference_image)
                        }}>
                            {#if !DBState.db.wavespeedImage.reference_image || DBState.db.wavespeedImage.reference_image === ''}
                                <div class="rounded-md h-20 w-20 shadow-lg bg-textcolor2 cursor-pointer hover:text-primary flex items-center justify-center">
                                    <span class="text-sm">Upload<br />Image</span>
                                </div>
                            {:else}
                                {#await getCharImage(DBState.db.wavespeedImage.reference_image, 'plain')}
                                    <div class="rounded-md h-20 w-20 shadow-lg bg-textcolor2 cursor-pointer hover:text-primary flex items-center justify-center">
                                        <span class="text-sm">Uploading<br />Image..</span>
                                    </div>
                                {:then im}
                                    <img src={im} class="rounded-md h-40 shadow-lg bg-textcolor2 cursor-pointer hover:text-primary" alt="Base Preview"/>
                                {/await}
                            {/if}
                        </button>

                        {#if DBState.db.wavespeedImage.reference_image && DBState.db.wavespeedImage.reference_image !== ''}
                            <button
                              onclick={() => {
                                    DBState.db.wavespeedImage.reference_image = undefined;
                                    DBState.db.wavespeedImage.reference_base64image = undefined;
                                }}
                              class="absolute top-2 right-2 bg-red-500 hover:bg-red-700 text-white font-bold py-1 px-2 rounded-sm"
                            >
                                Delete
                            </button>
                        {/if}
                    </div>
                {/if}
                {#if DBState.db.wavespeedImage.reference_mode === 'character'}
                    <span class="text-textcolor2 text-xs mb-2 block">Use the character's default image.</span>
                {/if}
            {:else}
                <span class="text-textcolor2 text-xs mb-2 block">
                    Model does not support image input. Or refresh model list to update model status.
                </span>
            {/if}
        {/if}
    </Accordion>
{/if}

{#if $OtherBotsSubmenuIndex === 1}
<Accordion name="TTS" styled disabled>
    <span class="text-textcolor mt-2">Auto Speech <Help key="ttsAutoSpeech"/></span>
    <CheckInput className="mt-2" bind:check={DBState.db.ttsAutoSpeech}/>

    <span class="text-textcolor mt-2">ElevenLabs API key <Help key="ttsElevenLabsKey"/></span>
    <TextInput className="mt-2" marginBottom bind:value={DBState.db.elevenLabKey}/>

    <span class="text-textcolor mt-2">VOICEVOX URL <Help key="ttsVoicevoxUrl"/></span>
    <TextInput className="mt-2" marginBottom bind:value={DBState.db.voicevoxUrl}/>

    <span class="text-textcolor">OpenAI Key <Help key="ttsOpenAIKey"/></span>
    <TextInput className="mt-2" marginBottom bind:value={DBState.db.openAIKey}/>

    <span class="text-textcolor mt-2">NovelAI API key <Help key="ttsNAIKey"/></span>
    <TextInput className="mt-2" marginBottom placeholder="pst-..." bind:value={DBState.db.NAIApiKey}/>

    <span class="text-textcolor">Huggingface Key <Help key="ttsHuggingfaceKey"/></span>
    <TextInput className="mt-2" marginBottom bind:value={DBState.db.huggingfaceKey} placeholder="hf_..."/>

    <span class="text-textcolor">fish-speech API Key <Help key="ttsFishSpeechKey"/></span>
    <TextInput className="mt-2" marginBottom bind:value={DBState.db.fishSpeechKey}/>

</Accordion>
{/if}

{#if $OtherBotsSubmenuIndex === 2}
<Accordion name={language.emotionImage} styled disabled>
    <span class="text-textcolor mt-2">{language.emotionMethod} <Help key="emotionMethod"/></span>

    <SelectInput className="mt-2 mb-4" bind:value={DBState.db.emotionProcesser}>
        <OptionInput value="submodel" >Ax. Model</OptionInput>
        <OptionInput value="embedding" >MiniLM-L6-v2</OptionInput>
    </SelectInput>
</Accordion>
{/if}

</SettingPage>

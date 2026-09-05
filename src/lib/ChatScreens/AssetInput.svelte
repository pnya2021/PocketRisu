<script lang="ts">
    import { FileMusicIcon, PlusIcon } from "@lucide/svelte";
    import { type character, type groupChat } from "src/ts/storage/database.svelte";
    import { appendAssetManifestItems, forageStorage, getFileSrc, recoverAssetManifestConflict, saveAsset } from "src/ts/globalApi.svelte";
    import { selectMultipleFile } from "src/ts/util";
    interface Props {
        currentCharacter: character|groupChat;
        onSelect: (additionalAsset:[string,string,string])=>void;
    }

    const { currentCharacter, onSelect }: Props = $props();

    let assetFileExtensions:string[] = $state([])
    let assetFilePath:string[] = $state([])
    let manifestItems:[string, string, string][] = $state([])
    let manifestOffset = $state(0)
    let manifestTotal = $state(0)
    const manifestPageSize = 100

    async function loadManifestPage(offset = 0) {
        if (!currentCharacter.additionalAssetManifest) return
        const page = await forageStorage.getAssetManifestPage(currentCharacter.additionalAssetManifest, {
            offset,
            limit: manifestPageSize,
        })
        manifestItems = page.items as [string, string, string][]
        manifestOffset = page.offset
        manifestTotal = page.total
        assetFileExtensions = []
        assetFilePath = []
    }

    $effect(() => {
        const manifestId = currentCharacter.additionalAssetManifest?.id
        if (manifestId) void loadManifestPage(0)
    })

    $effect.pre(() => {
        if(currentCharacter.type ==='character'){
            const assets = currentCharacter.additionalAssetManifest ? manifestItems : currentCharacter.additionalAssets
            if(assets){
                for(let i = 0; i < assets.length; i++){
                    // console.log('check content type ...', currentCharacter.additionalAssets[i][0], currentCharacter.additionalAssets[i][1]);
                    if(assets[i].length > 2 && assets[i][2]) {
                        assetFileExtensions[i] = assets[i][2]
                    } else {
                        assetFileExtensions[i] = assets[i][1].split('.').pop()
                    }
                    getFileSrc(assets[i][1]).then((filePath) => {
                        assetFilePath[i] = filePath
                    })
                }
            }
        }
    });
</script>
{#if currentCharacter.type ==='character'}
    <button class="hover:text-primary bg-textcolor2 flex justify-center items-center w-16 h-16 m-1 rounded-md" onclick={async () => {
        if(currentCharacter.type === 'character'){
            const da = await selectMultipleFile(['png', 'webp', 'mp4', 'mp3', 'gif'])
            if(!da){
                return
            }
            const appended: [string, string, string][] = []
            for(const f of da){
                console.log(f)
                const img = f.data
                const name = f.name
                const extension = name.split('.').pop().toLowerCase()
                const imgp = await saveAsset(img,'',extension)
                if (currentCharacter.additionalAssetManifest) {
                    appended.push([name, imgp, extension])
                } else {
                    currentCharacter.additionalAssets ??= []
                    currentCharacter.additionalAssets.push([name, imgp, extension])
                }
            }
            if (currentCharacter.additionalAssetManifest && appended.length > 0) {
                try {
                    currentCharacter.additionalAssetManifest = await appendAssetManifestItems(
                        currentCharacter.additionalAssetManifest,
                        appended,
                    )
                    await loadManifestPage(Math.floor((currentCharacter.additionalAssetManifest.count - 1) / manifestPageSize) * manifestPageSize)
                } catch (error) {
                    if (!await recoverAssetManifestConflict(error, () => loadManifestPage(0))) throw error
                }
            }
        }
    }}>
        <PlusIcon />
    </button>
    {#if currentCharacter.additionalAssets || currentCharacter.additionalAssetManifest}
        {#each (currentCharacter.additionalAssetManifest ? manifestItems : currentCharacter.additionalAssets ?? []) as additionalAsset, i}
                <button onclick={()=>{
                    onSelect(additionalAsset)
                }}>
                    {#if assetFilePath[i]}
                        {#if assetFileExtensions[i] === 'mp4'}
                            <!-- svelte-ignore a11y_media_has_caption -->
                            <video class="w-16 h-16 m-1 rounded-md"><source src={assetFilePath[i]} type="video/mp4"></video>
                        {:else if assetFileExtensions[i] === 'mp3'}
                            <div class='w-16 h-16 m-1 rounded-md bg-slate-500 flex flex-col justify-center items-center'>
                                <FileMusicIcon/>
                                <div class='w-16 px-1 text-ellipsis whitespace-nowrap overflow-hidden'>{additionalAsset[0]}</div>
                            </div>
                            <!-- <audio controls class="w-16 h-16 m-1 rounded-md"><source src={assetPath} type="audio/mpeg"></audio> -->
                        {:else}
                        <img src={assetFilePath[i]} class="w-16 h-16 m-1 rounded-md" alt={additionalAsset[0]}/>
                        {/if}
                    {/if}
                </button>
        {/each}
        {#if currentCharacter.additionalAssetManifest && manifestTotal > manifestPageSize}
            <div class="flex items-center gap-2 w-full">
                <button disabled={manifestOffset === 0} onclick={() => loadManifestPage(Math.max(0, manifestOffset - manifestPageSize))}>←</button>
                <span>{manifestOffset + 1}–{Math.min(manifestOffset + manifestItems.length, manifestTotal)} / {manifestTotal}</span>
                <button disabled={manifestOffset + manifestPageSize >= manifestTotal} onclick={() => loadManifestPage(manifestOffset + manifestPageSize)}>→</button>
            </div>
        {/if}
    {/if}
{/if}

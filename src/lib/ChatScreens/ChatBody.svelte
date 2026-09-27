<script lang="ts">
    import isEqual from "lodash/isEqual"
    import { DBState } from 'src/ts/stores.svelte'
    import { sleep } from "src/ts/util"
    import { alertError } from "../../ts/alert"
    import { tick } from 'svelte'
    import { addMetadataToElement, getDistance, ParseMarkdown, postTranslationParse, resolveInlayPlaceholders, trimMarkdown, type CbsConditions, type simpleCharacterArgument } from "../../ts/parser/parser.svelte"
    import { getLLMCache, translateHTML } from "../../ts/translator/translator"
    import { getModuleAssets, getModules } from "src/ts/process/modules";
    import { getFileSrc, resolvePrioritizedAssetManifestNames } from "src/ts/globalApi.svelte";
    import { get } from "svelte/store";
    import { doingChat } from "src/ts/process/generationState";

    interface Props {
        character?: simpleCharacterArgument|string|null
        firstMessage?: boolean
        idx?: number
        msgDisplay?: string
        name?: string
        role: string|null
        translated: boolean
        translating: boolean
        retranslate: boolean
        renderRevision?: number
        bodyRoot?: HTMLElement|null
        modelShortName: string
        renderRawStreaming?: boolean
        rawStreamingText?: string
    }

    let {
        character = null,
        idx = 0,
        firstMessage = false,
        msgDisplay,
        role,
        translated = $bindable(false),
        translating = $bindable(false),
        retranslate = $bindable(false),
        renderRevision = 0,
        bodyRoot,
        modelShortName = '',
        renderRawStreaming = false,
        rawStreamingText = '',
    }: Props =  $props()

    // svelte-ignore non_reactive_update
    let lastParsed = ''
    let lastCharArg:string|simpleCharacterArgument = null
    let lastChatId = -10
    type TranslationRequest = {
        data: string
        charArg: string | simpleCharacterArgument
        chatID: number
        retranslate: boolean
        // A re-render caused by an edited translation cache keeps the current
        // content instead of flashing the loading spinner.
        preserveContent?: boolean
    }

    let translationFlight: Promise<string> | null = null
    let translationPendingData: string | null = null
    let translationPendingCharArg:string|simpleCharacterArgument = null
    let translationPendingChatID: number | null = null
    let translationPendingRetranslate = false
    let translationActiveRequest: TranslationRequest | null = null

    const translationLoadingHTML = `<div style="display:flex;justify-content:center;align-items:center;height:48px;"><div style="animation: spin 1s linear infinite; border-radius: 50%; height: 32px; width: 32px; border: 2px solid #3b82f6; border-top: 2px solid transparent;"></div></div><style>@keyframes spin { to { transform: rotate(360deg); } }</style>`

    const hasRenderableResult = (result: string | null | undefined) => {
        return typeof result === 'string' && result.trim().length > 0
    }

    const isSameTranslationTarget = (a: TranslationRequest | null, b: TranslationRequest | null) => {
        return !!a && !!b && a.data === b.data && a.chatID === b.chatID && isEqual(a.charArg, b.charArg)
    }

    const shouldQueueTranslation = (request: TranslationRequest, existing: TranslationRequest | null) => {
        if(!existing){
            return true
        }
        if(!isSameTranslationTarget(request, existing)){
            return true
        }
        return request.retranslate && !existing.retranslate
    }

    const getPendingTranslationRequest = (): TranslationRequest | null => {
        if(translationPendingData === null || translationPendingChatID === null){
            return null
        }
        return {
            data: translationPendingData,
            charArg: translationPendingCharArg,
            chatID: translationPendingChatID,
            retranslate: translationPendingRetranslate,
        }
    }

    const queueLatestTranslation = (request: TranslationRequest) => {
        const queued = getPendingTranslationRequest()
        const existing = queued ?? translationActiveRequest
        if(!shouldQueueTranslation(request, existing)){
            return
        }
        translationPendingData = request.data
        translationPendingCharArg = request.charArg
        translationPendingChatID = request.chatID
        translationPendingRetranslate = request.retranslate
    }

    const takePendingTranslation = () => {
        const queued = getPendingTranslationRequest()
        translationPendingData = null
        translationPendingCharArg = null
        translationPendingChatID = null
        translationPendingRetranslate = false
        return queued
    }

    const translateOnce = async (request: TranslationRequest, mode: 'notrim', fallbackParsed: string) => {
        let transResult = ''

        if(DBState.db.translatorType === 'llm' && DBState.db.translateBeforeHTMLFormatting){
            await sleep(100)
            const translatedData = await translateHTML(request.data, false, request.charArg, request.chatID, request.retranslate)
            const marked = await ParseMarkdown(translatedData, request.charArg, mode, request.chatID, getCbsCondition())
            transResult = marked
        }
        else if(!DBState.db.legacyTranslation){
            const marked = await ParseMarkdown(request.data, request.charArg, 'pretranslate', request.chatID, getCbsCondition())
            const translated = await postTranslationParse(await translateHTML(marked, false, request.charArg, request.chatID, request.retranslate))
            transResult = translated
        }
        else{
            const marked = await ParseMarkdown(request.data, request.charArg, mode, request.chatID, getCbsCondition())
            const translated = await translateHTML(marked, false, request.charArg, request.chatID, request.retranslate)
            transResult = translated
        }

        setTimeout(() => {
            retranslate = false
        }, 10);

        if(hasRenderableResult(transResult)){
            lastParsed = transResult
            lastCharArg = request.charArg
            return transResult
        }

        return lastParsed === translationLoadingHTML ? fallbackParsed : lastParsed
    }

    const startTranslationFlight = (request: TranslationRequest, mode: 'notrim') => {
        const fallbackParsed = lastParsed
        let finalResult = fallbackParsed

        translationFlight = (async () => {
            // While a generation streams, every chunk re-parses; swapping the
            // rendered text for the spinner each time is the flicker of #21,
            // so the spinner then only fills an empty slot. A translation the
            // user asked for, or one outside streaming, shows it as upstream.
            if (DBState.db.showTranslationLoading && !request.preserveContent && (!hasRenderableResult(lastParsed) || request.retranslate || !get(doingChat))) {
                lastParsed = translationLoadingHTML
            }
            // Leave the $derived sync section before writing bound state (state_unsafe_mutation)
            await Promise.resolve()
            translating = true

            try {
                let currentRequest = request
                while(true){
                    translationActiveRequest = currentRequest
                    const translatedResult = await translateOnce(currentRequest, mode, fallbackParsed)
                    if(hasRenderableResult(translatedResult)){
                        finalResult = translatedResult
                    }

                    const queued = takePendingTranslation()
                    if(!queued){
                        return finalResult
                    }
                    if(isSameTranslationTarget(currentRequest, queued) && !queued.retranslate){
                        return finalResult
                    }
                    currentRequest = queued
                }
            }
            finally {
                // A failed flight must never leave the spinner on screen.
                if(lastParsed === translationLoadingHTML){
                    lastParsed = hasRenderableResult(finalResult) ? finalResult : fallbackParsed
                }
                translating = false
                translationActiveRequest = null
                translationFlight = null
                translationPendingData = null
                translationPendingCharArg = null
                translationPendingChatID = null
                translationPendingRetranslate = false
            }
        })()

        return translationFlight
    }
    let lastRenderedRevision: number | null = null

    function getCbsCondition(){
        try{
            const cbsConditions:CbsConditions = {
                firstmsg: firstMessage ?? false,
                chatRole: role,
            }
            return cbsConditions
        }
        catch(e){
            return {
                firstmsg: firstMessage ?? false,
                chatRole: null,
            }
        }
    }

    let shouldRenderRawStreaming = $derived(renderRawStreaming && !translated && !retranslate)

    const markParsing = async (data: string, charArg: string | simpleCharacterArgument, chatID: number, requestedRevision: number, tries?:number) => {
        // track 'translated' and 'retranslate' state
        translated;
        retranslate;
        const preservePendingContent = lastRenderedRevision !== null && requestedRevision !== lastRenderedRevision
        let lastParsedQueue = ''
        let mode = 'notrim' as const
        try {
            if((!isEqual(lastCharArg, charArg)) || (chatID !== lastChatId)){
                lastParsedQueue = ''
                lastCharArg = charArg
                lastChatId = chatID
                let translateText = false
                try {
                    if(DBState.db.autoTranslate){
                        if(DBState.db.autoTranslateCachedOnly && DBState.db.translatorType === 'llm'){
                            const cache = DBState.db.translateBeforeHTMLFormatting
                            ? await getLLMCache(data)
                            : !DBState.db.legacyTranslation
                            ? await getLLMCache(await ParseMarkdown(data, charArg, 'pretranslate', chatID, getCbsCondition()))
                            : await getLLMCache(await ParseMarkdown(data, charArg, mode, chatID, getCbsCondition()))
                  
                            translateText = cache !== null
                        }
                        else{
                            translateText = true
                        }
                    }

                    const lastTranslated = translated

                    setTimeout(() => {
                            translated = translateText
                    }, 10)

                    // State change of `translated` triggers markParsing again,
                    // causing redundant translation attempts
                    if (lastTranslated !== translateText) {
                        lastParsedQueue = lastParsed
                        return lastParsed;
                    }
                } catch (error) {
                    console.error(error)
                }
            }
            if(retranslate || translated){
                const translationRequest = {
                    data,
                    charArg,
                    chatID,
                    retranslate,
                    preserveContent: preservePendingContent,
                }
                
                if(translationFlight){
                    queueLatestTranslation(translationRequest)
                    const transResult = await translationFlight
                    if(hasRenderableResult(transResult)){
                        lastParsedQueue = transResult
                    }
                    return transResult
                }

                const transResult = await startTranslationFlight(translationRequest, mode)
                if(hasRenderableResult(transResult)){
                    lastParsedQueue = transResult
                }
                return transResult
            }
            else{
                const marked = await ParseMarkdown(data, charArg, mode, chatID, getCbsCondition())
                lastParsedQueue = marked
                lastCharArg = charArg
                return marked
            }   
        } catch (error) {
            //retry
            if(tries > 2){

                const err = error as Error
                alertError(`Error while parsing chat message: ${translated}, ${err.message}, ${err.stack}`)
                lastParsedQueue = hasRenderableResult(data) ? data : lastParsed
                return lastParsedQueue
            }
            const retryResult = await markParsing(data, charArg, chatID, requestedRevision, (tries ?? 0) + 1)
            if(hasRenderableResult(retryResult)){
                lastParsedQueue = retryResult
            }
            return retryResult
        }
        finally{
            //since trimMarkdown is fast, we don't need to cache it
            if(hasRenderableResult(lastParsedQueue)){
                lastParsed = lastParsedQueue
            }
            lastRenderedRevision = requestedRevision
        }
    }

    const checkImg = async () => {
        if(!DBState.db.newImageHandlingBeta || !bodyRoot){
            return
        }
        const imgs = bodyRoot.querySelectorAll('img:not([src^="data:"]):not([src^="http:"]):not([src^="https:"]):not([src^="blob:"]):not([src^="file:"]):not([src^="tauri:"]):not([src^="/"]):not([noimage])') as NodeListOf<HTMLImageElement>
        
        if (imgs.length > 0) {
            const renderCharacter = typeof character === 'object' && character?.type === 'simple'
                ? character
                : null
            const styl = renderCharacter?.prebuiltAssetStyle
            const assets = getModuleAssets().concat(renderCharacter?.additionalAssets ?? [])
            const moduleManifests = getModules()
                .map((module) => module?.assetManifest)
                .filter((manifest) => !!manifest)
            const normalizedAssets = assets.map((asset) => {
                return {
                    name: asset[0].toLocaleLowerCase(),
                    path: asset[1]
                }
            })
            const exactAssets = new Map(normalizedAssets.map((asset) => [asset.name, asset.path]))
            const requestedNames = [...imgs]
                .map((img) => img.getAttribute('src')?.toLocaleLowerCase() || '')
                .filter((name) => name.length >= 3 && name.length <= 200 && !name.includes(':'))
            let manifestResolved: Record<string, { path: string; fuzzy: boolean }> = {}
            if ((moduleManifests.length > 0 || renderCharacter?.additionalAssetManifest) && requestedNames.length > 0) {
                try {
                    manifestResolved = await resolvePrioritizedAssetManifestNames(
                        renderCharacter?.additionalAssetManifest,
                        moduleManifests,
                        requestedNames,
                    )
                } catch (error) {
                    console.warn('[Assets] Failed to resolve lazy asset manifests', error)
                }
            }

            imgs.forEach(async (img) => {
                const name = img.getAttribute('src')?.toLocaleLowerCase() || ''

                if(
                    name.length > 200 ||
                    name.includes(':')
                ){
                    img.setAttribute('noimage', 'true')
                    return
                }
                
                const manifestHit = manifestResolved[name]
                // Exact manifest match, then the inline exact list; a fuzzy
                // manifest match is only a last resort below.
                const foundAsset = (manifestHit && !manifestHit.fuzzy ? manifestHit.path : undefined) ?? exactAssets.get(name)
                if(foundAsset){
                    img.classList.add('root-loaded-image')
                    img.classList.add('root-loaded-image-' + styl)
                    img.src = await getFileSrc(foundAsset)
                    return
                }

                if(name.length < 3){
                    img.setAttribute('noimage', 'true')
                    return
                }
                const prefixLoc = name.lastIndexOf('.')
                const prefix = prefixLoc > 0 ? name.substring(0, prefixLoc) : ''
                let currentDistance = 1000
                let currentFound = ''
                for(const asset of normalizedAssets){
                    if(!asset.name.startsWith(prefix)){
                        continue
                    }
                    const distance = getDistance(name, asset.name)
                    if(distance < currentDistance){
                        currentDistance = distance
                        currentFound = asset.path
                    }
                }
                if(!currentFound && manifestHit?.fuzzy) currentFound = manifestHit.path
                if(currentFound){
                    const got = await getFileSrc(currentFound)
                    const name2 = img.getAttribute('src')?.toLocaleLowerCase() || ''
                    if(name === name2){
                        img.setAttribute('src', got)
                    }

                    if(img.classList.length === 0){
                        img.classList.add('root-loaded-image')
                        img.classList.add('root-loaded-image-' + styl)
                    }
                    img.removeAttribute('noimage')
                }
                else{
                    img.setAttribute('noimage', 'true')
                }
            })
        }
    }

    let markParsingResult = $derived.by(() => markParsing(msgDisplay, character, idx, renderRevision))

    $effect(() => {
        if(shouldRenderRawStreaming){
            return
        }
        markParsingResult
        void checkImg()
        markParsingResult.then(async () => {
            await checkImg()
            await tick() // Wait for Svelte to re-render the {:then} block into DOM
            if (bodyRoot) resolveInlayPlaceholders(bodyRoot)
        })
    })
</script>

{#if shouldRenderRawStreaming}
    <span class="whitespace-pre-wrap">{rawStreamingText}</span>
{:else}
    {#await markParsingResult}
        {@html addMetadataToElement(trimMarkdown(lastParsed), modelShortName)}
    {:then md}
        {@html addMetadataToElement(trimMarkdown(md), modelShortName)}
    {/await}
{/if}

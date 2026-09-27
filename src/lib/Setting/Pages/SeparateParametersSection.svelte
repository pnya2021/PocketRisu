<script lang="ts">
    import { language } from 'src/lang';
    import { DBState } from 'src/ts/stores.svelte';
    import ShAccordion from 'src/lib/UI/GUI/ShAccordion.svelte';
    import ShSwitch from 'src/lib/UI/GUI/ShSwitch.svelte';
    import AllSeperateParameters from 'src/lib/Others/AllSeperateParameters.svelte';

    const paramLabels: Record<string, string> = {
        memory: 'longTermMemory',
        emotion: 'emotionImage',
        translate: 'translator',
        otherAx: 'others',
    };
</script>

<div class="pt-3 border-t border-darkborderc">
    <ShAccordion name={language.seperateParameters} variant="card">
        <div class="flex items-center justify-between gap-3 py-2 px-1">
            <span class="text-sm text-textcolor">{language.seperateParametersEnabled}</span>
            <ShSwitch
                checked={!!DBState.db.seperateParametersEnabled}
                onCheckedChange={(v) => DBState.db.seperateParametersEnabled = v}
            />
        </div>
        {#if DBState.db.seperateParametersEnabled}
            <div class="flex flex-col gap-2 mt-1">
                {#each Object.keys(DBState.db.seperateParameters) as param}
                    <ShAccordion name={language[paramLabels[param]] ?? param} variant="card">
                        <AllSeperateParameters bind:value={DBState.db.seperateParameters[param]} />
                    </ShAccordion>
                {/each}
            </div>
        {/if}
    </ShAccordion>
</div>

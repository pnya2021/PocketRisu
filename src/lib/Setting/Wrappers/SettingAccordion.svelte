<script lang="ts">
    import type { SettingItem, SettingContext } from 'src/ts/setting/types';
    import { getLabel } from 'src/ts/setting/utils';
    import Accordion from 'src/lib/UI/Accordion.svelte';
    import ShAccordion from 'src/lib/UI/GUI/ShAccordion.svelte';
    import SettingRenderer from '../SettingRenderer.svelte'; // Recursive import

    interface Props {
        item: SettingItem;
        ctx: SettingContext;
    }

    let { item, ctx }: Props = $props();
</script>

{#if ctx.layout === 'row'}
    <!-- Row pages: a card disclosure (no row divider) whose children render in
         the same row layout. -->
    <div class="py-1.5" data-setting-id={item.id}>
        <ShAccordion name={getLabel(item)} variant="card" bodyClass="px-1">
            {#if item.options?.children}
                <SettingRenderer items={item.options.children} modelInfo={ctx.modelInfo} subModelInfo={ctx.subModelInfo} layout="row" />
            {/if}
        </ShAccordion>
    </div>
{:else}
    <Accordion name={getLabel(item)} styled={item.options?.styled ?? false}>
        {#if item.options?.children}
            <SettingRenderer items={item.options.children} modelInfo={ctx.modelInfo} subModelInfo={ctx.subModelInfo} />
        {/if}
    </Accordion>
{/if}

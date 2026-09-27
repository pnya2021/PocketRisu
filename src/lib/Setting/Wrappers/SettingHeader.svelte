<script lang="ts">
    import type { SettingItem, SettingContext } from 'src/ts/setting/types';
    import { getLabel } from 'src/ts/setting/utils';
    import ShAlert from 'src/lib/UI/GUI/ShAlert.svelte';
    import { InfoIcon, TriangleAlertIcon } from '@lucide/svelte';

    interface Props {
        item: SettingItem;
        ctx: SettingContext;
    }

    let { item, ctx }: Props = $props();
</script>

{#if ctx.layout === 'row' || ctx.layout === 'block'}
    <!-- Row pages: notices become ShAlert banners (no row divider, like the
         Display customization warning); h2 becomes a section heading. -->
    {#if item.options?.level === 'warning'}
        <ShAlert variant="warning" className="mt-2 mb-3">
            {#snippet icon()}<TriangleAlertIcon />{/snippet}
            {getLabel(item)}
        </ShAlert>
    {:else if item.options?.level === 'h2'}
        <h3 class="text-base font-bold mt-8 mb-1">{getLabel(item)}</h3>
    {:else}
        <ShAlert variant="info" className="mt-2 mb-3">
            {#snippet icon()}<InfoIcon />{/snippet}
            {getLabel(item)}
        </ShAlert>
    {/if}
{:else if item.options?.level === 'h2'}
    <h2 class="mb-2 text-2xl font-bold mt-2 {item.classes ?? ''}">{getLabel(item)}</h2>
{:else if item.options?.level === 'warning'}
    <span class="text-draculared text-xs mb-2 {item.classes ?? ''}">{getLabel(item)}</span>
{:else}
    <span class="text-textcolor mt-4 mb-2 {item.classes ?? ''}">{getLabel(item)}</span>
{/if}

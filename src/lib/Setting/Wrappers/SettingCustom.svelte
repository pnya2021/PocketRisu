<script lang="ts">
    import type { SettingItem, SettingContext } from 'src/ts/setting/types';
    import { customComponents } from 'src/ts/setting/customComponents';

    interface Props {
        item: SettingItem;
        ctx: SettingContext;
    }

    let { item }: Props = $props();
    let CustomComponent = $derived(item.componentId ? customComponents[item.componentId] : null);
</script>

{#if CustomComponent}
    <!-- Anchor for settings-search deep links (scrollIntoView + highlight need
         a real box, so a plain block wrapper rather than display:contents).
         flex-col keeps the component's root children stacked like they were
         when the page's flex column was their direct parent. -->
    <div class="flex flex-col" data-setting-id={item.id}>
        <CustomComponent {...item.componentProps} />
    </div>
{/if}

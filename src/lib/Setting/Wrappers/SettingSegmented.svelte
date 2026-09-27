<script lang="ts">
    import type { SettingItem, SettingContext } from 'src/ts/setting/types';
    import { UNINITIALIZED, getLabel, getSettingValue, setSettingValue } from 'src/ts/setting/utils';
    import { untrack } from 'svelte';
    import SegmentedControl from 'src/lib/UI/GUI/SegmentedControl.svelte';
    import Help from 'src/lib/Others/Help.svelte';
    import { language } from 'src/lang';
    import SettingFieldLabel from './SettingFieldLabel.svelte';

    interface Props {
        item: SettingItem;
        ctx: SettingContext;
    }

    let { item, ctx }: Props = $props();

    let localValue: any = $state(untrack(() => getSettingValue(item, ctx)));

    // Sync: DB -> local
    $effect(() => {
        localValue = getSettingValue(item, ctx);
    });

    // Sync: local -> DB
    $effect(() => {
        const val = localValue;
        if (val === UNINITIALIZED) return;
        untrack(() => {
            if (val !== getSettingValue(item, ctx)) {
                setSettingValue(item, val, ctx);
            }
        });
    });

    // Transform options: filter by condition + resolve labelKey translations
    let processedOptions = $derived((item.options?.segmentOptions ?? [])
        .filter(opt => !opt.condition || opt.condition(ctx))
        .map(opt => ({
            value: opt.value,
            label: opt.labelKey ? ((language as any)[opt.labelKey] ?? opt.label ?? '') : (opt.label ?? '')
        })));

    // Reset value if current selection becomes hidden due to condition changes
    $effect(() => {
        const currentVal = untrack(() => localValue);
        if (processedOptions.length > 0 && currentVal !== undefined && !processedOptions.some(o => o.value === currentVal)) {
            localValue = processedOptions[processedOptions.length - 1].value;
        }
    });
</script>

{#if ctx.layout === 'row' || ctx.layout === 'block'}
    <!-- Segments can be long ("Budget (Manual Tokens)"), so the control takes
         the full width under the row-style label + inline help. -->
    <div class="py-3 border-t border-darkborderc flex flex-col" data-setting-id={item.id}>
        <SettingFieldLabel
            label={getLabel(item)}
            helpKey={item.helpKey}
            helpUnrecommended={item.helpUnrecommended}
            showExperimental={item.showExperimental}
        />
        <SegmentedControl className="mt-2" size="sm" bind:value={localValue} options={processedOptions} />
    </div>
{:else}
<span class="text-textcolor {item.classes ?? ''}" data-setting-id={item.id}>
    {getLabel(item)}
    {#if item.showExperimental}<Help key="experimental"/>{/if}
    {#if item.helpKey}<Help key={item.helpKey as any} unrecommended={item.helpUnrecommended ?? false}/>{/if}
</span>
<SegmentedControl
    bind:value={localValue}
    options={processedOptions}
/>
{/if}

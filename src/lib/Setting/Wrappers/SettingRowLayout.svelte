<script lang="ts">
    import type { Snippet } from 'svelte';
    import type { SettingItem } from 'src/ts/setting/types';
    import { getLabel } from 'src/ts/setting/utils';
    import SettingFieldLabel from './SettingFieldLabel.svelte';

    interface Props {
        item: SettingItem;
        /** The control, rendered right-aligned and vertically centered. */
        control?: Snippet;
        /** Free-text controls: below `sm` the control drops under the label at
         * full width instead of squeezing the label into a narrow column. */
        wideControl?: boolean;
    }

    let { item, control, wideControl = false }: Props = $props();
</script>

<!-- data-setting-id: anchor for settings search deep-links (searchIndex.ts) -->
<div
    class="flex justify-between py-3 border-t border-darkborderc {wideControl ? 'flex-col gap-2 sm:flex-row sm:items-center sm:gap-3' : 'items-center gap-3'}"
    data-setting-id={item.id}
>
    <div class="flex flex-col min-w-0">
        <SettingFieldLabel
            label={getLabel(item)}
            helpKey={item.helpKey}
            helpUnrecommended={item.helpUnrecommended}
            showExperimental={item.showExperimental}
        />
    </div>
    <div class="shrink-0 {wideControl ? 'w-full sm:w-auto' : ''}">{@render control?.()}</div>
</div>

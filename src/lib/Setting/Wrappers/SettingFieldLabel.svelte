<script lang="ts">
    import { language } from 'src/lang';
    import Help from 'src/lib/Others/Help.svelte';

    interface Props {
        label: string;
        helpKey?: string;
        /** Show the unrecommended (triangle) marker; the icon opens the help. */
        helpUnrecommended?: boolean;
        /** Show the experimental (flask) marker. */
        showExperimental?: boolean;
    }

    let { label, helpKey, helpUnrecommended = false, showExperimental = false }: Props = $props();

    // Row-layout help: only the lead paragraph is shown inline (markdown marks
    // stripped); a following detail block (option lists etc.) stays reachable
    // through the help icon.
    const helpText = $derived(
        helpKey ? (language.help as any)[helpKey] as string | undefined : undefined
    );
    const helpLead = $derived(helpText?.split('\n\n')[0].replace(/\*\*|`/g, ''));
    const helpHasMore = $derived(!!helpText && helpText.includes('\n\n'));
</script>

<span class="text-sm text-textcolor">
    {label}
    {#if showExperimental}<Help key="experimental"/>{/if}
    {#if helpKey && (helpUnrecommended || helpHasMore)}<Help key={helpKey as any} unrecommended={helpUnrecommended}/>{/if}
</span>
{#if helpLead}<p class="text-xs text-textcolor2 mt-0.5 whitespace-pre-line">{helpLead}</p>{/if}

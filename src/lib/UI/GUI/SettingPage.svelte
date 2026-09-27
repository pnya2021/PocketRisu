<script lang="ts">
    import type { Snippet } from "svelte";

    let {
        title,
        children,
    }: {
        title: string;
        children?: Snippet;
    } = $props();
</script>

<h2 class="mb-4 text-2xl font-bold mt-2">{title}</h2>
<!-- A row-layout field right under a notice banner (ShAlert, role=alert)
     skips its top divider — otherwise the line hugs the banner's edge. -->
<div class="flex flex-col [&>[role=alert]+*]:border-t-0">
    {@render children?.()}
</div>

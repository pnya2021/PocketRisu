<script lang="ts">
    import { HeartIcon, ExternalLinkIcon, UserPenIcon, TriangleAlertIcon } from "@lucide/svelte";
    import { language } from "src/lang";
    import { openURL } from "src/ts/globalApi.svelte";
    import { supportDialogOpen, fetchSupporters, PATREON_URL, UPSTREAM_PATREON_URL, type SupportersData, type Supporter } from "src/ts/support";
    import ShDialog from "src/lib/UI/GUI/ShDialog.svelte";
    import ShButton from "src/lib/UI/GUI/ShButton.svelte";
    import ShBadge from "src/lib/UI/GUI/ShBadge.svelte";
    import ShAlert from "src/lib/UI/GUI/ShAlert.svelte";
    import { cn } from "src/lib/utils";

    let data: SupportersData | null = $state(null);
    let loading = $state(false);
    let failed = $state(false);
    let tab: 'members' | 'lifetime' = $state('members');

    async function load() {
        loading = true;
        failed = false;
        try {
            data = await fetchSupporters();
        } catch {
            failed = true;
        } finally {
            loading = false;
        }
    }

    // Fetch on every open — server caches for 60s, so this stays cheap and near-live.
    $effect(() => {
        if ($supportDialogOpen) load();
    });

    const all = $derived(data?.supporters ?? []);
    const active = $derived(all.filter(s => s.status === 'active'));

    // Rank 0 = highest tier / bucket. Drives the emphasis so top supporters stand out.
    interface Group { key: string; title: string; badge?: string; rank: number; members: Supporter[] }

    const tierGroups = $derived<Group[]>(
        (data?.tiers ?? [])
            .map((t, i) => ({ key: t.id, title: t.title, badge: `${usd(t.amountCents)}/${language.supportPerMonth}`, rank: i, members: active.filter(s => s.tierId === t.id) }))
            .filter(g => g.members.length > 0)
    );

    // Cumulative tab: one flat list (already sorted by lifetime desc), rank measured
    // from the highest bucket anyone has reached so the top of the list is always lit.
    const maxBucket = $derived(all.reduce((m, s) => Math.max(m, s.bucket), 0));

    function bucketLabel(bucket: number): string | null {
        const b = data?.buckets ?? [];
        return bucket > 0 && b[bucket - 1] != null ? `${usd(b[bucket - 1])}+` : null;
    }

    // Past ~60 names the pill grid gets tall; step chips down a size so a full tier still fits a screen.
    const dense = $derived(all.length > 60);

    function usd(cents: number): string {
        return `$${Math.round(cents / 100)}`;
    }

    // Sponsor-page hierarchy: baseline is a comfortable text-sm pill; each rank up grows a
    // step. Rank 0 and 1 take the theme accent at two strengths so top supporters read first.
    function chipClass(rank: number): string {
        const step = Math.max(0, 2 - rank) - (dense ? 1 : 0);
        const size = step >= 2 ? 'px-5 py-2 text-lg'
            : step === 1 ? 'px-4 py-1.5 text-base'
            : step === 0 ? 'px-3 py-1 text-sm'
            : 'px-2.5 py-0.5 text-xs';
        return cn(
            'inline-flex items-center gap-1.5 rounded-full border text-textcolor',
            size,
            rank === 0 ? 'border-primary bg-primary/25 font-semibold shadow-[0_0_0_3px] shadow-primary/15'
            : rank === 1 ? 'border-primary/50 bg-primary/10 font-medium'
            : rank === 2 ? 'border-borderc/60 bg-selected/60'
            : 'border-darkborderc bg-selected/40'
        );
    }
</script>

<ShDialog
    bind:open={$supportDialogOpen}
    size="lg"
    tier="base"
    ariaLabel={language.supportTitle}
    contentClass="p-5 gap-0 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
>
    <!-- Hero. The accent wash is a pointer-transparent layer stretched up past the dialog's own
         close-button row so it starts at the top edge; the hero itself stays in normal stacking
         so its buttons receive clicks. -->
    <div class="relative -mx-5 px-5 pt-4 pb-6">
        <div class="pointer-events-none absolute inset-x-0 bottom-0 -top-[calc(1.25rem+18px)] bg-gradient-to-b from-primary/15 to-transparent"></div>
        <div class="relative flex flex-col items-center gap-3 pt-1 text-center">
            <div class="flex h-12 w-12 items-center justify-center rounded-full bg-primary/15 text-primary">
                <HeartIcon size={24} />
            </div>
            <h2 class="text-xl font-bold text-textcolor">{language.supportThanks}</h2>
            <div class="mt-2 flex w-full max-w-xs flex-col gap-2">
                <ShButton variant="primary" size="lg" onclick={() => openURL(PATREON_URL)}>
                    <HeartIcon size={16} />
                    {language.supportButton}
                    <ExternalLinkIcon size={13} />
                </ShButton>
                {#if data?.nameUrl}
                    <ShButton variant="outline" onclick={() => openURL(data.nameUrl)}>
                        <UserPenIcon size={14} />
                        {language.supportSetName}
                    </ShButton>
                {/if}
            </div>
            <p class="max-w-xs text-xs leading-relaxed text-textcolor2">{language.supportNotice}</p>
            {#if language.supportNoticeWarn}
                <ShAlert variant="warning" className="max-w-sm">
                    {#snippet icon()}<TriangleAlertIcon />{/snippet}
                    {language.supportNoticeWarn}
                </ShAlert>
            {/if}
        </div>
    </div>

    <!-- Supporters -->
    <div class="flex flex-col gap-4">
        {#if data?.disabled}
            <span class="text-sm text-textcolor2">{language.supportDisabled}</span>
        {:else if loading && !data}
            <div class="flex flex-wrap gap-2" aria-busy="true">
                {#each Array(10) as _}
                    <span class="h-7 w-20 rounded-full bg-selected/40 animate-pulse"></span>
                {/each}
            </div>
        {:else if failed && !data}
            <ShAlert variant="warning">
                <span class="flex items-center justify-between gap-2 w-full">
                    {language.supportLoadFailed}
                    <ShButton size="sm" variant="outline" onclick={load}>{language.supportRetry}</ShButton>
                </span>
            </ShAlert>
        {:else if data}
            <!-- Two cards are the tabs: bordered, hover/press feedback, selected one lit in the accent. -->
            <div class="flex flex-col items-center gap-2" role="tablist">
                <div class="grid w-full max-w-sm grid-cols-2 gap-2">
                    {#each [
                        { key: 'members', n: active.length, label: language.supportStatActive },
                        { key: 'lifetime', n: all.length, label: language.supportStatLifetime },
                    ] as t (t.key)}
                        <button
                            type="button"
                            role="tab"
                            aria-selected={tab === t.key}
                            class={cn(
                                'flex flex-col items-center gap-0.5 rounded-xl border px-4 py-3 transition-all active:scale-[0.97]',
                                tab === t.key
                                    ? 'border-primary bg-primary/10 text-primary'
                                    : 'border-darkborderc bg-selected/30 text-textcolor2 hover:border-borderc hover:bg-selected/60 hover:text-textcolor'
                            )}
                            onclick={() => tab = t.key as typeof tab}
                        >
                            <span class="text-3xl font-bold leading-none">{t.n}</span>
                            <span class="text-xs">{t.label}</span>
                        </button>
                    {/each}
                </div>
                <span class="text-sm text-textcolor2">
                    {tab === 'members' ? language.supportCaptionActive : language.supportCaptionLifetime}
                </span>
            </div>

            <div class="flex flex-col gap-6 pt-2" role="tabpanel">
                {#if all.length === 0}
                    <span class="text-sm text-textcolor2 py-4 text-center">{language.supportEmpty}</span>
                {:else if tab === 'members'}
                    {#each tierGroups as g (g.key)}
                        <div class="flex flex-col items-center gap-3">
                            <div class="flex items-center gap-2">
                                <span class={cn('text-base font-semibold', g.rank === 0 ? 'text-primary' : 'text-textcolor')}>{g.title}</span>
                                {#if g.badge}
                                    <ShBadge variant="secondary" size="xs">{g.badge}</ShBadge>
                                {/if}
                            </div>
                            <div class="flex flex-wrap justify-center gap-2">
                                {#each g.members as s}
                                    <span class={chipClass(g.rank)}>{s.name}</span>
                                {/each}
                            </div>
                        </div>
                    {/each}
                {:else}
                    <div class="flex flex-wrap justify-center gap-2">
                        {#each all as s}
                            <span class={chipClass(maxBucket - s.bucket)}>
                                {s.name}
                                {#if bucketLabel(s.bucket)}
                                    <span class={cn('text-[0.7em] font-normal', maxBucket - s.bucket <= 1 ? 'text-primary' : 'text-textcolor2')}>{bucketLabel(s.bucket)}</span>
                                {/if}
                            </span>
                        {/each}
                    </div>
                {/if}
            </div>

            <!-- Upstream credit: last thing on the card, centered, with room to breathe. -->
            <button
                type="button"
                class="mx-auto pt-6 pb-1 text-xs text-textcolor2 hover:text-textcolor"
                onclick={() => openURL(UPSTREAM_PATREON_URL)}
            >
                {language.supportUpstream} →
            </button>
        {/if}
    </div>
</ShDialog>

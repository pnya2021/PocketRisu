<script lang="ts">
    import { language } from "src/lang";
    import { DBState } from "src/ts/stores.svelte";
    import SettingPage from "src/lib/UI/GUI/SettingPage.svelte";
    import ShToggle from "src/lib/UI/GUI/ShToggle.svelte";

    
</script>

<SettingPage title={language.hotkey}>
{#if window.innerWidth < 768}
    <p class="text-sm text-textcolor2">
        {language.screenTooSmall}
    </p>

{:else}

    <!-- Row per action: label left, modifier toggles + key capture right. -->
    <div class="flex flex-col [&>*:first-child]:border-t-0">
        {#each DBState.db.hotkeys as hotkey}
            {#if language.hotkeyDesc[hotkey.action]}
                <div class="flex items-center justify-between gap-3 py-2 border-t border-darkborderc">
                    <span class="text-sm text-textcolor min-w-0">{language.hotkeyDesc[hotkey.action]}</span>
                    <div class="flex items-center gap-1.5 shrink-0">
                        <ShToggle size="sm" pressed={!!hotkey.ctrl} onPressedChange={() => { hotkey.ctrl = !hotkey.ctrl; }}>Ctrl</ShToggle>
                        <ShToggle size="sm" pressed={!!hotkey.shift} onPressedChange={() => { hotkey.shift = !hotkey.shift; }}>Shift</ShToggle>
                        <ShToggle size="sm" pressed={!!hotkey.alt} onPressedChange={() => { hotkey.alt = !hotkey.alt; }}>Alt</ShToggle>
                        <input
                            value={hotkey.key === ' ' ? "SPACE" : hotkey.key?.toLocaleUpperCase()}
                            aria-label={`${language.hotkeyDesc[hotkey.action]} key`}
                            class="h-8 w-20 rounded-md border border-darkborderc bg-transparent text-center text-sm text-textcolor outline-none focus-visible:border-borderc focus-visible:ring-2 focus-visible:ring-borderc/50"
                            onkeydown={(e) => {
                                e.preventDefault();
                                hotkey.key = e.key;
                            }}
                        >
                    </div>
                </div>
            {/if}
        {/each}
    </div>
{/if}
</SettingPage>
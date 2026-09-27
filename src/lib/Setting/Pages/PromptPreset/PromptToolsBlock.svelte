<script lang="ts">
    import { language } from "src/lang";
    import { DBState } from "src/ts/stores.svelte";
    import ShSwitch from "src/lib/UI/GUI/ShSwitch.svelte";
    import SettingRowLayout from "../../Wrappers/SettingRowLayout.svelte";
</script>

<div class="[&>*:first-child]:border-t-0">
    <SettingRowLayout item={{ id: 'promptPreset.searchTool', type: 'custom', fallbackLabel: language.search, helpKey: 'searchTool' }}>
        {#snippet control()}
            <ShSwitch
                checked={DBState.db.modelTools.includes('search')}
                onCheckedChange={() => {
                    if (DBState.db.modelTools.includes('search')) {
                        DBState.db.modelTools = DBState.db.modelTools.filter((tool) => tool !== 'search');
                    } else {
                        DBState.db.modelTools.push('search');
                    }
                }}
            />
        {/snippet}
    </SettingRowLayout>
</div>

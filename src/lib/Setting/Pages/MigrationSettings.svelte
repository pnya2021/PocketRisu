<script lang="ts">
    import { language } from "src/lang";
    import SettingPage from "src/lib/UI/GUI/SettingPage.svelte";
    import ShButton from "src/lib/UI/GUI/ShButton.svelte";
    import ShAlert from "src/lib/UI/GUI/ShAlert.svelte";
    import ShAccordion from "src/lib/UI/GUI/ShAccordion.svelte";
    import { alertConfirm } from "src/ts/alert";
    import {
        LoadLocalBackup,
        SaveLocalBackupForUpstream,
        SavePartialLocalBackup,
        ImportFromSaveZip,
        CleanupMigratedFiles,
    } from "src/ts/drive/backuplocal";
    import { exportAsDataset } from "src/ts/storage/exportAsDataset";
    import { openSettings, SettingsRoute, SystemTab } from "src/ts/routing";
    import { InfoIcon } from "@lucide/svelte";

    function gotoBackupTab() {
        openSettings(SettingsRoute.System, SystemTab.Backups);
    }
</script>

<!-- Action rows (label + description left, button right) — same grammar
     as the row-layout settings pages. -->
{#snippet actionRow(label: string, desc: string | undefined, buttonText: string, onclick: () => unknown)}
    <div class="flex items-center justify-between gap-3 py-3 border-t border-darkborderc first:border-t-0">
        <div class="flex flex-col min-w-0">
            <span class="text-sm text-textcolor">{label}</span>
            {#if desc}<p class="text-xs text-textcolor2 mt-0.5">{desc}</p>{/if}
        </div>
        <ShButton variant="outline" size="sm" className="shrink-0" {onclick}>{buttonText}</ShButton>
    </div>
{/snippet}

<SettingPage title={language.migration}>
    <p class="text-textcolor2 text-sm leading-relaxed mb-4">{language.migrationDesc}</p>

    <ShAlert variant="info" className="mb-4">
        {#snippet icon()}<InfoIcon />{/snippet}
        {#snippet title()}{language.migrationInfoBackupMoved}{/snippet}
        {#snippet action()}
            <ShButton variant="outline" size="sm" onclick={gotoBackupTab}>
                {language.migrationGotoBackupTab}
            </ShButton>
        {/snippet}
    </ShAlert>


    <!-- Migration: upstream RisuAI ↔ NodeOnly ─────────────────────────── -->
    <div class="flex flex-col">
        {@render actionRow(language.saveBackupForUpstream, undefined, language.settingActionExport, async () => {
            if (await alertConfirm(language.saveBackupForUpstreamConfirm)) {
                SaveLocalBackupForUpstream();
            }
        })}
        {@render actionRow(language.migrationLoadUpstreamBackup, undefined, language.settingActionImport, async () => {
            if ((await alertConfirm(language.backupLoadConfirm)) && (await alertConfirm(language.backupLoadConfirm2))) {
                LoadLocalBackup();
            }
        })}
    </div>

    <!-- Save folder import (collapsed by default) ────────────────────── -->
    <div class="mt-6">
        <ShAccordion name={language.migrationSaveFolderAccordion} variant="card">
            <p class="text-textcolor2 text-sm leading-relaxed mb-1">{language.migrationSaveFolderDesc}</p>
            <div class="flex flex-col">
                {@render actionRow(language.importSaveZip, language.importSaveZipDesc, language.settingActionImport, ImportFromSaveZip)}
                {@render actionRow(language.cleanupMigratedFiles, language.cleanupMigratedDesc, language.run, CleanupMigratedFiles)}
            </div>
        </ShAccordion>
    </div>

    <!-- Legacy backup options (collapsed by default) ──────────────────── -->
    <div class="mt-3">
        <ShAccordion name={language.migrationLegacyAccordion} variant="card">
            <p class="text-textcolor2 text-sm leading-relaxed mb-1">{language.migrationLegacyDesc}</p>
            <div class="flex flex-col">
                {@render actionRow(language.savePartialLocalBackup, undefined, language.settingActionExport, async () => {
                    if (await alertConfirm(language.backupConfirm)) {
                        SavePartialLocalBackup();
                    }
                })}
                {@render actionRow(language.exportAsDataset, undefined, language.settingActionExport, exportAsDataset)}
            </div>
        </ShAccordion>
    </div>
</SettingPage>

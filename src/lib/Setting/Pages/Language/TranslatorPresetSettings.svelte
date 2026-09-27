<script lang="ts">
    import { DownloadIcon, HardDriveUploadIcon, PencilIcon, PlusIcon, TrashIcon } from "@lucide/svelte";
    import ShButton from "src/lib/UI/GUI/ShButton.svelte";
    import NumberInput from "src/lib/UI/GUI/NumberInput.svelte";
    import TextAreaInput from "src/lib/UI/GUI/TextAreaInput.svelte";
    import ShSelect from "src/lib/UI/GUI/ShSelect.svelte";
    import OptionInput from "src/lib/UI/GUI/OptionInput.svelte";
    import { alertConfirm, alertError, alertInput, notifySuccess, notifyError } from "src/ts/alert";
    import { downloadFile } from "src/ts/globalApi.svelte";
    import { DBState } from "src/ts/stores.svelte";
    import {
        createTranslatorPreset,
        decodeTranslatorPresetFile,
        defaultTranslatorPrompt,
        encodeTranslatorPresetFile,
        getTranslatorPresetDownloadName,
        normalizeTranslatorPresetState,
        syncCurrentTranslatorPresetToLegacyFields,
        translatorPresetImportExtensions,
    } from "src/ts/translator/presets";
    import { selectSingleFile } from "src/ts/util";
    import { language } from "src/lang";

    function normalizeTranslatorPresets() {
        normalizeTranslatorPresetState(DBState.db);
    }

    function syncCurrentTranslatorPreset() {
        syncCurrentTranslatorPresetToLegacyFields(DBState.db);
    }
</script>

<!-- Row-layout block: preset picker row + icon toolbar, then the preset's
     own fields (response size row, prompt textarea). -->
<div class="py-3 border-t border-darkborderc">
<div class="flex items-center justify-between gap-3">
    <div class="flex flex-col min-w-0">
        <span class="text-sm text-textcolor">{language.presets}</span>
        <p class="text-xs text-textcolor2 mt-0.5">{language.help.translatorPreset}</p>
    </div>
<ShSelect
    className="w-48 shrink-0"
    size="sm"
    value={DBState.db.translatorPresetId}
    onchange={(e) => {
        DBState.db.translatorPresetId = Number((e.target as HTMLSelectElement).value);
        syncCurrentTranslatorPreset();
    }}
>
    {#each DBState.db.translatorPresets as preset, i}
        <OptionInput value={i}>{preset.name}</OptionInput>
    {/each}
</ShSelect>
</div>

<div class="flex items-center justify-end gap-1 mt-2">
    <ShButton
        variant="ghost"
        size="icon-sm"
        className="hover:text-primary"
        onclick={() => {
            const newPreset = createTranslatorPreset();
            const presets = DBState.db.translatorPresets;
            presets.push(newPreset);
            DBState.db.translatorPresets = presets;
            DBState.db.translatorPresetId = DBState.db.translatorPresets.length - 1;
            normalizeTranslatorPresets();
        }}
    >
        <PlusIcon size={16} />
    </ShButton>

    <ShButton
        variant="ghost"
        size="icon-sm"
        className="hover:text-primary"
        onclick={async () => {
            const presets = DBState.db.translatorPresets;

            if (presets.length === 0) {
                notifyError("There must be at least one preset.");
                return;
            }

            const id = DBState.db.translatorPresetId;
            const preset = presets[id];
            const newName = await alertInput(`Enter new name for ${preset.name}`, [], preset.name);

            if (!newName || newName.trim().length === 0) return;

            preset.name = newName;
            DBState.db.translatorPresets = presets;
            syncCurrentTranslatorPreset();
        }}
    >
        <PencilIcon size={16} />
    </ShButton>

    <ShButton
        variant="ghost"
        size="icon-sm"
        className="hover:text-red-400"
        onclick={async () => {
            const presets = DBState.db.translatorPresets;

            if (presets.length <= 1) {
                notifyError("There must be at least one preset.");
                return;
            }

            const id = DBState.db.translatorPresetId;
            const preset = presets[id];
            const confirmed = await alertConfirm(`${language.removeConfirm}${preset.name}`);

            if (!confirmed) return;

            DBState.db.translatorPresetId = 0;
            presets.splice(id, 1);
            DBState.db.translatorPresets = presets;
            normalizeTranslatorPresets();
        }}
    >
        <TrashIcon size={16} />
    </ShButton>

    <div class="mx-1 w-px h-5 bg-darkborderc"></div>

    <ShButton
        variant="ghost"
        size="icon-sm"
        className="hover:text-primary"
        onclick={async () => {
            try {
                const presets = DBState.db.translatorPresets;

                if (presets.length === 0) {
                    notifyError("There must be at least one preset.");
                    return;
                }

                const preset = presets[DBState.db.translatorPresetId];
                await downloadFile(
                    getTranslatorPresetDownloadName(preset.name),
                    await encodeTranslatorPresetFile(preset)
                );
                notifySuccess(language.successExport);
            } catch (error) {
                alertError(`${error}`);
            }
        }}
    >
        <DownloadIcon size={16} />
    </ShButton>

    <ShButton
        variant="ghost"
        size="icon-sm"
        className="hover:text-primary"
        onclick={async () => {
            try {
                const selectedFile = await selectSingleFile(translatorPresetImportExtensions);

                if (!selectedFile) return;

                const newPreset = await decodeTranslatorPresetFile(selectedFile.data);
                const presets = DBState.db.translatorPresets;

                presets.push(newPreset);
                DBState.db.translatorPresets = presets;
                DBState.db.translatorPresetId = DBState.db.translatorPresets.length - 1;
                normalizeTranslatorPresets();

                notifySuccess(language.successImport);
            } catch (error) {
                alertError(`${error}`);
            }
        }}
    >
        <HardDriveUploadIcon size={16} />
    </ShButton>
</div>
</div>

{#if DBState.db.translatorPresets?.[DBState.db.translatorPresetId]}
    {@const preset = DBState.db.translatorPresets[DBState.db.translatorPresetId]}
    <div class="flex items-center justify-between gap-3 py-3 border-t border-darkborderc">
        <div class="flex flex-col min-w-0">
            <span class="text-sm text-textcolor">{language.translationResponseSize}</span>
            <p class="text-xs text-textcolor2 mt-0.5">{language.help.translationResponseSize}</p>
        </div>
    <NumberInput
        className="w-24 shrink-0"
        size="sm"
        padding={true}
        min={0}
        max={2048}
        bind:value={() => preset.maxResponse, (value) => {
            preset.maxResponse = value;
            syncCurrentTranslatorPreset();
        }}
    />
    </div>
    <div class="py-3 border-t border-darkborderc">
    <span class="text-sm text-textcolor">{language.translatorPrompt}</span>
    <p class="text-xs text-textcolor2 mt-0.5">{language.help.translatorPrompt}</p>
    <TextAreaInput
        className="mt-2"
        bind:value={() => preset.prompt, (value) => {
            preset.prompt = value;
            syncCurrentTranslatorPreset();
        }}
        placeholder={defaultTranslatorPrompt}
    />
    </div>
{/if}

<script lang="ts">
    import { DBState } from 'src/ts/stores.svelte';
    import { language } from "src/lang";
    import ShToggle from "src/lib/UI/GUI/ShToggle.svelte";

    const characterSets = [
        'Latn', 'Hani', 'Arab', 'Deva', 'Cyrl', 'Beng', 'Hira', 'Kana', 'Telu', 'Hang',
        'Taml', 'Thai', 'Gujr', 'Knda', 'Ethi', 'Khmr', 'Grek', 'Hebr',
    ];

    const characterSetsPreview: Record<string, string> = {
        'Latn': "ABC", 'Hani': "汉漢", 'Arab': "اعب", 'Deva': "अआइ", 'Cyrl': "АБВ",
        'Beng': "অআই", 'Hira': "あい", 'Kana': "アイ", 'Telu': "అఆఇ", 'Hang': "가나다",
        'Taml': "அஆஇ", 'Thai': "กขค", 'Gujr': "અઆઇ", 'Knda': "ಅಆಇ", 'Ethi': "ሀሁሂ",
        'Khmr': "កខគ", 'Grek': "ΑΒΓ", 'Hebr': "אבג",
    };

    const scriptNames = new Intl.DisplayNames([navigator.language, 'en'], { type: 'script' });

    function toggle(set: string) {
        if (DBState.db.banCharacterset.includes(set)) {
            DBState.db.banCharacterset = DBState.db.banCharacterset.filter((item) => item !== set)
        } else {
            DBState.db.banCharacterset.push(set)
        }
    }
</script>

<!-- Row-layout field: label + help on top, the script chips wrap below. -->
<div class="py-3 border-t border-darkborderc">
    <span class="text-sm text-textcolor">{language.banCharacterset}</span>
    <p class="text-xs text-textcolor2 mt-0.5">{language.banCharactersetDesc}</p>
    <div class="flex flex-wrap gap-1.5 mt-2">
        {#each characterSets as set}
            <ShToggle
                size="sm"
                pressed={DBState.db.banCharacterset.includes(set)}
                onPressedChange={() => toggle(set)}
            >
                {scriptNames.of(set)} ({characterSetsPreview[set]})
            </ShToggle>
        {/each}
    </div>
</div>

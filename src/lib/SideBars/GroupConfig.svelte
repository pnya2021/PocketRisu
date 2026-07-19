<script lang="ts">
    import { PlusIcon, TrashIcon } from '@lucide/svelte'
    import type { character, groupChat } from '../../ts/storage/database.svelte'

    let {
        group,
        records,
        onAddMember = () => undefined,
        onChooseImage = () => undefined,
        onComposeImage = () => undefined,
    } = $props<{
        group: groupChat
        records: readonly (character | groupChat)[]
        onAddMember?: () => void | Promise<void>
        onChooseImage?: () => void | Promise<void>
        onComposeImage?: () => void | Promise<void>
    }>()

    const characterById = (id: string) => records.find(
        (record): record is character => record.type === 'character' && record.chaId === id,
    )

    const removeMember = (index: number) => {
        group.characters.splice(index, 1)
        group.characterTalks.splice(index, 1)
        group.characterActive.splice(index, 1)
    }
</script>

<section
    class="flex min-w-0 flex-col gap-4 p-2 text-textcolor"
    data-group-config
    data-narrow-layout={window.innerWidth <= 640 ? 'true' : 'false'}
>
    <label class="flex min-w-0 flex-col gap-1">
        <span>Group name</span>
        <input class="min-w-0 rounded-md border border-darkborderc bg-darkbg p-2" bind:value={group.name} />
    </label>

    <div class="grid min-w-0 grid-cols-1 gap-2 sm:grid-cols-2">
        {#each group.characters as memberId, index (memberId + ':' + index)}
            {@const member = characterById(memberId)}
            <article
                class="grid min-w-0 grid-cols-[minmax(0,1fr)_auto] gap-2 rounded-md border border-darkborderc p-3"
                data-group-member-id={memberId}
                data-missing={member ? 'false' : 'true'}
            >
                <div class="min-w-0">
                    <div class="truncate font-semibold">{member?.name ?? `Missing member (${memberId})`}</div>
                    <label class="mt-2 flex min-w-0 flex-col gap-1 text-sm">
                        <span>Talkness</span>
                        <input
                            class="w-full min-w-0"
                            type="range"
                            min="0"
                            max="1"
                            step={1 / 6}
                            bind:value={group.characterTalks[index]}
                            data-member-talkness={memberId}
                        />
                    </label>
                    <label class="mt-2 flex items-center gap-2 text-sm">
                        <input type="checkbox" bind:checked={group.characterActive[index]} />
                        <span>Active</span>
                    </label>
                </div>
                <button
                    class="self-start rounded p-1 text-textcolor2 hover:text-red-400"
                    aria-label={`Remove ${member?.name ?? memberId}`}
                    data-remove-group-member={memberId}
                    onclick={() => removeMember(index)}
                >
                    <TrashIcon size={18} />
                </button>
            </article>
        {/each}
    </div>

    <button class="flex items-center gap-2 self-start rounded-md border border-darkborderc px-3 py-2" onclick={onAddMember}>
        <PlusIcon size={18} />
        <span>Add member</span>
    </button>

    <div class="flex flex-wrap gap-4" data-group-order-control>
        <label class="flex items-center gap-2">
            <input type="checkbox" bind:checked={group.orderByOrder} />
            <span>Use configured order</span>
        </label>
        <label class="flex items-center gap-2">
            <input type="checkbox" bind:checked={group.useCharacterLore} />
            <span>Use member lore</span>
        </label>
    </div>

    <div class="flex min-w-0 flex-wrap gap-2" data-group-image-controls>
        <button class="rounded-md border border-darkborderc px-3 py-2" onclick={onChooseImage}>Choose group image</button>
        <button class="rounded-md border border-darkborderc px-3 py-2" onclick={onComposeImage}>Build member collage</button>
        {#if group.image}
            <button class="rounded-md border border-darkborderc px-3 py-2 text-red-400" onclick={() => group.image = ''}>Clear image</button>
        {/if}
    </div>
</section>

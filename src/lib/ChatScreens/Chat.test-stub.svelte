<script lang="ts">
    let {
        message = '',
        name = '',
        role = '',
        character = null,
    } = $props<{
        message?: string
        name?: string
        role?: string
        character?: { chaId?: string } | string | null
    }>()
</script>

<article data-stub-chat data-role={role} data-character={typeof character === 'object' ? character?.chaId ?? '' : character ?? ''}>
    <h2>{name}</h2>
    <p>{message}</p>
</article>

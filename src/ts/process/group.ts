import type { Message, character, groupChat } from '../storage/database.svelte'

export interface ResolvedGroupMember {
    id: string
    index: number
    card: character
    talkness: number
    active: boolean
}

export interface PlanGroupTurnOptions {
    group: groupChat
    records: readonly (character | groupChat)[]
    input: string
    lastSpeakerId?: string
    rng?: () => number
}

export type GroupGenerationMode = 'send' | 'continue' | 'reroll'

export interface ResolvedGroupGenerationRequest {
    mode: GroupGenerationMode
    continue: boolean
    saying: string
    targetMessageIndex?: number
    signal?: AbortSignal
}

export interface RunGroupGenerationOptions {
    group: groupChat
    records: readonly (character | groupChat)[]
    messages: readonly Message[]
    mode: GroupGenerationMode
    rerollSpeakerId?: string
    signal?: AbortSignal
    rng?: () => number
    generate: (
        speaker: character,
        request: ResolvedGroupGenerationRequest,
    ) => Promise<boolean>
}

const clampProbability = (value: unknown): number => {
    if (typeof value !== 'number' || !Number.isFinite(value)) return 2 / 3
    return Math.max(0, Math.min(1, value))
}

const randomUnit = (rng: () => number): number => {
    const value = rng()
    if (!Number.isFinite(value)) return 0
    return Math.max(0, Math.min(0.9999999999999999, value))
}

const words = (value: string): string[] =>
    value.toLocaleLowerCase().match(/[\p{L}\p{N}_]+/gu) ?? []

/**
 * Resolve the group's declared membership without ever falling back to the
 * synthetic "Unknown Character" card. The first declaration wins so the
 * aligned talkness/active arrays remain deterministic when a malformed group
 * contains duplicate IDs.
 */
export function resolveGroupMembers(
    group: groupChat,
    records: readonly (character | groupChat)[],
): ResolvedGroupMember[] {
    const characters = new Map<string, character>()
    for (const record of records) {
        if (record?.type === 'character' && typeof record.chaId === 'string' && !characters.has(record.chaId)) {
            characters.set(record.chaId, record)
        }
    }

    const seen = new Set<string>()
    const result: ResolvedGroupMember[] = []
    for (let index = 0; index < group.characters.length; index += 1) {
        const id = group.characters[index]
        if (typeof id !== 'string' || seen.has(id)) continue
        const card = characters.get(id)
        if (!card) continue
        seen.add(id)
        result.push({
            id,
            index,
            card,
            talkness: clampProbability(group.characterTalks?.[index]),
            active: group.characterActive?.[index] !== false,
        })
    }
    return result
}

export function resolveGroupMessageSpeaker(
    group: groupChat,
    records: readonly (character | groupChat)[],
    message: Pick<Message, 'role' | 'saying'>,
): character | undefined {
    if (message.role !== 'char' || typeof message.saying !== 'string') return undefined
    return resolveGroupMembers(group, records).find((member) => member.id === message.saying)?.card
}

export function createGroupGreetingMessages(
    group: groupChat,
    records: readonly (character | groupChat)[],
): Message[] {
    return resolveGroupMembers(group, records).map(({ card, id }) => ({
        role: 'char',
        data: card.firstMessage,
        saying: id,
    }))
}

function shuffled<T>(input: readonly T[], rng: () => number): T[] {
    const result = [...input]
    for (let index = result.length - 1; index > 0; index -= 1) {
        const swap = Math.floor(randomUnit(rng) * (index + 1))
        ;[result[index], result[swap]] = [result[swap], result[index]]
    }
    return result
}

/**
 * Pure group-turn planner. Mentioned members are emitted in mention order;
 * remaining members are chance-selected using the injected RNG. If chance
 * selects nobody, exactly one eligible member is selected, preferring someone
 * other than the last speaker when possible.
 */
export function planGroupTurn(options: PlanGroupTurnOptions): ResolvedGroupMember[] {
    const rng = options.rng ?? Math.random
    const eligible = resolveGroupMembers(options.group, options.records)
        .filter((member) => member.active && member.talkness > 0)
    if (eligible.length === 0) return []
    if (options.group.orderByOrder) return eligible

    const selected: ResolvedGroupMember[] = []
    const selectedIds = new Set<string>()
    const nameWords = new Map(eligible.map((member) => [member.id, new Set(words(member.card.name ?? ''))]))

    for (const word of words(options.input ?? '')) {
        const mentioned = eligible.find((member) => nameWords.get(member.id)?.has(word))
        if (mentioned && !selectedIds.has(mentioned.id)) {
            selected.push(mentioned)
            selectedIds.add(mentioned.id)
        }
    }

    const avoidLast = eligible.length > 1
    const remainder = eligible.filter((member) =>
        !selectedIds.has(member.id)
        && (!avoidLast || member.id !== options.lastSpeakerId),
    )
    for (const member of shuffled(remainder, rng)) {
        if (member.talkness >= randomUnit(rng)) {
            selected.push(member)
            selectedIds.add(member.id)
        }
    }

    if (selected.length === 0) {
        const nonLast = eligible.filter((member) => member.id !== options.lastSpeakerId)
        const fallback = nonLast.length > 0 ? nonLast : eligible
        selected.push(fallback[Math.floor(randomUnit(rng) * fallback.length)])
    }

    return selected
}

const isActionable = (message: Message): boolean =>
    !message.isComment && message.disabled !== true && message.disabled !== 'allBefore'

export function buildGroupSpeakerInstruction(speaker: character): string {
    return `[Write the next reply only as ${speaker.name}. Do not write dialogue or actions for any other group member.]`
}

/**
 * Resolve speakers before entering the shared single-speaker generation body.
 * This function deliberately knows nothing about tokenizer, transport, stream,
 * trigger, Inlay, TTS, or commit details; production supplies that one common
 * boundary through `generate` and each turn awaits it sequentially.
 */
export async function runGroupGeneration(options: RunGroupGenerationOptions): Promise<boolean> {
    const members = resolveGroupMembers(options.group, options.records)
    const memberById = new Map(members.map((member) => [member.id, member]))
    const actionable = options.messages
        .map((message, index) => ({ message, index }))
        .filter(({ message }) => isActionable(message))
    let selected: ResolvedGroupMember[] = []
    let targetMessageIndex: number | undefined

    if (options.mode === 'continue') {
        const latest = actionable.at(-1)
        const member = latest?.message.role === 'char' && latest.message.saying
            ? memberById.get(latest.message.saying)
            : undefined
        if (member) {
            selected = [member]
            targetMessageIndex = latest?.index
        }
    }
    else if (options.mode === 'reroll') {
        const member = options.rerollSpeakerId
            ? memberById.get(options.rerollSpeakerId)
            : undefined
        if (member) selected = [member]
    }
    else {
        const lastSpeakerId = [...actionable]
            .reverse()
            .find(({ message }) => message.role === 'char' && message.saying && memberById.has(message.saying))
            ?.message.saying
        selected = planGroupTurn({
            group: options.group,
            records: options.records,
            input: actionable.at(-1)?.message.data ?? '',
            lastSpeakerId,
            rng: options.rng,
        })
    }

    if (selected.length === 0) return false
    for (const member of selected) {
        if (options.signal?.aborted) return false
        const generated = await options.generate(member.card, {
            mode: options.mode,
            continue: options.mode === 'continue',
            saying: member.id,
            targetMessageIndex,
            signal: options.signal,
        })
        if (!generated) return false
    }
    return true
}

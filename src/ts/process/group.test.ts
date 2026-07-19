import { describe, expect, it } from 'vitest'

import type { character, groupChat } from '../storage/database.svelte'
import {
    createGroupGreetingMessages,
    planGroupTurn,
    resolveGroupMembers,
    resolveGroupMessageSpeaker,
} from './group'

const card = (id: string, name: string): character => ({
    type: 'character',
    chaId: id,
    name,
    firstMessage: `${name} hello`,
} as character)

const group = (overrides: Partial<groupChat> = {}): groupChat => ({
    type: 'group',
    chaId: 'room',
    name: 'Room',
    characters: ['alice', 'bob', 'cara'],
    characterTalks: [1, 1, 1],
    characterActive: [true, true, true],
    orderByOrder: false,
    chats: [{ message: [], localLore: [], name: 'Chat', note: '' }],
    chatPage: 0,
    ...overrides,
} as groupChat)

const records = [
    card('alice', 'Alice Smith'),
    card('bob', 'Bob'),
    card('cara', 'Cara'),
]

describe('resolveGroupMembers', () => {
    it('authorizes only stable-deduped member IDs backed by character cards', () => {
        const nested = group({ chaId: 'nested', characters: [] })
        const room = group({
            characters: ['alice', 'missing', 'nested', 'alice', 'bob'],
            characterTalks: [0.2, 1, 1, 0.9, 0.6],
            characterActive: [true, true, true, true, false],
        })

        expect(resolveGroupMembers(room, [...records, nested])).toEqual([
            expect.objectContaining({ id: 'alice', index: 0, talkness: 0.2, active: true, card: records[0] }),
            expect.objectContaining({ id: 'bob', index: 4, talkness: 0.6, active: false, card: records[1] }),
        ])
    })

    it('never resolves a missing ID or nested group as a message speaker', () => {
        const room = group({ characters: ['alice', 'nested'] })
        const nested = group({ chaId: 'nested', characters: [] })

        expect(resolveGroupMessageSpeaker(room, [...records, nested], { role: 'char', saying: 'alice' }))
            .toBe(records[0])
        expect(resolveGroupMessageSpeaker(room, [...records, nested], { role: 'char', saying: 'missing' }))
            .toBeUndefined()
        expect(resolveGroupMessageSpeaker(room, [...records, nested], { role: 'char', saying: 'nested' }))
            .toBeUndefined()
        expect(resolveGroupMessageSpeaker(room, [...records, nested], { role: 'char', saying: 'bob' }))
            .toBeUndefined()
    })

    it('seeds greetings only from valid declared character members', () => {
        const nested = group({ chaId: 'nested', characters: [] })
        const room = group({ characters: ['alice', 'missing', 'nested', 'bob', 'alice'] })

        expect(createGroupGreetingMessages(room, [...records, nested])).toEqual([
            { role: 'char', data: 'Alice Smith hello', saying: 'alice' },
            { role: 'char', data: 'Bob hello', saying: 'bob' },
        ])
    })
})

describe('planGroupTurn', () => {
    it('prioritizes mentioned eligible members and never duplicates them', () => {
        const result = planGroupTurn({
            group: group(),
            records,
            input: 'BOB, please ask Alice Smith. Bob!',
            rng: () => 0,
        })

        expect(result.map((member) => member.id)).toEqual(['bob', 'alice', 'cara'])
    })

    it('uses injected randomness for a deterministic shuffled remainder', () => {
        const values = [0.9, 0.1, 0.4, 0.2, 0.8, 0.3]
        const run = () => {
            let index = 0
            return planGroupTurn({
                group: group({ characterTalks: [0.5, 0.5, 0.5] }),
                records,
                input: '',
                rng: () => values[index++ % values.length],
            }).map((member) => member.id)
        }

        expect(run()).toEqual(run())
    })

    it('keeps configured member order in ordered mode', () => {
        const result = planGroupTurn({
            group: group({
                orderByOrder: true,
                characters: ['cara', 'missing', 'alice', 'bob'],
                characterTalks: [1, 1, 1, 1],
                characterActive: [true, true, false, true],
            }),
            records,
            input: 'Alice',
            rng: () => 0.99,
        })

        expect(result.map((member) => member.id)).toEqual(['cara', 'bob'])
    })

    it('returns no turn for empty, invalid, or all-disabled membership', () => {
        expect(planGroupTurn({ group: group({ characters: [] }), records, input: '', rng: () => 0 })).toEqual([])
        expect(planGroupTurn({
            group: group({ characters: ['missing'], characterTalks: [1], characterActive: [true] }),
            records,
            input: '',
            rng: () => 0,
        })).toEqual([])
        expect(planGroupTurn({
            group: group({ characterActive: [false, false, false] }),
            records,
            input: '',
            rng: () => 0,
        })).toEqual([])
    })

    it('falls back only to an eligible non-last speaker when chance selects nobody', () => {
        const result = planGroupTurn({
            group: group({ characterTalks: [0.1, 0.1, 0], characterActive: [true, true, true] }),
            records,
            input: '',
            lastSpeakerId: 'alice',
            rng: () => 0.99,
        })

        expect(result.map((member) => member.id)).toEqual(['bob'])
    })

    it('allows the last speaker only when it is the sole eligible fallback', () => {
        const result = planGroupTurn({
            group: group({ characterTalks: [0.1, 0, 0], characterActive: [true, true, true] }),
            records,
            input: '',
            lastSpeakerId: 'alice',
            rng: () => 0.99,
        })

        expect(result.map((member) => member.id)).toEqual(['alice'])
    })
})

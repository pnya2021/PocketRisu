import { describe, expect, it, vi } from 'vitest'

import type { Chat, Database, RisuPersona, character, groupChat, loreBook, Message } from '../storage/database.svelte'
import {
    buildGroupSpeakerInstruction,
    runGroupGeneration,
} from './group'
import { collectLorebooksForPrompt } from './lorebook.svelte'
import { resolveModulesForContext, resolveModulesWithReasonsForContext, type RisuModule } from './modules'

const card = (id: string, name: string): character => ({
    type: 'character',
    chaId: id,
    name,
} as character)

const alice = card('alice', 'Alice')
const bob = card('bob', 'Bob')

const room = (overrides: Partial<groupChat> = {}): groupChat => ({
    type: 'group',
    chaId: 'room',
    name: 'Room',
    characters: ['alice', 'bob'],
    characterTalks: [1, 1],
    characterActive: [true, true],
    orderByOrder: true,
    chats: [{ message: [], localLore: [], name: 'Chat', note: '' }],
    chatPage: 0,
    ...overrides,
} as groupChat)

describe('runGroupGeneration', () => {
    it('uses one sequential generation boundary for every resolved member', async () => {
        const calls: string[] = []
        const generate = vi.fn(async (speaker: character, _request: { mode: string, continue: boolean }) => {
            calls.push(`start:${speaker.chaId}`)
            await Promise.resolve()
            calls.push(`done:${speaker.chaId}`)
            return true
        })

        await expect(runGroupGeneration({
            group: room(),
            records: [alice, bob],
            messages: [{ role: 'user', data: 'hello' }],
            mode: 'send',
            generate,
            rng: () => 0,
        })).resolves.toBe(true)

        expect(calls).toEqual(['start:alice', 'done:alice', 'start:bob', 'done:bob'])
        expect(generate).toHaveBeenCalledTimes(2)
        expect(generate.mock.calls.map(([, request]) => request)).toEqual([
            expect.objectContaining({ mode: 'send', continue: false }),
            expect.objectContaining({ mode: 'send', continue: false }),
        ])
    })

    it('awaits streaming completion before starting the next member', async () => {
        const calls: string[] = []
        const generate = async (speaker: character) => {
            calls.push(`start:${speaker.chaId}`)
            const stream = new ReadableStream<string>({
                start(controller) {
                    queueMicrotask(() => {
                        calls.push(`chunk:${speaker.chaId}`)
                        controller.enqueue('done')
                        controller.close()
                    })
                },
            })
            for await (const _chunk of stream) {
                // The production generation boundary owns stream consumption.
            }
            calls.push(`done:${speaker.chaId}`)
            return true
        }

        await runGroupGeneration({
            group: room(), records: [alice, bob], messages: [], mode: 'send', generate,
        })

        expect(calls).toEqual([
            'start:alice', 'chunk:alice', 'done:alice',
            'start:bob', 'chunk:bob', 'done:bob',
        ])
    })

    it('stops at the first failed member under the same abort scope', async () => {
        const signal = new AbortController().signal
        const generate = vi.fn(async (speaker: character, request: { signal?: AbortSignal }) => {
            expect(request.signal).toBe(signal)
            return speaker.chaId !== 'alice'
        })

        await expect(runGroupGeneration({
            group: room(), records: [alice, bob], messages: [], mode: 'send', generate, signal,
        })).resolves.toBe(false)
        expect(generate).toHaveBeenCalledTimes(1)
    })

    it('does zero transport work when no valid enabled member exists', async () => {
        const generate = vi.fn(async () => true)

        await expect(runGroupGeneration({
            group: room({ characters: ['missing'], characterTalks: [1], characterActive: [true] }),
            records: [alice, bob],
            messages: [],
            mode: 'send',
            generate,
        })).resolves.toBe(false)
        expect(generate).not.toHaveBeenCalled()
    })

    it('continues only the latest actionable valid member message and retains its saying', async () => {
        const messages: Message[] = [
            { role: 'char', data: 'A', saying: 'alice' },
            { role: 'char', data: 'B', saying: 'bob' },
            { role: 'char', data: 'comment', isComment: true },
        ]
        const generate = vi.fn(async () => true)

        await expect(runGroupGeneration({
            group: room(), records: [alice, bob], messages, mode: 'continue', generate,
        })).resolves.toBe(true)
        expect(generate).toHaveBeenCalledOnce()
        expect(generate).toHaveBeenCalledWith(bob, expect.objectContaining({
            mode: 'continue', continue: true, saying: 'bob', targetMessageIndex: 1,
        }))
    })

    it('fails Continue safely when latest attribution is missing or unauthorized', async () => {
        for (const messages of [
            [{ role: 'char', data: 'unknown' }] as Message[],
            [{ role: 'char', data: 'nested', saying: 'nested' }] as Message[],
            [{ role: 'user', data: 'latest' }] as Message[],
        ]) {
            const generate = vi.fn(async () => true)
            await expect(runGroupGeneration({
                group: room(),
                records: [alice, bob, room({ chaId: 'nested', characters: [] })],
                messages,
                mode: 'continue',
                generate,
            })).resolves.toBe(false)
            expect(generate).not.toHaveBeenCalled()
        }
    })

    it('rerolls exactly the explicitly attributed member instead of replanning', async () => {
        const generate = vi.fn(async () => true)

        await expect(runGroupGeneration({
            group: room(),
            records: [alice, bob],
            messages: [{ role: 'user', data: 'Bob should answer' }],
            mode: 'reroll',
            rerollSpeakerId: 'alice',
            generate,
            rng: () => 0,
        })).resolves.toBe(true)

        expect(generate).toHaveBeenCalledOnce()
        expect(generate).toHaveBeenCalledWith(alice, expect.objectContaining({
            mode: 'reroll', continue: false, saying: 'alice',
        }))
    })
})

describe('group prompt isolation', () => {
    it('names only the resolved speaker', () => {
        const instruction = buildGroupSpeakerInstruction(bob)
        expect(instruction).toContain('Bob')
        expect(instruction).not.toContain('Alice')
        expect(instruction).toMatch(/only/i)
    })
})

const lore = (id: string): loreBook => ({
    id,
    key: id,
    secondkey: '',
    insertorder: 100,
    comment: id,
    content: id,
    mode: 'normal',
    alwaysActive: false,
    selective: false,
})

describe('group lore and module context', () => {
    it('places group, chat, member, and module lore into the scan input before activation', () => {
        const chat = { localLore: [lore('chat')] } as Chat
        const group = room({ globalLore: [lore('group')], useCharacterLore: true })
        const speaker = { ...alice, globalLore: [lore('member')] } as character

        expect(collectLorebooksForPrompt({
            room: group,
            chat,
            speaker,
            moduleLorebooks: [lore('module')],
        }).map((entry) => entry.id)).toEqual(['group', 'chat', 'member', 'module'])

        group.useCharacterLore = false
        expect(collectLorebooksForPrompt({
            room: group,
            chat,
            speaker,
            moduleLorebooks: [lore('module')],
        }).map((entry) => entry.id)).toEqual(['group', 'chat', 'module'])
    })

    it('returns a stable deduped module union across every authorized source', () => {
        const mod = (id: string, namespace?: string): RisuModule => ({ id, namespace, name: id, description: '' })
        const modules = [
            mod('global'), mod('chat'), mod('group'), mod('alice'), mod('bob'),
            mod('integration'), mod('namespaced', 'alias'), mod('namespaced-2', 'alias'),
        ]
        const group = room({ modules: ['group', 'global'] })
        const chat = { modules: ['chat', 'group'], bindedPersona: 'persona' } as Chat
        const a = { ...alice, modules: ['alice', 'global'] } as character
        const b = { ...bob, modules: ['bob', 'alice'] } as character
        const personaModule = mod('persona-module')
        const persona = { id: 'persona', embeddedModule: personaModule } as RisuPersona
        const db = {
            characters: [group, a, b, room({ chaId: 'nested', characters: [] })],
            modules,
            enabledModules: ['global'],
            moduleIntergration: 'integration, alias',
        } as Database

        expect(resolveModulesForContext(db, { room: group, chat, members: [a, b], persona })
            .map((module) => module.id))
            .toEqual(['global', 'chat', 'group', 'alice', 'bob', 'persona-module', 'integration', 'namespaced', 'namespaced-2'])
    })

    it('reports deterministic activation reasons for group, member, persona, and integration modules', () => {
        const mod = (id: string, namespace?: string): RisuModule => ({ id, namespace, name: id, description: '' })
        const modules = [
            mod('global'), mod('chat'), mod('group'), mod('alice'), mod('bob'),
            mod('integration'), mod('namespaced', 'alias'), mod('namespaced-2', 'alias'),
        ]
        const group = room({ modules: ['group', 'global'] } as Partial<groupChat>)
        const chat = { modules: ['chat', 'group'] } as Chat
        const a = { ...alice, modules: ['alice', 'global'] } as character
        const b = { ...bob, modules: ['bob', 'alice'] } as character
        const personaModule = mod('persona-module')
        const persona = { id: 'persona', embeddedModule: personaModule } as RisuPersona
        const db = {
            characters: [group, a, b],
            modules,
            enabledModules: ['global'],
            moduleIntergration: 'integration, alias',
        } as Database

        expect(resolveModulesWithReasonsForContext(db, { room: group, chat, members: [a, b], persona })
            .map(({ module, activatedBy }) => ({ id: module.id, activatedBy })))
            .toEqual([
                { id: 'global', activatedBy: ['global', 'character'] },
                { id: 'chat', activatedBy: ['chat'] },
                { id: 'group', activatedBy: ['chat', 'character'] },
                { id: 'alice', activatedBy: ['character'] },
                { id: 'bob', activatedBy: ['character'] },
                { id: 'integration', activatedBy: ['integration'] },
                { id: 'namespaced', activatedBy: ['integration'] },
                { id: 'namespaced-2', activatedBy: ['integration'] },
                { id: 'persona-module', activatedBy: ['persona'] },
            ])
    })
})

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mount, tick, unmount } from 'svelte'

vi.mock('./Chat.svelte', async () => import('./Chat.test-stub.svelte'))
vi.mock('src/ts/characters', () => ({ getCharImage: async () => '' }))
vi.mock('src/ts/globalApi.svelte', () => ({
    chatFoldedStateMessageIndex: { index: -1 },
    saveAsset: async () => 'asset',
    downloadFile: async () => undefined,
    aiWatermarkingLawApplies: () => false,
    getFileSrc: async () => '',
    readImage: async () => new Uint8Array(),
    forageStorage: {},
    AppendableBuffer: class {},
    LocalWriter: class {},
    VirtualWriter: class {},
}))

import type { Chat, Database, character, groupChat } from '../../ts/storage/database.svelte'
import { DBState, selIdState, selectedCharID } from '../../ts/stores.svelte'
import Chats from './Chats.svelte'
import GroupConfig from '../SideBars/GroupConfig.svelte'

const chat = (message: Chat['message']): Chat => ({
    id: 'chat', name: 'Chat', note: '', localLore: [], message,
})

const card = (id: string, name: string): character => ({
    type: 'character', chaId: id, name, image: '', largePortrait: false,
    customscript: [], triggerscript: [], emotionImages: [], additionalAssets: [],
    chats: [chat([])], chatPage: 0,
} as character)

const alice = card('alice', 'Alice')
const bob = card('bob', 'Bob')

const room = (messages: Chat['message']): groupChat => ({
    type: 'group', chaId: 'room', name: 'Studio Group', image: '',
    characters: ['alice', 'bob', 'missing'], characterTalks: [1, 1, 1],
    characterActive: [true, true, true], chats: [chat(messages)], chatPage: 0,
    chatFolders: [], globalLore: [], emotionImages: [], customscript: [],
    firstMessage: '', alternateGreetings: [], viewScreen: 'none', autoMode: false,
    useCharacterLore: true,
} as groupChat)

const installDb = (records: Database['characters']) => {
    DBState.db = {
        characters: records,
        autoScrollToNewMessage: false,
        alwaysScrollToNewMessage: false,
        zoomsize: 100,
        lineHeight: 1.25,
        clickToEdit: false,
        enableBlockPartialEdit: false,
        enableDragPartialEdit: false,
        newImageHandlingBeta: false,
        autoTranslate: false,
        showTranslationLoading: false,
        hideChatIcon: false,
        hideMessagePageCount: false,
        theme: '',
        modules: [],
        enabledModules: [],
        personas: [],
    } as unknown as Database
}

beforeEach(() => {
    Object.defineProperty(window, 'innerWidth', { configurable: true, value: 375 })
    document.body.innerHTML = ''
    selIdState.selId = 2
    selectedCharID.set(2)
})

afterEach(() => {
    document.body.innerHTML = ''
})

describe('group chat rendering at 375px', () => {
    it('attributes every message independently to A, B, neutral group, or persona', async () => {
        const messages: Chat['message'] = [
            { role: 'char', data: 'A line', saying: 'alice', chatId: 'm-a' },
            { role: 'char', data: 'B line', saying: 'bob', chatId: 'm-b' },
            { role: 'char', data: 'Narration', saying: 'missing', chatId: 'm-neutral' },
            { role: 'user', data: 'User line', chatId: 'm-user' },
        ]
        const group = room(messages)
        installDb([alice, bob, group])

        const component = mount(Chats, {
            target: document.body,
            props: {
                messages,
                currentCharacter: group,
                currentUsername: 'Persona',
                userIcon: '',
                userIconPortrait: false,
                loadPages: 20,
                onReroll: () => undefined,
                unReroll: () => undefined,
            },
        })
        await tick()
        await tick()

        const identity = (index: number) => document
            .querySelector(`[data-message-index="${index}"]`)
            ?.getAttribute('data-render-identity')
        expect(identity(0)).toBe('character:alice')
        expect(identity(1)).toBe('character:bob')
        expect(identity(2)).toBe('group:room')
        expect(identity(3)).toBe('persona:Persona')
        expect(document.body.textContent).toContain('Alice')
        expect(document.body.textContent).toContain('Bob')
        expect(document.body.textContent).toContain('Studio Group')
        expect(document.body.textContent).toContain('Persona')

        unmount(component)
    })

    it('keeps single-character rendering and parser context unchanged', async () => {
        const messages: Chat['message'] = [
            { role: 'char', data: 'Solo', saying: 'unknown', chatId: 'solo' },
            { role: 'user', data: 'User', chatId: 'solo-user' },
        ]
        const solo = card('solo-card', 'Solo Card')
        solo.chats = [chat(messages)]
        installDb([solo])
        selIdState.selId = 0
        selectedCharID.set(0)

        const component = mount(Chats, {
            target: document.body,
            props: {
                messages,
                currentCharacter: solo,
                currentUsername: 'Persona',
                userIcon: '',
                loadPages: 20,
                onReroll: () => undefined,
                unReroll: () => undefined,
            },
        })
        await tick()

        expect(document.querySelector('[data-message-index="0"]')?.getAttribute('data-render-identity'))
            .toBe('character:solo-card')
        expect(document.querySelector('[data-message-index="1"] [data-stub-chat]')?.getAttribute('data-character'))
            .toBe('solo-card')
        expect(document.body.textContent).toContain('Solo Card')
        unmount(component)
    })

    it('renders removable missing members and narrow-safe group controls', async () => {
        const group = room([])
        installDb([alice, bob, group])

        const component = mount(GroupConfig, {
            target: document.body,
            props: { group, records: DBState.db.characters },
        })
        await tick()

        const config = document.querySelector('[data-group-config]')
        expect(config).toBeTruthy()
        expect(config?.getAttribute('data-narrow-layout')).toBe('true')
        expect(document.querySelectorAll('[data-group-member-id]').length).toBe(3)
        expect(document.querySelector('[data-group-member-id="missing"]')?.getAttribute('data-missing'))
            .toBe('true')
        expect(document.querySelectorAll('input[type="range"][data-member-talkness]').length).toBe(3)
        expect(document.querySelector('[data-group-order-control]')).toBeTruthy()
        expect(document.querySelector('[data-group-image-controls]')).toBeTruthy()

        const remove = document.querySelector('[data-remove-group-member="missing"]') as HTMLButtonElement
        remove.click()
        await tick()
        expect(group.characters).toEqual(['alice', 'bob'])
        expect(group.characterTalks).toHaveLength(2)
        expect(group.characterActive).toHaveLength(2)

        unmount(component)
    })
})

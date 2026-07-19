import { createRequire } from 'node:module'
import { describe, expect, test } from 'vitest'

const require = createRequire(import.meta.url)
const { repairDuplicateCharacterIds, repairChatIdsBeforeIndexing } = require('./groupPersistence.cjs') as {
  repairDuplicateCharacterIds: (
    database: Record<string, any>,
    createId?: () => string,
  ) => { changed: boolean; remapped: Array<{ index: number; originalId: string; newId: string }> }
  repairChatIdsBeforeIndexing: (
    database: Record<string, any>,
    createId?: () => string,
  ) => { changed: boolean; remapped: Array<{ characterIndex: number; chatIndex: number; originalId: unknown; newId: string }> }
}

describe('repairDuplicateCharacterIds', () => {
  test('rekeys duplicate group records before fullChatStore indexing without losing chats', () => {
    const db = {
      characters: [
        {
          type: 'character', chaId: 'duplicate', name: 'Member',
          chats: [{ id: 'member-chat', message: [{ role: 'char', data: 'member' }] }],
        },
        {
          type: 'group', chaId: 'duplicate', name: 'Group', characters: ['duplicate'],
          chats: [{
            id: 'group-chat',
            message: [{ role: 'char', data: 'group', saying: 'duplicate' }],
            pluginState: { keep: true },
          }],
          unknownGroupField: { keep: true },
        },
      ],
    }

    const result = repairDuplicateCharacterIds(db, () => 'repaired-group')

    expect(result).toEqual({
      changed: true,
      remapped: [{ index: 1, originalId: 'duplicate', newId: 'repaired-group' }],
    })
    expect(db.characters.map(record => record.chaId)).toEqual(['duplicate', 'repaired-group'])
    expect(db.characters[1]).toMatchObject({
      type: 'group',
      characters: ['duplicate'],
      unknownGroupField: { keep: true },
      chats: [{
        id: 'group-chat',
        message: [{ data: 'group', saying: 'duplicate' }],
        pluginState: { keep: true },
      }],
    })

    const simulatedFullChatStore = new Map(
      db.characters.map(record => [record.chaId, new Map(record.chats.map(chat => [chat.id, chat]))]),
    )
    expect(simulatedFullChatStore).toHaveLength(2)
    expect(simulatedFullChatStore.get('duplicate')?.get('member-chat')?.message[0].data).toBe('member')
    expect(simulatedFullChatStore.get('repaired-group')?.get('group-chat')?.message[0].data).toBe('group')
  })

  test('is idempotent and avoids IDs already present later in the database', () => {
    const db = {
      characters: [
        { chaId: 'same', chats: [] },
        { chaId: 'same', chats: [] },
        { chaId: 'generated-1', chats: [] },
      ],
    }
    const generated = ['generated-1', 'generated-2']

    expect(repairDuplicateCharacterIds(db, () => generated.shift()!)).toMatchObject({ changed: true })
    expect(db.characters.map(record => record.chaId)).toEqual(['same', 'generated-2', 'generated-1'])
    expect(repairDuplicateCharacterIds(db)).toEqual({ changed: false, remapped: [] })
  })
})

describe('repairChatIdsBeforeIndexing', () => {
  test('repairs duplicates only within one character before building the lazy chat store', () => {
    const db = {
      characters: [
        { chaId: 'a', chats: [{ id: 'shared', message: ['a1'] }, { id: 'shared', message: ['a2'] }] },
        { chaId: 'b', chats: [{ id: 'shared', message: ['b1'] }, { id: '', message: ['b2'] }] },
      ],
    }
    const generated = ['shared', 'a-second', 'b-missing']

    expect(repairChatIdsBeforeIndexing(db, () => generated.shift()!)).toEqual({
      changed: true,
      remapped: [
        { characterIndex: 0, chatIndex: 1, originalId: 'shared', newId: 'a-second' },
        { characterIndex: 1, chatIndex: 1, originalId: '', newId: 'b-missing' },
      ],
    })
    expect(db.characters.map(character => character.chats.map(chat => chat.id)))
      .toEqual([['shared', 'a-second'], ['shared', 'b-missing']])
  })
})

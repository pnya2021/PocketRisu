import { describe, expect, it } from 'vitest'
import {
    MEMORY_PRESET_DEFAULT,
    MEMORY_PRESET_OFF,
    createMemoryPreset,
    getActiveHypaV3Preset,
    getMemoryBinding,
    migrateMemoryPresets,
    resolveMemoryPresetId,
    setChatMemoryPreset,
    syncMemoryMirror,
    type MemoryPresetDb,
} from './memoryPresets'
import { createHypaV3Preset } from './hypav3Preset'

function ids() {
    let n = 0
    return () => `id-${++n}`
}

describe('migrateMemoryPresets', () => {
    it('copies hypaV3Presets into memoryPresets and picks the active one as default', () => {
        const db: MemoryPresetDb = {
            hypaV3: true,
            hypaV3Presets: [createHypaV3Preset('A', { memoryTokensRatio: 0.5 }), createHypaV3Preset('B')],
            hypaV3PresetId: 1,
        }
        migrateMemoryPresets(db, ids())
        expect(db.memoryPresets.map(p => [p.id, p.name])).toEqual([['id-1', 'A'], ['id-2', 'B']])
        expect(db.memoryPresets[0].canon.settings.memoryTokensRatio).toBe(0.5)
        expect(db.memoryPresets.every(p => p.blocks.length === 0)).toBe(true)
        expect(db.memoryPresetId).toBe('id-2')
        expect(db.memoryPresetFolders).toEqual([])
    })

    it('defaults to off when HypaV3 was disabled', () => {
        const db: MemoryPresetDb = { hypaV3: false, hypaV3Presets: [createHypaV3Preset('Default')], hypaV3PresetId: 0 }
        migrateMemoryPresets(db, ids())
        expect(db.memoryPresetId).toBe(MEMORY_PRESET_OFF)
        expect(db.hypaV3).toBe(false)
    })

    it('does not migrate twice and repairs broken entries', () => {
        const db: MemoryPresetDb = {
            hypaV3Presets: [createHypaV3Preset('Stale')],
            memoryPresets: [
                { id: 'keep', name: 'Keep', canon: { source: 'hypaV3', budget: 1, settings: {} as any }, blocks: undefined },
                null as any,
                { id: '', name: 5 as any, blocks: [] },
            ],
            memoryPresetId: 'missing',
        }
        migrateMemoryPresets(db, ids())
        expect(db.memoryPresets.map(p => p.id)).toEqual(['keep', 'id-1'])
        expect(db.memoryPresets[0].canon.settings.memoryTokensRatio).toBe(0.2)
        expect(db.memoryPresets[0].blocks).toEqual([])
        expect(db.memoryPresets[1].name).toBe('Preset 2')
        expect(db.memoryPresetId).toBe(MEMORY_PRESET_OFF)
        // mirror derives from memoryPresets, not the stale legacy array
        expect(db.hypaV3Presets.map(p => p.name)).toEqual(['Keep'])
    })

    it('handles a database with no hypaV3 fields at all', () => {
        const db: MemoryPresetDb = {}
        migrateMemoryPresets(db, ids())
        expect(db.memoryPresets).toEqual([])
        expect(db.memoryPresetId).toBe(MEMORY_PRESET_OFF)
        expect(db.hypaV3Presets).toHaveLength(1)
        expect(db.hypaV3).toBe(false)
    })
})

describe('syncMemoryMirror', () => {
    it('mirrors only HypaV3 presets and points the legacy index at the default', () => {
        const db: MemoryPresetDb = {
            memoryPresets: [
                createMemoryPreset('A', 'a'),
                { id: 'blocks-only', name: 'Blocks', blocks: [] },
                createMemoryPreset('B', 'b'),
            ],
            memoryPresetId: 'b',
        }
        syncMemoryMirror(db)
        expect(db.hypaV3Presets.map(p => p.name)).toEqual(['A', 'B'])
        expect(db.hypaV3PresetId).toBe(1)
        expect(db.hypaV3).toBe(true)
        expect(db.memoryAlgorithmType).toBe('hypaMemoryV3')
    })

    it('mirror settings are copies, not shared references', () => {
        const db: MemoryPresetDb = { memoryPresets: [createMemoryPreset('A', 'a')], memoryPresetId: 'a' }
        syncMemoryMirror(db)
        db.memoryPresets[0].canon.settings.memoryTokensRatio = 0.9
        expect(db.hypaV3Presets[0].settings.memoryTokensRatio).toBe(0.2)
    })

    it('turns hypaV3 off when the default preset has no HypaV3 canon', () => {
        const db: MemoryPresetDb = {
            memoryPresets: [createMemoryPreset('A', 'a'), { id: 'x', name: 'X', blocks: [] }],
            memoryPresetId: 'x',
        }
        syncMemoryMirror(db)
        expect(db.hypaV3).toBe(false)
        expect(db.hypaV3PresetId).toBe(0)
        expect(db.memoryAlgorithmType).toBe('none')
    })
})

describe('resolveMemoryPresetId', () => {
    const db: MemoryPresetDb = {
        memoryPresets: [createMemoryPreset('A', 'a'), createMemoryPreset('B', 'b')],
        memoryPresetId: 'a',
    }

    it('legacy chats: supaMemory decides between inherit and off', () => {
        expect(getMemoryBinding(undefined, {})).toBe(MEMORY_PRESET_OFF)
        expect(getMemoryBinding(undefined, { supaMemory: true })).toBe(MEMORY_PRESET_DEFAULT)
        expect(getMemoryBinding({ supaMemory: true }, { supaMemory: false })).toBe(MEMORY_PRESET_OFF)
        expect(getMemoryBinding({ supaMemory: true }, {})).toBe(MEMORY_PRESET_DEFAULT)
        expect(resolveMemoryPresetId(db, undefined, {})).toBe(MEMORY_PRESET_OFF)
        expect(resolveMemoryPresetId(db, undefined, { supaMemory: true })).toBe('a')
    })

    it('chat binding wins over character and legacy flags', () => {
        expect(resolveMemoryPresetId(db, { memoryPresetId: 'a' }, { memoryPresetId: 'b', supaMemory: false })).toBe('b')
        expect(resolveMemoryPresetId(db, { memoryPresetId: 'b' }, { supaMemory: true })).toBe('b')
        expect(resolveMemoryPresetId(db, undefined, { memoryPresetId: MEMORY_PRESET_OFF, supaMemory: true })).toBe(MEMORY_PRESET_OFF)
        expect(resolveMemoryPresetId(db, undefined, { memoryPresetId: MEMORY_PRESET_DEFAULT })).toBe('a')
    })

    it("a chat on 'default' follows the character binding before the global default", () => {
        expect(getMemoryBinding({ memoryPresetId: 'b' }, { memoryPresetId: MEMORY_PRESET_DEFAULT })).toBe('b')
        expect(getMemoryBinding({ memoryPresetId: MEMORY_PRESET_OFF }, { memoryPresetId: MEMORY_PRESET_DEFAULT })).toBe(MEMORY_PRESET_OFF)
        expect(getMemoryBinding({ supaMemory: false }, { memoryPresetId: MEMORY_PRESET_DEFAULT })).toBe(MEMORY_PRESET_DEFAULT)
        expect(resolveMemoryPresetId(db, { memoryPresetId: 'b' }, { memoryPresetId: MEMORY_PRESET_DEFAULT })).toBe('b')
    })

    it('a deleted preset falls back to the global default, or off when that is off too', () => {
        expect(resolveMemoryPresetId(db, undefined, { memoryPresetId: 'gone' })).toBe('a')
        expect(resolveMemoryPresetId({ ...db, memoryPresetId: MEMORY_PRESET_OFF }, undefined, { memoryPresetId: 'gone' })).toBe(MEMORY_PRESET_OFF)
        expect(resolveMemoryPresetId({ ...db, memoryPresetId: MEMORY_PRESET_OFF }, undefined, { memoryPresetId: 'b' })).toBe('b')
    })

    it('getActiveHypaV3Preset exposes the live settings object', () => {
        const preset = getActiveHypaV3Preset(db, undefined, { memoryPresetId: 'b' })
        expect(preset.name).toBe('B')
        expect(preset.settings).toBe(db.memoryPresets[1].canon.settings)
        expect(getActiveHypaV3Preset(db, undefined, {})).toBeNull()
    })

    it('setChatMemoryPreset keeps the supaMemory mirror in step', () => {
        const chat = { supaMemory: true }
        setChatMemoryPreset(db, undefined, chat, MEMORY_PRESET_OFF)
        expect(chat).toEqual({ supaMemory: false, memoryPresetId: MEMORY_PRESET_OFF })
        setChatMemoryPreset(db, undefined, chat, 'b')
        expect(chat.supaMemory).toBe(true)
        setChatMemoryPreset({ ...db, memoryPresetId: MEMORY_PRESET_OFF }, undefined, chat, MEMORY_PRESET_DEFAULT)
        expect(chat.supaMemory).toBe(false)
    })
})

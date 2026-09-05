// Long-term memory presets — the composition container that decides which
// memory source runs for a chat and with what settings.
//
// Shape (kept from day one so later stages add blocks without a re-migration):
//   { id, name, folderId?, canon?: { source: 'hypaV3', budget, settings }, blocks: [] }
// `canon` is the single source allowed to trim old messages (HypaV3 today);
// `blocks` are text-only sources and stay empty in this stage.
//
// `db.memoryPresets` is the truth. The legacy fields `hypaV3Presets`,
// `hypaV3PresetId`, `hypaV3` and `chat.supaMemory` are kept only as a mirror so
// a `.bin` exported from PocketRisu still drives HypaV3 in upstream RisuAI.
// Nothing in the app reads the mirror; `syncMemoryMirror` rewrites it after
// every preset mutation and on load.
import { createHypaV3Preset, type HypaV3Preset, type HypaV3Settings } from './hypav3Preset'

export const MEMORY_PRESET_OFF = 'off'
/** Chat/character-level value meaning "follow the global default preset". */
export const MEMORY_PRESET_DEFAULT = 'default'

export interface MemoryPresetCanon {
    source: 'hypaV3'
    /** Share of the memory budget, 0..1. Always 1 while there are no blocks. */
    budget: number
    settings: HypaV3Settings
}

export interface MemoryPresetBlock {
    source: string
    budget: number
    settings: Record<string, unknown>
    placement: 'before' | 'after'
}

export interface MemoryPreset {
    id: string
    name: string
    folderId?: string
    canon?: MemoryPresetCanon
    blocks: MemoryPresetBlock[]
}

/** The subset of the database these helpers touch. */
export interface MemoryPresetDb {
    memoryPresets?: MemoryPreset[]
    memoryPresetId?: string
    memoryPresetFolders?: { id: string, name: string }[]
    hypaV3?: boolean
    hypaV3Presets?: HypaV3Preset[]
    hypaV3PresetId?: number
    memoryAlgorithmType?: string
}

/** Fields read from a chat / character when resolving the bound preset. */
export interface MemoryPresetHolder {
    memoryPresetId?: string
    supaMemory?: boolean
}

function clone<T>(value: T): T {
    return JSON.parse(JSON.stringify(value))
}

export function createMemoryPreset(name: string, id: string, settings: Partial<HypaV3Settings> = {}): MemoryPreset {
    return {
        id,
        name,
        canon: { source: 'hypaV3', budget: 1, settings: createHypaV3Preset(name, settings).settings },
        blocks: [],
    }
}

/**
 * One-time migration from `hypaV3Presets` plus per-field sanitizing. Safe to
 * run on every load: it only creates `memoryPresets` when the array is missing
 * (fresh install, pre-preset save, or a save from upstream RisuAI) and repairs
 * broken entries otherwise. Ends by rewriting the legacy mirror.
 */
export function migrateMemoryPresets(data: MemoryPresetDb, uuid: () => string): void {
    if (!Array.isArray(data.memoryPresets)) {
        const hypaPresets = Array.isArray(data.hypaV3Presets) ? data.hypaV3Presets : []
        data.memoryPresets = hypaPresets.map((preset, i) => ({
            id: uuid(),
            name: typeof preset?.name === 'string' ? preset.name : `Preset ${i + 1}`,
            canon: { source: 'hypaV3', budget: 1, settings: createHypaV3Preset(preset?.name, preset?.settings ?? {}).settings },
            blocks: [],
        }))
        const active = data.hypaV3
            ? data.memoryPresets[data.hypaV3PresetId ?? 0] ?? data.memoryPresets[0]
            : undefined
        data.memoryPresetId = active?.id ?? MEMORY_PRESET_OFF
    }

    data.memoryPresets = data.memoryPresets
        .filter(preset => preset && typeof preset === 'object')
        .map((preset, i) => {
            const canon = preset.canon && typeof preset.canon === 'object' && preset.canon.source === 'hypaV3'
                ? { source: 'hypaV3' as const, budget: 1, settings: createHypaV3Preset(preset.name, preset.canon.settings ?? {}).settings }
                : undefined
            return {
                ...preset,
                id: typeof preset.id === 'string' && preset.id ? preset.id : uuid(),
                name: typeof preset.name === 'string' ? preset.name : `Preset ${i + 1}`,
                canon,
                blocks: Array.isArray(preset.blocks) ? preset.blocks : [],
            }
        })

    if (typeof data.memoryPresetId !== 'string') data.memoryPresetId = MEMORY_PRESET_OFF
    if (data.memoryPresetId !== MEMORY_PRESET_OFF && !getMemoryPreset(data, data.memoryPresetId)) {
        data.memoryPresetId = MEMORY_PRESET_OFF
    }
    if (!Array.isArray(data.memoryPresetFolders)) data.memoryPresetFolders = []

    syncMemoryMirror(data)
}

export function getMemoryPreset(db: MemoryPresetDb, id: string | undefined): MemoryPreset | null {
    if (!id || id === MEMORY_PRESET_OFF) return null
    return db.memoryPresets?.find(preset => preset.id === id) ?? null
}

/**
 * The raw binding of a chat before falling back to the global default:
 * the chat's own value ('default' defers to the character), then the
 * character's, then the legacy `supaMemory` flags. New chats are created with
 * 'default'; legacy chats without any value that never enabled HypaMemory
 * stay off — turning memory on for every existing chat would start
 * summarization requests the user never asked for.
 */
export function getMemoryBinding(char: MemoryPresetHolder | undefined, chat: MemoryPresetHolder | undefined): string {
    const chatValue = chat?.memoryPresetId
    if (chatValue !== undefined && chatValue !== MEMORY_PRESET_DEFAULT) return chatValue
    const charValue = char?.memoryPresetId
    if (charValue !== undefined) return charValue
    if (chatValue === MEMORY_PRESET_DEFAULT) return MEMORY_PRESET_DEFAULT
    return (chat?.supaMemory ?? char?.supaMemory) ? MEMORY_PRESET_DEFAULT : MEMORY_PRESET_OFF
}

/**
 * Resolves the preset a chat actually runs with: a preset id or 'off'.
 * A binding to a deleted preset falls back to the global default.
 */
export function resolveMemoryPresetId(
    db: MemoryPresetDb,
    char: MemoryPresetHolder | undefined,
    chat: MemoryPresetHolder | undefined,
): string {
    let id = getMemoryBinding(char, chat)
    if (id === MEMORY_PRESET_DEFAULT) id = db.memoryPresetId ?? MEMORY_PRESET_OFF
    if (id === MEMORY_PRESET_OFF) return MEMORY_PRESET_OFF
    if (getMemoryPreset(db, id)) return id
    const fallback = db.memoryPresetId
    return fallback && getMemoryPreset(db, fallback) ? fallback : MEMORY_PRESET_OFF
}

export function getResolvedMemoryPreset(
    db: MemoryPresetDb,
    char: MemoryPresetHolder | undefined,
    chat: MemoryPresetHolder | undefined,
): MemoryPreset | null {
    return getMemoryPreset(db, resolveMemoryPresetId(db, char, chat))
}

/** HypaV3 view of the preset a chat resolves to, or null when it has no HypaV3 canon. */
export function getActiveHypaV3Preset(
    db: MemoryPresetDb,
    char: MemoryPresetHolder | undefined,
    chat: MemoryPresetHolder | undefined,
): HypaV3Preset | null {
    const preset = getResolvedMemoryPreset(db, char, chat)
    if (!preset?.canon || preset.canon.source !== 'hypaV3') return null
    return { name: preset.name, settings: preset.canon.settings }
}

/**
 * Binds a chat to a preset id, 'off', or 'default' (inherit) and keeps the
 * legacy `supaMemory` mirror in step so upstream reads the same on/off state.
 */
export function setChatMemoryPreset(
    db: MemoryPresetDb,
    char: MemoryPresetHolder | undefined,
    chat: MemoryPresetHolder,
    value: string,
): void {
    chat.memoryPresetId = value
    chat.supaMemory = resolveMemoryPresetId(db, char, chat) !== MEMORY_PRESET_OFF
}

/**
 * Rewrites the legacy HypaV3 fields from `memoryPresets`. The mirror is the
 * only thing upstream RisuAI understands, so it must always be a valid state:
 * at least one preset, an in-range index, `hypaV3` true only when the default
 * preset is a HypaV3 one.
 */
export function syncMemoryMirror(db: MemoryPresetDb): void {
    const presets = db.memoryPresets ?? []
    const hypaPresets = presets.filter(preset => preset.canon?.source === 'hypaV3')
    db.hypaV3Presets = hypaPresets.length > 0
        ? hypaPresets.map(preset => ({ name: preset.name, settings: clone(preset.canon.settings) }))
        : [createHypaV3Preset('Default')]

    const active = getMemoryPreset(db, db.memoryPresetId)
    const activeIndex = active ? hypaPresets.indexOf(active) : -1
    db.hypaV3 = activeIndex !== -1
    db.hypaV3PresetId = Math.max(0, activeIndex)
    db.memoryAlgorithmType = db.hypaV3 ? 'hypaMemoryV3' : 'none'
}

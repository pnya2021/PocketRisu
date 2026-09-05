export const DEFAULT_PRESET_CONTEXT_BUDGET = 65000

export type ContextBudgetPreset = {
    name?: string
    maxContext?: number
    ignoreContextWindowCap?: boolean
}

export type ContextBudget = {
    maxContextTokens: number
    /** Human-readable origin, appended to token-limit errors. */
    source: string
}

/**
 * Input token budget of a chat bound to a ModelPreset.
 *
 * - No explicit maxContext: the default budget, capped at the profile's
 *   context window when known.
 * - Explicit maxContext: capped the same way, unless the user turned on
 *   "ignore context window cap" (a wrong cap in a custom registry must not
 *   silently override a value the user typed).
 */
export function resolveModelPresetContextBudget(preset: ContextBudgetPreset, contextWindowTokens: number | undefined): ContextBudget {
    const set = preset.maxContext
    const explicit = typeof set === 'number' && set > 0
    const budget = explicit ? set : DEFAULT_PRESET_CONTEXT_BUDGET
    const ctxWindow = typeof contextWindowTokens === 'number' && contextWindowTokens > 0 ? contextWindowTokens : undefined
    const capIgnored = explicit && !!preset.ignoreContextWindowCap
    const capApplies = ctxWindow !== undefined && !capIgnored
    const name = preset.name ?? ''
    if (capApplies && ctxWindow < budget) {
        return {
            maxContextTokens: ctxWindow,
            source: `model context window cap ${ctxWindow} from the model profile "${name}" (preset budget ${budget})`,
        }
    }
    const ignoredNote = capIgnored && ctxWindow !== undefined && ctxWindow < budget ? ` (context window cap ${ctxWindow} ignored)` : ''
    return {
        maxContextTokens: budget,
        source: `model preset "${name}" max context ${explicit ? set : `(unset, default ${DEFAULT_PRESET_CONTEXT_BUDGET})`}${ignoredNote}`,
    }
}

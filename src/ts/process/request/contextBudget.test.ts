import { describe, test, expect } from 'vitest'
import { resolveModelPresetContextBudget } from './contextBudget'

describe('resolveModelPresetContextBudget', () => {
    test('empty value: default budget, capped by the profile context window', () => {
        expect(resolveModelPresetContextBudget({ name: 'p' }, undefined).maxContextTokens).toBe(65000)
        expect(resolveModelPresetContextBudget({ name: 'p' }, 200000).maxContextTokens).toBe(65000)
        expect(resolveModelPresetContextBudget({ name: 'p' }, 49152).maxContextTokens).toBe(49152)
        // The switch has no effect without an explicit value.
        expect(resolveModelPresetContextBudget({ name: 'p', ignoreContextWindowCap: true }, 49152).maxContextTokens).toBe(49152)
    })

    test('explicit value is capped unless the cap is ignored', () => {
        const capped = resolveModelPresetContextBudget({ name: 'p', maxContext: 200000 }, 49152)
        expect(capped.maxContextTokens).toBe(49152)
        expect(capped.source).toContain('cap 49152')
        expect(capped.source).toContain('preset budget 200000')

        const ignored = resolveModelPresetContextBudget({ name: 'p', maxContext: 200000, ignoreContextWindowCap: true }, 49152)
        expect(ignored.maxContextTokens).toBe(200000)
        expect(ignored.source).toContain('cap 49152 ignored')

        // A value under the cap is used as-is either way.
        expect(resolveModelPresetContextBudget({ name: 'p', maxContext: 30000 }, 49152).maxContextTokens).toBe(30000)
        expect(resolveModelPresetContextBudget({ name: 'p', maxContext: 30000, ignoreContextWindowCap: true }, 49152).source).not.toContain('ignored')
    })

    test('non-positive or missing window means no cap', () => {
        expect(resolveModelPresetContextBudget({ name: 'p', maxContext: 120000 }, 0).maxContextTokens).toBe(120000)
        expect(resolveModelPresetContextBudget({ name: 'p', maxContext: 0 }, undefined).maxContextTokens).toBe(65000)
    })
})

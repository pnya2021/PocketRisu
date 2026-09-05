import { describe, expect, it } from 'vitest'
import { createPluginDatabaseBoundary } from './pluginDatabaseBoundary'

describe('public plugin database boundary', () => {
    it('routes lazy plugin values through the store without putting them back into the database', () => {
        const values: Record<string, unknown> = { cold: 'server value' }
        const raw = { plugins: [{ name: 'demo', script: 'code', principalId: 'secret' }], pluginCustomStorage: {} }
        const boundary: any = createPluginDatabaseBoundary(raw, ['plugins', 'pluginCustomStorage'], {
            storage: values,
            restoreKey: (_key: string, value: unknown) => value,
        })
        expect(boundary.cold).toBe('server value')
        expect(boundary.pluginCustomStorage.cold).toBe('server value')
        boundary.fresh = 42
        boundary.pluginCustomStorage = { bulk: true }
        Object.defineProperty(boundary, 'defined', { value: 'saved' })
        expect(values).toEqual({ cold: 'server value', fresh: 42, bulk: true, defined: 'saved' })
        expect(Object.keys(boundary)).toContain('cold')
        expect(Object.getOwnPropertyDescriptor(boundary, 'fresh')?.value).toBe(42)
        expect(raw.pluginCustomStorage).toEqual({})
        expect(boundary.plugins[0].principalId).toBeUndefined()
        expect(() => { boundary.plugins = [] }).toThrow(/blocked/)
    })
    it('never exposes or accepts host principal fields through reflection', () => {
        const raw = { plugins: [{ name: 'demo', script: 'code', principalId: 'secret-principal' }], pluginCustomStorage: {} }
        const boundary = createPluginDatabaseBoundary(raw, ['plugins', 'pluginCustomStorage'])
        expect(boundary.plugins?.[0].principalId).toBeUndefined()
        expect(({ ...boundary }).plugins?.[0].principalId).toBeUndefined()
        expect(Object.getOwnPropertyDescriptor(boundary, 'plugins')?.value[0].principalId).toBeUndefined()
        expect(Object.getOwnPropertyDescriptors(boundary).plugins.value[0].principalId).toBeUndefined()
        expect(() => Object.defineProperty(boundary, 'plugins', { value: [] })).toThrow(/blocked/)
        expect(() => { boundary.plugins = [] }).toThrow(/blocked/)
        expect(raw.plugins[0].principalId).toBe('secret-principal')
    })
})

import { stripPluginPrincipal, type PrincipalPluginRecord } from './pluginPrincipal'

type BoundaryDatabase = {
    plugins?: PrincipalPluginRecord[]
    pluginCustomStorage?: Record<string, unknown>
}

export function createPluginDatabaseBoundary<T extends BoundaryDatabase>(target: T, allowedKeys: readonly string[], options?: {
    storage: Record<string, unknown>
    restoreKey: (key: string, value: unknown) => unknown
}): T {
    const publicPlugins = () => (target.plugins ?? []).map((plugin) => stripPluginPrincipal(plugin))
    const storage = () => options?.storage ?? (target.pluginCustomStorage ??= {})
    const assign = (database: T, prop: string, value: unknown) => {
        if (options && prop === 'pluginCustomStorage') {
            if (value && typeof value === 'object') Object.assign(storage(), value)
        } else if (allowedKeys.includes(prop)) {
            ;(database as any)[prop] = options ? options.restoreKey(prop, value) : value
        } else storage()[prop] = value
    }
    return new Proxy(target, {
        get(database, prop) {
            if (prop === 'plugins') return publicPlugins()
            if (options && prop === 'pluginCustomStorage') return storage()
            if (typeof prop === 'string' && allowedKeys.includes(prop)) return (database as any)[prop]
            return storage()[String(prop)]
        },
        set(database, prop, value) {
            if (prop === 'plugins') throw new Error('Direct plugin-array assignment is blocked; use setDatabase() so Host lifecycle checks can run.')
            assign(database, String(prop), value)
            return true
        },
        ownKeys(database) {
            const allowed = Reflect.ownKeys(database).filter((key) => typeof key === 'string' && allowedKeys.includes(key))
            const custom = Object.keys(storage()).filter((key) => !allowed.includes(key))
            return [...allowed, ...custom]
        },
        getOwnPropertyDescriptor(database, prop) {
            if (prop === 'plugins') {
                const source = Reflect.getOwnPropertyDescriptor(database, prop)
                return { configurable: true, enumerable: source?.enumerable ?? true, writable: false, value: publicPlugins() }
            }
            if (options && prop === 'pluginCustomStorage') return { configurable: true, enumerable: true, writable: true, value: storage() }
            if (typeof prop === 'string' && allowedKeys.includes(prop)) return Reflect.getOwnPropertyDescriptor(database, prop)
            if (typeof prop === 'string' && Object.hasOwn(storage(), prop)) {
                return { configurable: true, enumerable: true, writable: true, value: storage()[prop] }
            }
        },
        defineProperty(database, prop, descriptor) {
            if (prop === 'plugins') throw new Error('Direct plugin-array definition is blocked; use setDatabase().')
            if (options && Object.hasOwn(descriptor, 'value')) { assign(database, String(prop), descriptor.value); return true }
            if (typeof prop === 'string' && allowedKeys.includes(prop)) return Reflect.defineProperty(database, prop, descriptor)
            if (!Object.hasOwn(descriptor, 'value')) return false
            storage()[String(prop)] = descriptor.value
            return true
        },
        deleteProperty() { return false },
        getPrototypeOf(database) { return Reflect.getPrototypeOf(database) },
    })
}

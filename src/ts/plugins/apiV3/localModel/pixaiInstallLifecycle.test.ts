import { describe, expect, it, vi } from 'vitest'
import { SecurityConfirmationQueue } from '../../securityConfirmationQueue'
import { PluginApiError } from '../illustration/errors'
import type { PluginExecutionContext } from '../illustration/permissions'
import {
    PIXAI_PROFILE,
    type PocketModelProgress,
    type PocketModelStatus,
} from './pocketPluginModelClient'
import {
    PixaiInstallLifecycle,
    TERMINAL_OPERATION_TTL_MS,
    type LocalModelProgress,
    type PixaiInstallLifecycleClient,
    type PixaiInstallLifecycleOptions,
} from './pixaiInstallLifecycle'

const OWNER_A = '11111111-1111-4111-8111-111111111111'
const OWNER_B = '22222222-2222-4222-8222-222222222222'

function context(principalId = OWNER_A, instanceId = `${principalId}-instance`) {
    const abort = new AbortController()
    return {
        abort,
        context: {
            principalId,
            instanceId,
            displayName: `Plugin ${principalId}`,
            internalName: `plugin-${principalId}`,
            signal: abort.signal,
        } satisfies PluginExecutionContext,
    }
}

function hostStatus(
    state: 'absent' | 'partial' | 'verified' = 'absent',
    active?: PocketModelProgress,
): PocketModelStatus {
    const stored = state === 'absent'
        ? [0, 0, 0]
        : state === 'verified'
            ? PIXAI_PROFILE.artifacts.map((artifact) => artifact.bytes)
            : [321, 0, 0]
    return {
        profileId: PIXAI_PROFILE.id,
        revision: PIXAI_PROFILE.revision,
        state,
        storedBytes: stored.reduce((sum, value) => sum + value, 0),
        totalBytes: PIXAI_PROFILE.totalBytes,
        artifacts: PIXAI_PROFILE.artifacts.map((artifact, index) => ({
            name: artifact.name,
            sha256: artifact.sha256,
            state: state === 'verified' ? 'verified' : stored[index] ? 'partial' : 'absent',
            storedBytes: stored[index],
            expectedBytes: artifact.bytes,
        })),
        storage: { kind: 'node', persistent: true, resumable: true },
        ...(active ? { active } : {}),
    }
}

class HostBackend {
    current = hostStatus()
    readonly status = vi.fn(async () => this.current)
    readonly cancel = vi.fn(async (_principal: string) => ({ cancelled: true }))
    readonly remove = vi.fn(async (
        _principal: string,
        _includePartial: boolean,
    ): Promise<{ purgedBytes: number; pending?: true }> => {
        const purgedBytes = this.current.storedBytes
        this.current = hostStatus()
        return { purgedBytes }
    })
    downloadImpl: (
        principalId: string,
        signal: AbortSignal,
        onProgress?: (progress: PocketModelProgress) => unknown,
    ) => Promise<{ state: 'verified'; bytes: number }> = async (_principalId, _signal, onProgress) => {
        for (const artifact of PIXAI_PROFILE.artifacts) {
            onProgress?.({
                profileId: PIXAI_PROFILE.id,
                artifact: artifact.name,
                phase: 'downloading',
                artifactLoadedBytes: artifact.bytes,
                artifactTotalBytes: artifact.bytes,
                loadedBytes: PIXAI_PROFILE.artifacts
                    .slice(0, PIXAI_PROFILE.artifacts.indexOf(artifact) + 1)
                    .reduce((sum, value) => sum + value.bytes, 0),
                totalBytes: PIXAI_PROFILE.totalBytes,
            })
        }
        this.current = hostStatus('verified')
        return { state: 'verified', bytes: PIXAI_PROFILE.totalBytes }
    }
    readonly download = vi.fn((
        principalId: string,
        signal: AbortSignal,
        onProgress?: (progress: PocketModelProgress) => unknown,
    ) => this.downloadImpl(principalId, signal, onProgress))

    client(principalId: string): PixaiInstallLifecycleClient {
        return {
            status: () => this.status(),
            download: (signal, onProgress) => this.download(principalId, signal, onProgress),
            cancel: () => this.cancel(principalId),
            remove: (includePartial) => this.remove(principalId, includePartial),
        }
    }
}

function setup(overrides: Partial<PixaiInstallLifecycleOptions> = {}) {
    const backend = new HostBackend()
    const queue = new SecurityConfirmationQueue()
    const lifecycle = new PixaiInstallLifecycle({
        clientForPrincipal: (principalId) => backend.client(principalId),
        queue,
        requirePermission: async () => undefined,
        ...overrides,
    })
    return { backend, queue, lifecycle }
}

function decide(queue: SecurityConfirmationQueue, answer: boolean) {
    const current = queue.current()
    if (!current || !queue.decide(current.digest, current.presentationId, answer)) {
        throw new Error('confirmation was not presented')
    }
}

async function approvedInstall(
    lifecycle: PixaiInstallLifecycle,
    queue: SecurityConfirmationQueue,
    owner: PluginExecutionContext,
    callback?: (progress: LocalModelProgress) => unknown,
) {
    const pending = lifecycle.installLocalModel(owner, PIXAI_PROFILE.id, callback)
    await queue.whenPresented()
    decide(queue, true)
    return pending
}

async function settle(
    lifecycle: PixaiInstallLifecycle,
    owner: PluginExecutionContext,
    operationId: string,
) {
    for (let attempt = 0; attempt < 100; attempt += 1) {
        const snapshot = await lifecycle.getLocalModelOperation(owner, operationId)
        if (['succeeded', 'failed', 'cancelled'].includes(snapshot.state)) return snapshot
        await new Promise<void>((resolve) => queueMicrotask(resolve))
    }
    throw new Error('operation did not settle')
}

describe('PixAI install lifecycle', () => {
    it('maps prompt-free Host status and does not invent a reload operation ID', async () => {
        const { backend, lifecycle, queue } = setup()
        const owner = context().context
        await expect(lifecycle.getLocalModelStatus(owner, PIXAI_PROFILE.id)).resolves.toEqual({ state: 'absent' })

        backend.current = hostStatus('partial')
        await expect(lifecycle.getLocalModelStatus(owner, PIXAI_PROFILE.id)).resolves.toMatchObject({
            state: 'partial', storedBytes: 321, revision: PIXAI_PROFILE.revision,
        })
        backend.current = hostStatus('verified')
        await expect(lifecycle.getLocalModelStatus(owner, PIXAI_PROFILE.id)).resolves.toMatchObject({
            state: 'ready', storedBytes: PIXAI_PROFILE.totalBytes,
        })

        backend.current = hostStatus('partial', {
            profileId: PIXAI_PROFILE.id,
            artifact: PIXAI_PROFILE.artifacts[0].name,
            phase: 'verifying',
            artifactLoadedBytes: 10,
            artifactTotalBytes: PIXAI_PROFILE.artifacts[0].bytes,
            loadedBytes: 10,
            totalBytes: PIXAI_PROFILE.totalBytes,
        })
        await expect(lifecycle.getLocalModelStatus(owner, PIXAI_PROFILE.id)).resolves.toEqual({
            state: 'verifying', revision: PIXAI_PROFILE.revision,
            sha256: PIXAI_PROFILE.artifacts[0].sha256, storedBytes: 10,
        })
        expect(queue.current()).toBeNull()
    })

    it('requires permission before confirmation and denial starts no Host operation', async () => {
        const permission = vi.fn(async () => undefined)
        const { backend, lifecycle, queue } = setup({ requirePermission: permission })
        const owner = context().context
        const pending = lifecycle.installLocalModel(owner, PIXAI_PROFILE.id)
        await queue.whenPresented()
        expect(permission).toHaveBeenCalledWith(owner)
        decide(queue, false)
        await expect(pending).rejects.toMatchObject({ code: 'PERMISSION_DENIED' })
        expect(backend.download).not.toHaveBeenCalled()

        const deniedPermission = setup({
            requirePermission: async () => { throw new PluginApiError('PERMISSION_DENIED', 'no') },
        })
        await expect(deniedPermission.lifecycle.installLocalModel(owner, PIXAI_PROFILE.id))
            .rejects.toMatchObject({ code: 'PERMISSION_DENIED' })
        expect(deniedPermission.queue.current()).toBeNull()
    })

    it('coalesces one principal, keeps foreign operation IDs opaque, and publishes bounded progress', async () => {
        const { backend, lifecycle, queue } = setup()
        let release!: () => void
        backend.downloadImpl = async (_principal, signal, onProgress) => new Promise((resolve, reject) => {
            signal.addEventListener('abort', () => reject(new PluginApiError('ABORTED', 'stopped')), { once: true })
            onProgress?.({
                profileId: PIXAI_PROFILE.id,
                artifact: PIXAI_PROFILE.artifacts[0].name,
                phase: 'downloading',
                artifactLoadedBytes: 200,
                artifactTotalBytes: PIXAI_PROFILE.artifacts[0].bytes,
                loadedBytes: 200,
                totalBytes: PIXAI_PROFILE.totalBytes,
            })
            release = () => resolve({ state: 'verified', bytes: PIXAI_PROFILE.totalBytes })
        })
        const first = context(OWNER_A, 'a-1').context
        const second = context(OWNER_A, 'a-2').context
        const foreign = context(OWNER_B).context
        const progress = vi.fn()
        const started = await approvedInstall(lifecycle, queue, first, progress)
        const joined = await lifecycle.installLocalModel(second, PIXAI_PROFILE.id)
        expect(joined.operationId).toBe(started.operationId)
        await expect(lifecycle.getLocalModelStatus(first, PIXAI_PROFILE.id)).resolves.toMatchObject({
            state: 'downloading', operationId: started.operationId, storedBytes: 200,
        })
        await expect(lifecycle.getLocalModelOperation(foreign, started.operationId))
            .rejects.toMatchObject({ code: 'NOT_FOUND' })
        expect(progress).toHaveBeenCalled()
        release()
        await expect(settle(lifecycle, first, started.operationId)).resolves.toMatchObject({ state: 'succeeded' })
        expect(backend.download).toHaveBeenCalledTimes(1)
    })

    it('keeps approved work alive after iframe unload but explicit cancel calls the Host lease', async () => {
        const { backend, lifecycle, queue } = setup()
        let release!: () => void
        backend.downloadImpl = async (_principal, signal) => new Promise((resolve, reject) => {
            signal.addEventListener('abort', () => reject(new PluginApiError('ABORTED', 'cancelled')), { once: true })
            release = () => resolve({ state: 'verified', bytes: PIXAI_PROFILE.totalBytes })
        })
        const instance = context()
        const started = await approvedInstall(lifecycle, queue, instance.context)
        instance.abort.abort()
        expect(backend.cancel).not.toHaveBeenCalled()
        release()
        await expect(settle(lifecycle, instance.context, started.operationId)).resolves.toMatchObject({ state: 'succeeded' })

        const next = context(OWNER_A, 'next-instance').context
        const cancelled = await approvedInstall(lifecycle, queue, next)
        await lifecycle.cancelLocalModelOperation(next, cancelled.operationId)
        expect(backend.cancel).toHaveBeenCalledWith(OWNER_A)
        await expect(lifecycle.getLocalModelOperation(next, cancelled.operationId)).resolves.toMatchObject({
            state: 'cancelled', error: { code: 'ABORTED' },
        })
    })

    it('reserves and aborts cancellation before Host DELETE settles', async () => {
        const { backend, lifecycle, queue } = setup()
        let downloadSignal!: AbortSignal
        let resolveDownload!: () => void
        let resolveCancel!: () => void
        backend.downloadImpl = async (_principal, signal) => {
            downloadSignal = signal
            return new Promise((resolve) => {
                resolveDownload = () => resolve({
                    state: 'verified', bytes: PIXAI_PROFILE.totalBytes,
                })
            })
        }
        backend.cancel.mockImplementationOnce(() => new Promise((resolve) => {
            resolveCancel = () => resolve({ cancelled: true })
        }))
        const owner = context().context
        const started = await approvedInstall(lifecycle, queue, owner)
        await vi.waitFor(() => expect(backend.download).toHaveBeenCalledTimes(1))

        const cancellation = lifecycle.cancelLocalModelOperation(owner, started.operationId)
        expect(downloadSignal.aborted).toBe(true)
        resolveDownload()
        await expect(settle(lifecycle, owner, started.operationId)).resolves.toMatchObject({
            state: 'cancelled', error: { code: 'ABORTED' },
        })
        await expect(lifecycle.installLocalModel(owner, PIXAI_PROFILE.id))
            .rejects.toMatchObject({ code: 'CONFLICT' })
        expect(queue.current()).toBeNull()

        resolveCancel()
        await expect(cancellation).resolves.toBeUndefined()
        await expect(lifecycle.getLocalModelStatus(owner, PIXAI_PROFILE.id))
            .resolves.toEqual({ state: 'absent' })

        const retry = lifecycle.installLocalModel(owner, PIXAI_PROFILE.id)
        await queue.whenPresented()
        decide(queue, false)
        await expect(retry).rejects.toMatchObject({ code: 'PERMISSION_DENIED' })
    })

    it('keeps local cancellation terminal and redacts a failed Host DELETE', async () => {
        const { backend, lifecycle, queue } = setup()
        backend.downloadImpl = async (_principal, signal) => new Promise((_resolve, reject) => {
            signal.addEventListener('abort', () => reject(new PluginApiError('ABORTED', 'stopped')), { once: true })
        })
        backend.cancel.mockRejectedValueOnce(new Error('private Host cancel stack'))
        const owner = context().context
        const started = await approvedInstall(lifecycle, queue, owner)
        await vi.waitFor(() => expect(backend.download).toHaveBeenCalledTimes(1))

        await expect(lifecycle.cancelLocalModelOperation(owner, started.operationId))
            .rejects.toSatisfy((error: unknown) => {
                expect(error).toMatchObject({ code: 'INTERNAL' })
                expect(String((error as Error).message)).not.toContain('private')
                return true
            })
        await expect(lifecycle.getLocalModelOperation(owner, started.operationId)).resolves.toMatchObject({
            state: 'cancelled', error: { code: 'ABORTED' },
        })
        await expect(lifecycle.getLocalModelStatus(owner, PIXAI_PROFILE.id))
            .resolves.toEqual({ state: 'absent' })
    })

    it('retains shared ownership, forwards includePartial on the last plugin owner, and reports evicted state', async () => {
        const { backend, lifecycle, queue } = setup()
        const a = context(OWNER_A).context
        const b = context(OWNER_B).context
        const aInstall = await approvedInstall(lifecycle, queue, a)
        await settle(lifecycle, a, aInstall.operationId)
        const bInstall = await approvedInstall(lifecycle, queue, b)
        await settle(lifecycle, b, bInstall.operationId)

        backend.current = hostStatus()
        await expect(lifecycle.getLocalModelStatus(b, PIXAI_PROFILE.id)).resolves.toMatchObject({ state: 'evicted' })
        backend.current = hostStatus('verified')

        await expect(lifecycle.removeLocalModel(a, PIXAI_PROFILE.id)).resolves.toEqual({
            releasedPluginReference: true, purgedBytes: 0,
            retainedForOtherOwners: true, pending: false,
        })
        expect(backend.remove).not.toHaveBeenCalled()
        await expect(lifecycle.removeLocalModel(b, PIXAI_PROFILE.id, {
            scope: 'plugin', includePartial: false,
        })).resolves.toMatchObject({
            releasedPluginReference: true,
            retainedForOtherOwners: false,
            purgedBytes: PIXAI_PROFILE.totalBytes,
        })
        expect(backend.remove).toHaveBeenCalledWith(OWNER_B, false)
        await expect(lifecycle.getLocalModelStatus(b, PIXAI_PROFILE.id)).resolves.toMatchObject({ state: 'absent' })
    })

    it('preserves final and device ownership when Host removal fails', async () => {
        const pluginCase = setup()
        const pluginOwner = context(OWNER_A, 'plugin-retry').context
        const installed = await approvedInstall(pluginCase.lifecycle, pluginCase.queue, pluginOwner)
        await settle(pluginCase.lifecycle, pluginOwner, installed.operationId)
        pluginCase.backend.remove.mockRejectedValueOnce(
            new PluginApiError('NETWORK', 'Local model transport failed', { retryable: true }),
        )
        await expect(pluginCase.lifecycle.removeLocalModel(pluginOwner, PIXAI_PROFILE.id))
            .rejects.toMatchObject({ code: 'NETWORK', retryable: true })
        await expect(pluginCase.lifecycle.removeLocalModel(pluginOwner, PIXAI_PROFILE.id))
            .resolves.toMatchObject({ releasedPluginReference: true })

        const deviceCase = setup()
        const a = context(OWNER_A, 'device-a').context
        const b = context(OWNER_B, 'device-b').context
        const aInstall = await approvedInstall(deviceCase.lifecycle, deviceCase.queue, a)
        await settle(deviceCase.lifecycle, a, aInstall.operationId)
        const bInstall = await approvedInstall(deviceCase.lifecycle, deviceCase.queue, b)
        await settle(deviceCase.lifecycle, b, bInstall.operationId)
        deviceCase.backend.remove.mockRejectedValueOnce(
            new PluginApiError('NETWORK', 'Local model transport failed', { retryable: true }),
        )
        const failedPurge = deviceCase.lifecycle.removeLocalModel(a, PIXAI_PROFILE.id, { scope: 'device' })
        await deviceCase.queue.whenPresented()
        decide(deviceCase.queue, true)
        await expect(failedPurge).rejects.toMatchObject({ code: 'NETWORK' })

        const retryPurge = deviceCase.lifecycle.removeLocalModel(a, PIXAI_PROFILE.id, { scope: 'device' })
        await deviceCase.queue.whenPresented()
        decide(deviceCase.queue, true)
        await expect(retryPurge).resolves.toMatchObject({ releasedPluginReference: true })
    })

    it('propagates a deferred Host removal as pending without inventing purged bytes', async () => {
        const { backend, lifecycle } = setup()
        backend.current = hostStatus('verified')
        backend.remove.mockResolvedValueOnce({ purgedBytes: 0, pending: true })

        await expect(lifecycle.removeLocalModel(context().context, PIXAI_PROFILE.id)).resolves.toEqual({
            releasedPluginReference: false,
            purgedBytes: 0,
            retainedForOtherOwners: false,
            pending: true,
        })
    })

    it('confirms device purge, preserves bytes on denial, and blocks purge during active work', async () => {
        const { backend, lifecycle, queue } = setup()
        backend.current = hostStatus('verified')
        const owner = context().context
        const denied = lifecycle.removeLocalModel(owner, PIXAI_PROFILE.id, { scope: 'device' })
        await queue.whenPresented()
        expect(queue.current()?.request.kind).toBe('model-remove')
        decide(queue, false)
        await expect(denied).rejects.toMatchObject({ code: 'PERMISSION_DENIED' })
        expect(backend.remove).not.toHaveBeenCalled()

        const approved = lifecycle.removeLocalModel(owner, PIXAI_PROFILE.id, {
            scope: 'device', includePartial: false,
        })
        await queue.whenPresented()
        decide(queue, true)
        await expect(approved).resolves.toMatchObject({ purgedBytes: PIXAI_PROFILE.totalBytes })
        expect(backend.remove).toHaveBeenCalledWith(OWNER_A, false)

        let release!: () => void
        backend.downloadImpl = async () => new Promise((resolve) => {
            release = () => resolve({ state: 'verified', bytes: PIXAI_PROFILE.totalBytes })
        })
        const active = await approvedInstall(lifecycle, queue, owner)
        await expect(lifecycle.removeLocalModel(owner, PIXAI_PROFILE.id, { scope: 'device' }))
            .rejects.toMatchObject({ code: 'CONFLICT' })
        release()
        await settle(lifecycle, owner, active.operationId)
    })

    it('serializes post-consent install and removal decisions', async () => {
        const { backend, lifecycle, queue } = setup()
        let release!: () => void
        backend.downloadImpl = async () => new Promise((resolve) => {
            release = () => resolve({ state: 'verified', bytes: PIXAI_PROFILE.totalBytes })
        })
        const owner = context().context
        const install = lifecycle.installLocalModel(owner, PIXAI_PROFILE.id)
        const removal = lifecycle.removeLocalModel(owner, PIXAI_PROFILE.id, { scope: 'device' })
        await queue.whenPresented()
        decide(queue, true)
        const started = await install
        await queue.whenPresented()
        decide(queue, true)
        await expect(removal).rejects.toMatchObject({ code: 'CONFLICT' })
        expect(backend.remove).not.toHaveBeenCalled()
        release()
        await settle(lifecycle, owner, started.operationId)
    })

    it('retains at most 100 terminal records and expires them after seven days', async () => {
        let now = 10_000
        let nextId = 0
        const { lifecycle, queue } = setup({
            now: () => now,
            createOperationId: () => `lmo_${++nextId}`,
        })
        const owner = context().context
        const ids: string[] = []
        for (let index = 0; index < 101; index += 1) {
            const started = await approvedInstall(lifecycle, queue, owner)
            ids.push(started.operationId)
            await settle(lifecycle, owner, started.operationId)
        }
        await expect(lifecycle.getLocalModelOperation(owner, ids[0])).rejects.toMatchObject({ code: 'NOT_FOUND' })
        await expect(lifecycle.getLocalModelOperation(owner, ids[100])).resolves.toMatchObject({ state: 'succeeded' })
        now += TERMINAL_OPERATION_TTL_MS + 1
        await expect(lifecycle.getLocalModelOperation(owner, ids[100])).rejects.toMatchObject({ code: 'NOT_FOUND' })
    })

    it('rejects hostile public inputs and redacts unexpected client failures', async () => {
        const { backend, lifecycle } = setup()
        const owner = context().context
        await expect(lifecycle.getLocalModelStatus(owner, 'other')).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' })
        await expect(lifecycle.getLocalModelOperation(owner, '../foreign')).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' })
        await expect(lifecycle.installLocalModel(owner, PIXAI_PROFILE.id, 'callback')).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' })
        await expect(lifecycle.removeLocalModel(owner, PIXAI_PROFILE.id, { scope: 'plugin', extra: true }))
            .rejects.toMatchObject({ code: 'INVALID_ARGUMENT' })
        const getter = Object.defineProperty({}, 'scope', { enumerable: true, get: () => 'device' })
        await expect(lifecycle.removeLocalModel(owner, PIXAI_PROFILE.id, getter)).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' })

        backend.status.mockRejectedValueOnce(new Error('secret host stack'))
        await expect(lifecycle.getLocalModelStatus(owner, PIXAI_PROFILE.id)).rejects.toSatisfy((error: unknown) => {
            expect(error).toMatchObject({ code: 'INTERNAL' })
            expect(String((error as Error).message)).not.toContain('secret')
            return true
        })
    })
})

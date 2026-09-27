import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { get } from 'svelte/store'
import {
    abortGeneration,
    chatGenKey,
    chatProcessStage,
    doingChat,
    endAllGenerations,
    endGeneration,
    generationStates,
    isAnyGenerating,
    isChatGenerating,
    prepareGenerationRestart,
    registerAbort,
    setGenerationStage,
    startGeneration,
    stopGeneration,
    syncDoingChat,
} from './generationState'


beforeEach(() => {
    // endAllGenerations preserves background entries by design; drop them too.
    generationStates.set(new Map())
    endAllGenerations()
    chatProcessStage.set(0)
})

describe('chatGenKey', () => {
    it('uses the real chat id when present', () => {
        expect(chatGenKey('chat-1')).toBe('chat-1')
    })
    it('falls back to a shared key for id-less chats', () => {
        expect(chatGenKey(undefined)).toBe(chatGenKey(undefined))
    })
})

describe('map lifecycle', () => {
    it('start/end creates and removes the entry', () => {
        startGeneration('c1', 'g1')
        expect(isChatGenerating('c1')).toBe(true)
        expect(get(generationStates).get('c1')?.generationId).toBe('g1')
        endGeneration('c1')
        expect(isChatGenerating('c1')).toBe(false)
        expect(get(generationStates).size).toBe(0)
    })

    it('isChatGenerating is per chat', () => {
        startGeneration('c1', 'g1')
        expect(isChatGenerating('c1')).toBe(true)
        expect(isChatGenerating('c2')).toBe(false)
        startGeneration('c2', 'g2')
        endGeneration('c1')
        expect(isChatGenerating('c1')).toBe(false)
        expect(isChatGenerating('c2')).toBe(true)
    })

    it('endGeneration on an unknown chat is a no-op', () => {
        startGeneration('c1', 'g1')
        endGeneration('other')
        expect(isChatGenerating('c1')).toBe(true)
    })

    it('endAllGenerations clears everything live', () => {
        startGeneration('c1', 'g1')
        startGeneration('c2', 'g2')
        endAllGenerations()
        expect(get(generationStates).size).toBe(0)
        expect(get(doingChat)).toBe(false)
    })

    it('endAllGenerations preserves background entries (running server-side jobs)', () => {
        startGeneration('c1', 'g1')
        startGeneration('bg', 'g-bg', 'background')
        endAllGenerations()
        expect(isChatGenerating('c1')).toBe(false)
        expect(isChatGenerating('bg')).toBe(true)
        expect(get(generationStates).get('bg')?.kind).toBe('background')
    })
})

describe('background kind', () => {
    it('does not flip the global doingChat', () => {
        startGeneration('bg', 'g1', 'background')
        expect(get(doingChat)).toBe(false)
        expect(isChatGenerating('bg')).toBe(true) // per-chat guard still held
        startGeneration('live', 'g2')
        expect(get(doingChat)).toBe(true)
        endGeneration('live')
        // background alone → global stays false
        expect(get(doingChat)).toBe(false)
        expect(isChatGenerating('bg')).toBe(true)
    })
})

describe('doingChat compat sync', () => {
    it('mirrors map emptiness through the lifecycle', () => {
        expect(get(doingChat)).toBe(false)
        startGeneration('c1', 'g1')
        expect(get(doingChat)).toBe(true)
        startGeneration('c2', 'g2')
        endGeneration('c1')
        // another chat still generating → stays true
        expect(get(doingChat)).toBe(true)
        endGeneration('c2')
        expect(get(doingChat)).toBe(false)
    })

    it('isAnyGenerating derives from the map', () => {
        expect(get(isAnyGenerating)).toBe(false)
        startGeneration('c1', 'g1')
        expect(get(isAnyGenerating)).toBe(true)
        endGeneration('c1')
        expect(get(isAnyGenerating)).toBe(false)
    })
})

describe('setGenerationStage', () => {
    it('feeds the global compat store (last write wins)', () => {
        setGenerationStage('c1', 3)
        setGenerationStage('c2', 1)
        expect(get(chatProcessStage)).toBe(1)
    })
})

describe('abort registry', () => {
    it('adopts a pre-registered controller into the generation and aborts it', () => {
        const controller = new AbortController()
        registerAbort('c1', controller)
        startGeneration('c1', 'g1')
        expect(get(generationStates).get('c1')?.abortController).toBe(controller)
        expect(abortGeneration('c1')).toBe(true)
        expect(controller.signal.aborted).toBe(true)
    })

    it('attaches to a live generation when the entry already exists', () => {
        startGeneration('c1', 'g1')
        const controller = new AbortController()
        registerAbort('c1', controller)
        abortGeneration('c1')
        expect(controller.signal.aborted).toBe(true)
    })

    it('aborts a still-pending controller (abort clicked before registration)', () => {
        const controller = new AbortController()
        registerAbort('c1', controller)
        expect(abortGeneration('c1')).toBe(true)
        expect(controller.signal.aborted).toBe(true)
    })

    it('only aborts the targeted chat', () => {
        const c1 = new AbortController()
        const c2 = new AbortController()
        registerAbort('c1', c1)
        registerAbort('c2', c2)
        startGeneration('c1', 'g1')
        startGeneration('c2', 'g2')
        abortGeneration('c1')
        expect(c1.signal.aborted).toBe(true)
        expect(c2.signal.aborted).toBe(false)
    })

    it('returns false when there is nothing to abort', () => {
        expect(abortGeneration('c1')).toBe(false)
        startGeneration('c1', 'g1') // no controller registered
        expect(abortGeneration('c1')).toBe(false)
    })

    it('the controller survives a keepPendingAbort end/restart under the same key (auto-continue)', () => {
        const controller = new AbortController()
        registerAbort('c1', controller)
        startGeneration('c1', 'g1')
        endGeneration('c1', { keepPendingAbort: true })
        startGeneration('c1', 'g2')
        expect(get(generationStates).get('c1')?.abortController).toBe(controller)
        expect(abortGeneration('c1')).toBe(true)
        expect(controller.signal.aborted).toBe(true)
    })

    it('a terminal endGeneration drops the pending controller (no stale adoption)', () => {
        const controller = new AbortController()
        registerAbort('c1', controller)
        startGeneration('c1', 'g1')
        endGeneration('c1')
        startGeneration('c1', 'g2')
        expect(get(generationStates).get('c1')?.abortController).toBeUndefined()
        expect(abortGeneration('c1')).toBe(false)
        expect(controller.signal.aborted).toBe(false)
    })

    it('reports false when the wired controller was already aborted', () => {
        const controller = new AbortController()
        registerAbort('c1', controller)
        startGeneration('c1', 'g1')
        expect(abortGeneration('c1')).toBe(true)
        expect(abortGeneration('c1')).toBe(false)
    })

    it('endAllGenerations clears pending controllers', () => {
        registerAbort('c1', new AbortController())
        endAllGenerations()
        expect(abortGeneration('c1')).toBe(false)
    })
})

describe('syncDoingChat', () => {
    it('re-converges the compat store with the map after an external pulse', () => {
        doingChat.set(true) // Suggestion.svelte pulse
        syncDoingChat()
        expect(get(doingChat)).toBe(false)
        startGeneration('c1', 'g1')
        doingChat.set(false)
        syncDoingChat()
        expect(get(doingChat)).toBe(true)
    })
})

describe('owner-scoped endGeneration', () => {
    it('ignores an end from a generation that no longer owns the key', () => {
        startGeneration('c1', 'new')
        expect(endGeneration('c1', { generationId: 'old' })).toBe(false)
        expect(isChatGenerating('c1')).toBe(true)
        expect(endGeneration('c1', { generationId: 'new' })).toBe(true)
        expect(isChatGenerating('c1')).toBe(false)
    })

    it('ignores an end from a caller whose controller is not the registered one', () => {
        const oldCtl = new AbortController()
        const newCtl = new AbortController()
        registerAbort('c1', newCtl)
        startGeneration('c1', 'g-new')
        expect(endGeneration('c1', { controller: oldCtl })).toBe(false)
        expect(isChatGenerating('c1')).toBe(true)
        expect(endGeneration('c1', { controller: newCtl })).toBe(true)
        expect(isChatGenerating('c1')).toBe(false)
    })

    it('does not drop a newer pending controller registered before its generation starts', () => {
        const oldCtl = new AbortController()
        const newCtl = new AbortController()
        registerAbort('c1', newCtl)
        expect(endGeneration('c1', { controller: oldCtl })).toBe(false)
        startGeneration('c1', 'g-new')
        expect(get(generationStates).get('c1')?.abortController).toBe(newCtl)
    })

    it('an owner end after the entry is gone still reports success', () => {
        const ctl = new AbortController()
        expect(endGeneration('c1', { controller: ctl })).toBe(true)
    })
})

describe('stopGeneration (#85)', () => {
    beforeEach(() => { vi.useFakeTimers() })
    afterEach(() => { vi.useRealTimers() })

    it('aborts and leaves release to the pipeline when it winds down in time', () => {
        const ctl = new AbortController()
        registerAbort('c1', ctl)
        startGeneration('c1', 'g1')
        const released = vi.fn()
        stopGeneration('c1', { graceMs: 1000, onForceReleased: released })
        expect(ctl.signal.aborted).toBe(true)
        endGeneration('c1', { generationId: 'g1' })
        vi.advanceTimersByTime(1000)
        expect(released).not.toHaveBeenCalled()
    })

    it('force-releases a live generation that ignores the abort', () => {
        const ctl = new AbortController()
        registerAbort('c1', ctl)
        startGeneration('c1', 'g1')
        const released = vi.fn()
        stopGeneration('c1', { graceMs: 1000, onForceReleased: released })
        vi.advanceTimersByTime(999)
        expect(get(doingChat)).toBe(true)
        vi.advanceTimersByTime(1)
        expect(isChatGenerating('c1')).toBe(false)
        expect(get(doingChat)).toBe(false)
        expect(released).toHaveBeenCalledWith('c1')
    })

    it('does not release a newer generation that took the key during the grace period', () => {
        startGeneration('c1', 'g1')
        const released = vi.fn()
        stopGeneration('c1', { graceMs: 1000, onForceReleased: released })
        endGeneration('c1', { generationId: 'g1' })
        startGeneration('c1', 'g2')
        vi.advanceTimersByTime(1000)
        expect(get(generationStates).get('c1')?.generationId).toBe('g2')
        expect(released).not.toHaveBeenCalled()
    })

    it('leaves background (server job) entries to their poll loop', () => {
        startGeneration('c1', 'job', 'background')
        const released = vi.fn()
        stopGeneration('c1', { graceMs: 1000, onForceReleased: released })
        vi.advanceTimersByTime(1000)
        expect(isChatGenerating('c1')).toBe(true)
        expect(released).not.toHaveBeenCalled()
    })

    it('a force-released send waking up later cannot end the next send', () => {
        const oldCtl = new AbortController()
        registerAbort('c1', oldCtl)
        startGeneration('c1', 'g1')
        stopGeneration('c1', { graceMs: 1000 })
        vi.advanceTimersByTime(1000)
        const newCtl = new AbortController()
        registerAbort('c1', newCtl)
        startGeneration('c1', 'g2')
        // The stuck pipeline finally returns and runs both of its ends.
        expect(endGeneration('c1', { generationId: 'g1' })).toBe(false)
        expect(endGeneration('c1', { controller: oldCtl })).toBe(false)
        expect(get(generationStates).get('c1')?.generationId).toBe('g2')
    })

    it('does not restart a stopped generation before its force-release timer fires', () => {
        const controller = new AbortController()
        registerAbort('c1', controller)
        startGeneration('c1', 'g1')
        stopGeneration('c1', { graceMs: 1000 })

        expect(prepareGenerationRestart('c1', 'g1', controller.signal)).toBe(false)
        expect(get(generationStates).get('c1')?.generationId).toBe('g1')
        expect(controller.signal.aborted).toBe(true)
    })

    it('does not replace a newer owner after the stopped generation is force-released', () => {
        const oldController = new AbortController()
        registerAbort('c1', oldController)
        startGeneration('c1', 'g1')
        stopGeneration('c1', { graceMs: 1000 })
        vi.advanceTimersByTime(1000)

        const newController = new AbortController()
        registerAbort('c1', newController)
        startGeneration('c1', 'g2')
        expect(prepareGenerationRestart('c1', 'g1', oldController.signal)).toBe(false)
        expect(get(generationStates).get('c1')?.generationId).toBe('g2')
        expect(get(generationStates).get('c1')?.abortController).toBe(newController)
    })

    it('allows an active owner to restart while preserving its Stop controller', () => {
        const controller = new AbortController()
        registerAbort('c1', controller)
        startGeneration('c1', 'g1')

        expect(prepareGenerationRestart('c1', 'g1', controller.signal)).toBe(true)
        expect(isChatGenerating('c1')).toBe(false)
        startGeneration('c1', 'g2')
        expect(get(generationStates).get('c1')?.abortController).toBe(controller)
        expect(controller.signal.aborted).toBe(false)
    })
})

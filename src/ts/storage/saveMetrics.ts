// Per-save timings for the storage dashboard. Kept in memory for this tab
// only: enough to tell where a slow save spends its time (chat upload, patch
// diff, server round trip, full-write encode/upload) and how often saves fall
// back to a full write, without logging paths, ids or content.
import { writable } from 'svelte/store'

export type SaveOutcome = 'patch' | 'full' | 'retry' | 'error'

/** Stage timings the server reports on a successful /api/patch. */
export interface PatchServerTimings {
    queueMs?: number
    hashMs?: number
    applyMs?: number
    etagMs?: number
    totalMs?: number
    /** Duration of the most recent debounced disk write of the database. */
    lastPersistMs?: number
}

export interface SaveTiming {
    chatsMs: number
    patchSetMs: number
    patchRequestMs: number
    fullEncodeMs: number
    fullWriteMs: number
    /** Why this save went to a full write instead of a patch. */
    fullWriteReason?: 'forced' | 'no-patch-sync' | 'chat-guard' | 'rejected'
    server?: PatchServerTimings
}

export interface SaveSample extends SaveTiming {
    at: number
    outcome: SaveOutcome
    totalMs: number
}

const MAX_SAMPLES = 100

export const saveSamples = writable<SaveSample[]>([])

export function newSaveTiming(): SaveTiming {
    return { chatsMs: 0, patchSetMs: 0, patchRequestMs: 0, fullEncodeMs: 0, fullWriteMs: 0 }
}

export function recordSaveSample(sample: SaveSample) {
    saveSamples.update((prev) => {
        const next = prev.length >= MAX_SAMPLES ? prev.slice(prev.length - MAX_SAMPLES + 1) : prev.slice()
        next.push(sample)
        return next
    })
}

function percentile(sorted: number[], p: number): number | null {
    if (sorted.length === 0) return null
    const idx = Math.min(sorted.length - 1, Math.ceil(p * sorted.length) - 1)
    return sorted[Math.max(0, idx)]
}

export interface SaveMetricsSummary {
    count: number
    patch: number
    full: number
    retry: number
    error: number
    medianMs: number | null
    p90Ms: number | null
    serverMedianMs: number | null
    queueMedianMs: number | null
    lastPersistMs: number | null
}

export function summarizeSaveSamples(samples: SaveSample[]): SaveMetricsSummary {
    const done = samples.filter((s) => s.outcome === 'patch' || s.outcome === 'full')
    const totals = done.map((s) => s.totalMs).sort((a, b) => a - b)
    const server = samples.map((s) => s.server?.totalMs).filter((v): v is number => typeof v === 'number').sort((a, b) => a - b)
    const queue = samples.map((s) => s.server?.queueMs).filter((v): v is number => typeof v === 'number').sort((a, b) => a - b)
    let lastPersistMs: number | null = null
    for (let i = samples.length - 1; i >= 0; i--) {
        const v = samples[i].server?.lastPersistMs
        if (typeof v === 'number') { lastPersistMs = v; break }
    }
    return {
        count: samples.length,
        patch: samples.filter((s) => s.outcome === 'patch').length,
        full: samples.filter((s) => s.outcome === 'full').length,
        retry: samples.filter((s) => s.outcome === 'retry').length,
        error: samples.filter((s) => s.outcome === 'error').length,
        medianMs: percentile(totals, 0.5),
        p90Ms: percentile(totals, 0.9),
        serverMedianMs: percentile(server, 0.5),
        queueMedianMs: percentile(queue, 0.5),
        lastPersistMs,
    }
}

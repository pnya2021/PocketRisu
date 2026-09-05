import { describe, test, expect } from 'vitest'
import { sidebarStateAfterResize, isWideShell, WIDE_SHELL_BREAKPOINT } from './shellBreakpoint'

describe('sidebarStateAfterResize', () => {
    test('the first sample never changes anything', () => {
        expect(sidebarStateAfterResize(undefined, 1400)).toBeUndefined()
        expect(sidebarStateAfterResize(undefined, 390)).toBeUndefined()
    })

    test('a fixed-width device is never touched, whatever fires resize', () => {
        // Phone: keyboard up/down and address bar collapse only change height.
        for (const width of [360, 390, 412, 430]) {
            expect(sidebarStateAfterResize(width, width)).toBeUndefined()
        }
        // Desktop window that stays wide.
        expect(sidebarStateAfterResize(1920, 1600)).toBeUndefined()
        expect(sidebarStateAfterResize(1600, 1025)).toBeUndefined()
        // Narrow window that stays narrow (fold in portrait, split-screen).
        expect(sidebarStateAfterResize(700, 1024)).toBeUndefined()
        expect(sidebarStateAfterResize(1024, 400)).toBeUndefined()
    })

    test('crossing to narrow closes the overlay, crossing to wide docks it open', () => {
        expect(sidebarStateAfterResize(1400, 800)).toBe(false)
        expect(sidebarStateAfterResize(800, 1400)).toBe(true)
        // Exact boundary: 1024 is narrow, 1025 is wide.
        expect(sidebarStateAfterResize(1025, 1024)).toBe(false)
        expect(sidebarStateAfterResize(1024, 1025)).toBe(true)
    })

    test('breakpoint matches the DynamicGUI rule (width <= 1024 is dynamic)', () => {
        expect(WIDE_SHELL_BREAKPOINT).toBe(1024)
        expect(isWideShell(1024)).toBe(false)
        expect(isWideShell(1025)).toBe(true)
    })
})

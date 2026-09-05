// The app shell docks the sidebar above this width and overlays it at or
// below (see DynamicGUI in stores.svelte.ts). The sidebar's open state was
// only ever decided at boot, so a foldable or split-screen window that
// crossed the breakpoint later kept the state from the other mode
// (issue #79).
export const WIDE_SHELL_BREAKPOINT = 1024

export function isWideShell(width: number): boolean {
    return width > WIDE_SHELL_BREAKPOINT
}

// The sidebar open state to apply after a resize, or undefined when nothing
// should change. Only a crossing of the breakpoint counts: a fixed-width
// device (mobile keyboard, collapsing address bar — height changes only)
// and any resize within one mode leave whatever the user toggled alone.
export function sidebarStateAfterResize(previousWidth: number | undefined, width: number): boolean | undefined {
    if (previousWidth === undefined) return undefined
    const wide = isWideShell(width)
    if (isWideShell(previousWidth) === wide) return undefined
    // Same state a fresh boot at this width would pick.
    return wide
}

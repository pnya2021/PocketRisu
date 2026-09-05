let lastInteractionWasKeyboard = true

if (typeof window !== 'undefined') {
    window.addEventListener('pointerdown', () => {
        lastInteractionWasKeyboard = false
    }, true)
    window.addEventListener('keydown', () => {
        lastInteractionWasKeyboard = true
    }, true)
}

// Suppress bits-ui's close-auto-focus after pointer-driven closes so the focus
// ring doesn't reappear on the trigger; keyboard users keep focus restoration.
export function handleDialogCloseAutoFocus(event: Event): void {
    if (!lastInteractionWasKeyboard) {
        event.preventDefault()
    }
}

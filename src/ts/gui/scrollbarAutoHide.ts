/**
 * Scroll-aware scrollbars. The thumb is faint at rest (styles.css) and drawn
 * stronger while scrolling, fading back once scrolling stops. One
 * capture-phase listener drives it — no per-component wiring.
 *
 * Chromium cannot animate scrollbar parts and only re-resolves their styles
 * when the scroller's own computed style changes, so the thumb alpha is a
 * custom property on the scroller that is stepped here frame by frame.
 */
const HIDE_DELAY_MS = 800
const FADE_MS = 300
const REST_ALPHA = 0.22
const ACTIVE_ALPHA = 0.45
const ALPHA_PROP = '--risu-scrollbar-alpha'

type State = { timer: ReturnType<typeof setTimeout> | null; raf: number | null }
const states = new WeakMap<Element, State>()

function stateOf(el: Element): State {
    let s = states.get(el)
    if (!s) states.set(el, (s = { timer: null, raf: null }))
    return s
}

function setAlpha(el: Element, alpha: number) {
    if (alpha === REST_ALPHA) (el as HTMLElement).style.removeProperty(ALPHA_PROP)
    else (el as HTMLElement).style.setProperty(ALPHA_PROP, alpha.toFixed(3))
}

function fadeOut(el: Element, s: State) {
    const start = performance.now()
    const step = (now: number) => {
        const t = Math.min(1, (now - start) / FADE_MS)
        const eased = 1 - (1 - t) * (1 - t)
        setAlpha(el, t >= 1 ? REST_ALPHA : ACTIVE_ALPHA + (REST_ALPHA - ACTIVE_ALPHA) * eased)
        s.raf = t < 1 ? requestAnimationFrame(step) : null
    }
    s.raf = requestAnimationFrame(step)
}

export function initScrollbarAutoHide() {
    document.addEventListener('scroll', (event) => {
        const el = event.target instanceof Element ? event.target : document.documentElement
        const s = stateOf(el)
        if (s.raf !== null) { cancelAnimationFrame(s.raf); s.raf = null }
        if (s.timer !== null) clearTimeout(s.timer)
        setAlpha(el, ACTIVE_ALPHA)
        s.timer = setTimeout(() => {
            s.timer = null
            fadeOut(el, s)
        }, HIDE_DELAY_MS)
    }, { capture: true, passive: true })
}

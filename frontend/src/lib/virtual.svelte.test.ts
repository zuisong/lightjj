import { describe, it, expect } from 'vitest'
import { flushSync } from 'svelte'
import { createWindower } from './virtual.svelte'

// Svelte-5 runes live in .svelte.ts so $state/$derived/$effect compile.
// createRoot gives us a component-less reactive scope for testing.
function withRoot<T>(fn: () => T): T {
  let result!: T
  $effect.root(() => { result = fn() })
  flushSync()
  return result
}

// jsdom Element lacks scrollTop/clientHeight machinery; stub what we read.
function mkScrollEl(clientHeight: number) {
  const listeners: Record<string, ((e: Event) => void)[]> = {}
  return {
    scrollTop: 0,
    clientHeight,
    addEventListener: (t: string, fn: any) => (listeners[t] ??= []).push(fn),
    removeEventListener: (t: string, fn: any) => {
      listeners[t] = (listeners[t] ?? []).filter(f => f !== fn)
    },
    dispatchEvent: (e: Event) => listeners[e.type]?.forEach(fn => fn(e)),
  } as unknown as HTMLElement
}

describe('createWindower', () => {
  it('computes visible window from scrollTop', () => {
    const el = mkScrollEl(100)  // 100px viewport, 18px rows → ~6 visible
    const w = withRoot(() => createWindower({
      count: () => 1000, scrollEl: () => el, rowHeight: 18, overscan: 2,
    }))
    // first=0 (clamped), last=ceil(100/18)+2=8 → 9 items
    expect(w.items[0].index).toBe(0)
    expect(w.items.at(-1)!.index).toBe(8)
    expect(w.items[0].start).toBe(0)
    expect(w.items[3].start).toBe(54)  // 3*18
  })

  it('tracks scroll events', () => {
    const el = mkScrollEl(100)
    const w = withRoot(() => createWindower({
      count: () => 1000, scrollEl: () => el, rowHeight: 18, overscan: 0,
    }))
    ;(el as any).scrollTop = 360  // row 20
    el.dispatchEvent(new Event('scroll'))
    flushSync()
    expect(w.items[0].index).toBe(20)
  })

  it('totalHeight = count * rowHeight', () => {
    const el = mkScrollEl(100)
    const w = withRoot(() => createWindower({
      count: () => 500, scrollEl: () => el, rowHeight: 18,
    }))
    expect(w.totalHeight).toBe(9000)
  })

  it('scrollToIndex: no-op if already visible (align:auto)', () => {
    const el = mkScrollEl(100)
    const w = withRoot(() => createWindower({
      count: () => 1000, scrollEl: () => el, rowHeight: 18,
    }))
    ;(el as any).scrollTop = 50
    w.scrollToIndex(3)  // row 3 = [54, 72), fully within [50, 150)
    expect((el as any).scrollTop).toBe(50)
  })

  it('scrollToIndex: scrolls up when row is above viewport', () => {
    const el = mkScrollEl(100)
    const w = withRoot(() => createWindower({
      count: () => 1000, scrollEl: () => el, rowHeight: 18,
    }))
    ;(el as any).scrollTop = 200
    w.scrollToIndex(5)  // row 5 top = 90
    expect((el as any).scrollTop).toBe(90)
  })

  it('scrollToIndex: scrolls down when row is below viewport', () => {
    const el = mkScrollEl(100)
    const w = withRoot(() => createWindower({
      count: () => 1000, scrollEl: () => el, rowHeight: 18,
    }))
    w.scrollToIndex(20)  // bottom = 378, viewport = [0,100)
    expect((el as any).scrollTop).toBe(278)  // 378 - 100
  })

  it('clamps last index to count-1', () => {
    const el = mkScrollEl(1000)  // huge viewport
    const w = withRoot(() => createWindower({
      count: () => 5, scrollEl: () => el, rowHeight: 18, overscan: 10,
    }))
    expect(w.items.length).toBe(5)
    expect(w.items.at(-1)!.index).toBe(4)
  })
})

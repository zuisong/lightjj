// Timing helpers for in-process App.svelte interaction tests.
//
// `waitForFrame` matches the double-rAF deferral in
// revision-navigator.svelte.ts:navigateCached — rAF callbacks fire BEFORE
// paint in the same frame, so frame-N rAF's nested rAF lands in frame N+1.
// jsdom rAF is a 16ms setTimeout shim, so this resolves in ~32ms.
// NOTE: with mock-api's `getCached: () => undefined` stub every nav is a
// cache MISS → navigateDeferred (50ms debounce), so navigateCached's rAF path
// is unreachable from App.interactions.test.ts today. This helper is for
// tests that supply a non-trivial getCached stub.
//
// `waitFor` polls a predicate; covers navigateDeferred's 50ms debounce +
// Promise resolve without per-test fake-timer setup.

export function waitForFrame(): Promise<void> {
  return new Promise(resolve =>
    requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
  )
}

export interface WaitForOptions {
  timeout?: number
  interval?: number
}

export function waitFor(
  predicate: () => boolean,
  { timeout = 2000, interval = 10 }: WaitForOptions = {},
): Promise<void> {
  return new Promise((resolve, reject) => {
    const start = Date.now()
    // try/catch — after the first call, tick runs from setTimeout where a
    // throw is an unhandled exception (not a rejection). Surfacing as a
    // rejection means the awaiting test fails with the real error instead of
    // hanging until vitest's own timeout.
    const tick = () => {
      try {
        if (predicate()) return resolve()
      } catch (e) {
        return reject(e)
      }
      if (Date.now() - start >= timeout) {
        return reject(new Error(`waitFor: timed out after ${timeout}ms`))
      }
      setTimeout(tick, interval)
    }
    tick()
  })
}

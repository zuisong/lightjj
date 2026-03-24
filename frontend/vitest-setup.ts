import '@testing-library/jest-dom/vitest'

// jsdom doesn't implement scrollIntoView
Element.prototype.scrollIntoView = () => {}

// jsdom doesn't implement IntersectionObserver — DiffPanel uses it for
// file-tab active-state tracking. No-op stub: observer never fires, which
// is fine for tests (activeFilePath stays null).
globalThis.IntersectionObserver = class {
  observe() {}
  unobserve() {}
  disconnect() {}
  takeRecords() { return [] }
} as unknown as typeof IntersectionObserver

// jsdom doesn't implement ResizeObserver — virtual.svelte.ts uses it for
// viewport height tracking. No-op: tests that need viewportH set clientHeight
// on the mock element, which the factory reads synchronously on attach.
globalThis.ResizeObserver = class {
  observe() {}
  unobserve() {}
  disconnect() {}
} as unknown as typeof ResizeObserver

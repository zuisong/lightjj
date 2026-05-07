// In-process keyboard-interaction tests for App.svelte — the frontend
// equivalent of Go's MockRunner-backed handler tests. Mounts App with the
// real Svelte runtime + a mocked api.ts module, dispatches keydown on
// `window` (App uses `<svelte:window onkeydown>`), asserts via DOM markers.
//
// Covers the keyboard-gate.ts ORDER invariants from the App side, not just
// the routeKeydown unit. Bombadil stays for SSE/tab-remount/real-jj e2e.

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, fireEvent, cleanup } from '@testing-library/svelte'

// Partial mock: pure helpers (effectiveId, diffTargetKey, multiRevset, etc.)
// come from the real module; network-touching exports are overridden via
// netStubs. The dynamic import inside the factory reads the mock-api module
// AFTER vitest's module graph is up — sidesteps vi.mock hoisting.
vi.mock('./lib/api', async (orig) => {
  const real = await orig<typeof import('./lib/api')>()
  const m = await import('./testutil/mock-api')
  return { ...real, ...m.netStubs }
})

// config.svelte.ts uses raw fetch('/api/config') (not the api object) at
// module init AND in a 500ms-debounced save-effect. The api mock doesn't
// cover it. 204 = "backend can't resolve config dir" → config falls through
// to defaults; the save-effect's POST sees ok=false and stays silent.
vi.stubGlobal('fetch', async () => new Response(null, { status: 204 }))

import App from './App.svelte'
import { resetMockApi, calls } from './testutil/mock-api'
import { waitFor } from './testutil/wait-for'

// Dispatch on body, not window: event.target must be an HTMLElement for
// App's isInInput(t) (calls t.closest). The event bubbles to window so
// `<svelte:window onkeydown>` still receives it. Mirrors a real keypress
// with nothing focused (browser sets target = document.body).
const press = (key: string) => fireEvent.keyDown(document.body, { key })

const qs = (sel: string) => document.querySelector(sel)
const selectedEntry = () => qs('.graph-row.node-row.selected')?.getAttribute('data-entry')

async function mountApp() {
  const r = render(App)
  // loadLog() is fired at module-body level; wait for the graph to render.
  // workingCopyIndex (entry 0 in defaultFixtures) becomes selectedIndex.
  await waitFor(() => document.querySelectorAll('.graph-row.node-row').length === 3)
  return r
}

beforeEach(() => {
  resetMockApi()
  cleanup()
})

describe('App.svelte interactions', () => {
  it('mounts with the fixture log and selects the working copy', async () => {
    await mountApp()
    expect(document.querySelectorAll('.graph-row.node-row')).toHaveLength(3)
    expect(selectedEntry()).toBe('0')
    expect(calls.some(c => c.method === 'log')).toBe(true)
    expect(calls.some(c => c.method === 'info')).toBe(true)
  })

  it('j/k move the selection cursor', async () => {
    await mountApp()
    expect(selectedEntry()).toBe('0')
    await press('j')
    await waitFor(() => selectedEntry() === '1')
    await press('j')
    await waitFor(() => selectedEntry() === '2')
    await press('k')
    await waitFor(() => selectedEntry() === '1')
  })

  it('Space toggles the checked state on the selected revision', async () => {
    await mountApp()
    expect(qs('.graph-row[data-entry="0"].checked')).toBeNull()
    await press(' ')
    await waitFor(() => qs('.graph-row[data-entry="0"].checked') !== null)
    await press(' ')
    await waitFor(() => qs('.graph-row[data-entry="0"].checked') === null)
  })

  // Locks keyboard-gate.ts: `if (c.inlineMode) return h.inlineNav()` is
  // TERMINAL — globalKeys (e.g. '2' switch-view) and logKeys (e.g. Space
  // toggle-check) do NOT fire while a mode is active. j/k can't distinguish
  // (inlineNav.rebase ALSO calls navKey→selectRevision for the dest cursor).
  it('R enters rebase mode; inlineNav swallows globalKeys+logKeys; Escape cancels', async () => {
    await mountApp()
    expect(qs('.statusbar.rebase-active')).toBeNull()

    await press('R')
    await waitFor(() => qs('.statusbar.rebase-active') !== null)
    // Scoped — RevisionGraph also renders .mode-badge for source/dest markers
    // (the documented .mode-badge name collision in CLAUDE.md).
    expect(qs('.statusbar .mode-badge')?.textContent).toBe('rebase')

    // inlineNav.rebase routes j/k → selectRevision (destination cursor): j
    // DOES move .selected. Asserting this guards against j becoming dead.
    await press('j')
    await waitFor(() => selectedEntry() === '1')

    // globalKeys: '2' would switch to branches view in normal mode.
    await press('2')
    expect(qs('.bp-list')).toBeNull()
    expect(qs('.statusbar.rebase-active')).not.toBeNull()
    // logKeys: Space would toggle .checked in normal mode.
    await press(' ')
    expect(qs('.graph-row.checked')).toBeNull()

    await press('Escape')
    await waitFor(() => qs('.statusbar.rebase-active') === null)
    // Out of rebase mode, '2' works again.
    await press('2')
    await waitFor(() => qs('.bp-list') !== null)
  })

  it("'2' switches to branches view, '1' returns to log", async () => {
    await mountApp()
    expect(qs('.bp-list')).toBeNull()
    await press('2')
    await waitFor(() => qs('.bp-list') !== null)
    expect(calls.some(c => c.method === 'bookmarks')).toBe(true)
    await press('1')
    await waitFor(() => qs('.bp-list') === null)
  })

  // Locks keyboard-gate.ts:64-71 — branches view falls through delegateBranches
  // → globalKeys → logKeys, so Space/@/n still act on the still-visible
  // RevisionGraph. delegateBranches doesn't claim Space (no preventDefault).
  it('Space in branches view falls through to logKeys (toggles check)', async () => {
    await mountApp()
    await press('2')
    await waitFor(() => qs('.bp-list') !== null)
    expect(qs('.graph-row.checked')).toBeNull()
    await press(' ')
    await waitFor(() => qs('.graph-row[data-entry="0"].checked') !== null)
  })
})

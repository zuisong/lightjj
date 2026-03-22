import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { createRevisionNavigator } from './revision-navigator.svelte'
import { api, type LogEntry } from './api'

vi.mock('./api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./api')>()
  return {
    ...actual,
    api: {
      ...actual.api,
      revision: vi.fn(),
      diff: vi.fn(),
      files: vi.fn(),
      description: vi.fn(),
    },
  }
})

const mockApi = vi.mocked(api)

function mkCommit(commitId: string): LogEntry['commit'] {
  return {
    commit_id: commitId,
    change_id: `change-${commitId}`,
    change_prefix: 4,
    commit_prefix: 4,
    is_working_copy: false,
    hidden: false,
    immutable: false,
    conflicted: false,
    divergent: false,
    empty: false,
    mine: true,
  }
}

const noAbort = () => false

// loadDiffAndFiles fires diff.load/files.load/description.load without awaiting
// (matches App.svelte's fire-and-forget). Flush the microtask + macrotask queue
// so the loaders' internal `await fetch(...)` + result application complete.
const flush = () => new Promise(r => setTimeout(r, 0))

// Single-target commitId extraction — avoids repeating the type narrowing.
function targetCommitId(nav: ReturnType<typeof createRevisionNavigator>): string | undefined {
  const t = nav.diff.value.target
  return t?.kind === 'single' ? t.commitId : undefined
}

beforeEach(() => {
  // mockReset() alone makes the mock return undefined — a prior test's
  // leaked navigateDeferred timer (50ms debounce) firing into THIS test's
  // beforeEach would hit `undefined.catch()` at revision-navigator:97.
  // Default to a resolved promise so the chain is always valid.
  mockApi.revision.mockReset().mockResolvedValue({} as never)
  mockApi.diff.mockReset().mockResolvedValue('' as never)
  mockApi.files.mockReset().mockResolvedValue([] as never)
  mockApi.description.mockReset().mockResolvedValue('' as never)
})

describe('revGen await-gap race', () => {
  // The scenario these tests lock in:
  //
  //   loadDiffAndFiles(A)
  //     gen = ++revGen         // revGen=1
  //     await api.revision(A)  // ── suspended ──────────────────┐
  //                                                              │
  //        <interleaved event>        // revGen=2                │
  //                                                              │
  //     // resumed ───────────────────────────────────────────────┘
  //     if (gen !== revGen) return    // 1 !== 2 → bails ✓
  //     diff.load(A)                  // ← never reached
  //
  // Without revGen, the resumed call's diff.load(A) bumps loader.generation
  // PAST whatever the interleaved event set, and A wins. See docs/CACHING.md.

  it('applyCacheHit invalidates suspended loadDiffAndFiles', async () => {
    const nav = createRevisionNavigator({ onError: vi.fn() })

    let resolveA!: () => void
    mockApi.revision.mockImplementation(() => new Promise<void>(r => { resolveA = r }))

    // Spy the loader to verify diff.load(A) never fires
    const diffLoadSpy = vi.spyOn(nav.diff, 'load')

    const loadA = nav.loadDiffAndFiles(mkCommit('A'), noAbort)
    // loadA is now suspended at `await api.revision('A')`.

    // While suspended: user j/k's to B, cache hit applies synchronously
    nav.applyCacheHit(mkCommit('B'), { diff: 'B-diff', files: [], description: 'B-desc' })
    expect(targetCommitId(nav)).toBe('B')
    expect(nav.description.value).toBe('B-desc')

    // Resume A. It should see revGen !== gen and bail.
    resolveA()
    await loadA

    // diff.load(singleTarget(A)) was NEVER called — that's the whole point.
    // If it had been, loader.generation would bump past the set(B) above,
    // and once api.diff('A') resolved (cache hit or not), A would overwrite B.
    expect(diffLoadSpy).not.toHaveBeenCalled()

    // State still shows B.
    expect(targetCommitId(nav)).toBe('B')
    expect(nav.description.value).toBe('B-desc')
  })

  it('second loadDiffAndFiles invalidates suspended first', async () => {
    const nav = createRevisionNavigator({ onError: vi.fn() })

    const resolvers: Record<string, () => void> = {}
    mockApi.revision.mockImplementation((id: string) =>
      new Promise<void>(r => { resolvers[id] = r }))
    mockApi.diff.mockResolvedValue({ diff: 'B-diff' })
    mockApi.files.mockResolvedValue([])
    mockApi.description.mockResolvedValue({ description: 'B-desc' })

    const loadA = nav.loadDiffAndFiles(mkCommit('A'), noAbort)
    // Suspended at await api.revision('A')

    const loadB = nav.loadDiffAndFiles(mkCommit('B'), noAbort)
    // Suspended at await api.revision('B') — revGen is now 2

    // A resumes FIRST (stale). Should bail at the gen check.
    resolvers['A']()
    await loadA
    expect(mockApi.diff).not.toHaveBeenCalled()
    expect(nav.diff.value.target).toBeUndefined() // still initial

    // B resumes — current gen, proceeds to diff.load
    resolvers['B']()
    await loadB
    await flush() // diff.load is fire-and-forget; flush its internal await chain
    expect(mockApi.diff).toHaveBeenCalledWith('B') // diffTargetKey(single(B)) === commitId
    expect(targetCommitId(nav)).toBe('B')
  })

  it('cancel() invalidates suspended loadDiffAndFiles', async () => {
    const nav = createRevisionNavigator({ onError: vi.fn() })

    let resolveA!: () => void
    mockApi.revision.mockImplementation(() => new Promise<void>(r => { resolveA = r }))

    const diffLoadSpy = vi.spyOn(nav.diff, 'load')

    const loadA = nav.loadDiffAndFiles(mkCommit('A'), noAbort)
    nav.cancel()
    resolveA()
    await loadA

    expect(diffLoadSpy).not.toHaveBeenCalled()
    // cancel() doesn't touch loader values — still initial.
    expect(nav.diff.value.target).toBeUndefined()
  })

  it('shouldAbort re-checked AFTER await — catches mid-fetch state changes', async () => {
    const nav = createRevisionNavigator({ onError: vi.fn() })

    let resolveA!: () => void
    mockApi.revision.mockImplementation(() => new Promise<void>(r => { resolveA = r }))

    let aborted = false
    const diffLoadSpy = vi.spyOn(nav.diff, 'load')

    const loadA = nav.loadDiffAndFiles(mkCommit('A'), () => aborted)
    // User checks a revision during the fetch — the multi-check effect already
    // fired via the intendedTarget $effect, so loadDiffAndFiles should NOT clobber.
    aborted = true

    resolveA()
    await loadA

    expect(diffLoadSpy).not.toHaveBeenCalled()
  })
})

describe('loadDiffAndFiles happy path', () => {
  it('batch succeeds → all three loaders fire and apply', async () => {
    const nav = createRevisionNavigator({ onError: vi.fn() })
    mockApi.revision.mockResolvedValue(undefined)
    mockApi.diff.mockResolvedValue({ diff: 'A-diff' })
    mockApi.files.mockResolvedValue([{ type: 'M', path: 'a.go', additions: 1, deletions: 0, conflict: false, conflict_sides: 0 }])
    mockApi.description.mockResolvedValue({ description: 'A-desc' })

    await nav.loadDiffAndFiles(mkCommit('A'), noAbort)
    await flush() // loaders are fire-and-forget

    expect(nav.diff.value).toEqual({
      target: expect.objectContaining({ kind: 'single', commitId: 'A' }),
      diff: 'A-diff',
    })
    expect(nav.files.value).toEqual([{ type: 'M', path: 'a.go', additions: 1, deletions: 0, conflict: false, conflict_sides: 0 }])
    expect(nav.description.value).toBe('A-desc')
  })

  it('batch fails → only diff loader fires (one error toast, not three)', async () => {
    const onError = vi.fn()
    const nav = createRevisionNavigator({ onError })

    mockApi.revision.mockRejectedValue(new Error('batch down'))
    mockApi.diff.mockRejectedValue(new Error('diff down'))

    await nav.loadDiffAndFiles(mkCommit('A'), noAbort)
    await flush() // let diff.load's rejection propagate

    // diff.load fired (and errored), files/description did NOT fire
    expect(mockApi.diff).toHaveBeenCalledTimes(1)
    expect(mockApi.files).not.toHaveBeenCalled()
    expect(mockApi.description).not.toHaveBeenCalled()
    expect(onError).toHaveBeenCalledTimes(1)
  })
})

describe('applyCacheHit', () => {
  it('sets all three loader values synchronously', () => {
    const nav = createRevisionNavigator({ onError: vi.fn() })
    nav.applyCacheHit(mkCommit('X'), { diff: 'X-diff', files: [], description: 'X-desc' })

    expect(targetCommitId(nav)).toBe('X')
    expect(nav.diff.value.diff).toBe('X-diff')
    expect(nav.files.value).toEqual([])
    expect(nav.description.value).toBe('X-desc')
  })

  it('singleTarget derives changeId via effectiveId (divergent → commit_id)', () => {
    const nav = createRevisionNavigator({ onError: vi.fn() })
    const divergent = { ...mkCommit('D'), divergent: true }
    const t = nav.singleTarget(divergent)
    expect(t.kind === 'single' && t.changeId).toBe('D') // commit_id, not change_id
  })
})

// Scheduling was previously inline in App.svelte's selectRevision (72 lines,
// untestable). navigateCached/navigateDeferred own the rAF/debounce timers
// now; cancel() clears both. These tests pin the TIMING contract — the "rAF
// runs BEFORE paint" comment in the interface docstring is what we test
// AROUND (can't test paint), but we CAN test: double-rAF means two frame
// ticks before fire, and rapid calls only fire the last.
describe('navigateCached — double-rAF paint-first deferral', () => {
  const hit = { diff: 'cached-diff', files: [], description: 'cached-desc' }

  // jsdom rAF is setTimeout(16) under the hood. Two advances = two "frames".
  const frame = () => new Promise(r => requestAnimationFrame(() => r(undefined)))

  it('fires after two frames, not one — cursor paints alone in frame N', async () => {
    const nav = createRevisionNavigator({ onError: vi.fn() })
    nav.navigateCached(mkCommit('A'), hit, () => false)

    // After one frame, nothing applied yet (outer rAF fired, inner scheduled).
    await frame()
    expect(targetCommitId(nav)).toBeUndefined()

    // After second frame, applied.
    await frame()
    expect(targetCommitId(nav)).toBe('A')
    expect(nav.diff.value.diff).toBe('cached-diff')
  })

  it('second navigateCached cancels first — only last lands', async () => {
    // Rapid j/k through cached revisions: each press schedules, each cancels
    // prior. Only the destination's diff lands. This is what makes cached
    // j/k FASTER than uncached (no intermediate DOM builds).
    const nav = createRevisionNavigator({ onError: vi.fn() })
    nav.navigateCached(mkCommit('A'), { ...hit, diff: 'A-diff' }, () => false)
    nav.navigateCached(mkCommit('B'), { ...hit, diff: 'B-diff' }, () => false)

    await frame(); await frame()
    expect(targetCommitId(nav)).toBe('B')
    expect(nav.diff.value.diff).toBe('B-diff')
  })

  it('abort() checked at fire — loadLog resetting selectedIndex cancels', async () => {
    // abort callback closes over App's selectedIndex. If loadLog (or
    // selectRevisionCursorOnly, or branches-view click) moves the cursor
    // WITHOUT calling selectRevision, the rAF still fires but abort()
    // sees the mismatch and bails. Without this, stale cache hit would
    // land over whatever the cursor now points at.
    const nav = createRevisionNavigator({ onError: vi.fn() })
    let aborted = false
    nav.navigateCached(mkCommit('A'), hit, () => aborted)

    await frame()
    aborted = true  // cursor moved between frames
    await frame()

    expect(targetCommitId(nav)).toBeUndefined()
  })

  it('navigateCached invalidates suspended loadDiffAndFiles BEFORE rAF fires', async () => {
    // The revGen bump at navigateCached entry (not inside the rAF callback)
    // is load-bearing: a loadDiffAndFiles suspended at its await could
    // resume BETWEEN schedule and fire, call diff.load(stale), and bump
    // loader.gen past the eventual applyCacheHit. Bumping revGen at
    // schedule time stops it before it can race.
    const nav = createRevisionNavigator({ onError: vi.fn() })

    let resolveA!: () => void
    mockApi.revision.mockImplementation(() => new Promise<void>(r => { resolveA = r }))
    const diffLoadSpy = vi.spyOn(nav.diff, 'load')

    void nav.loadDiffAndFiles(mkCommit('A'), noAbort)
    await Promise.resolve()  // let it reach the await

    nav.navigateCached(mkCommit('B'), hit, () => false)  // bumps revGen NOW

    resolveA()  // A resumes — should see revGen mismatch and bail
    await flush()

    expect(diffLoadSpy).not.toHaveBeenCalled()

    // rAF hasn't fired yet — B also not applied
    expect(targetCommitId(nav)).toBeUndefined()

    await frame(); await frame()
    expect(targetCommitId(nav)).toBe('B')
  })
})

describe('navigateDeferred — 50ms debounce coalesce', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  it('rapid uncached j/k coalesces to CURRENT cursor at fire time', async () => {
    // getCommit is re-read at fire. Three j presses within 50ms → only
    // one load, for whatever getCommit returns THEN (the final cursor).
    const nav = createRevisionNavigator({ onError: vi.fn() })
    mockApi.revision.mockResolvedValue(undefined)
    mockApi.diff.mockResolvedValue({ diff: 'C-diff' })
    mockApi.files.mockResolvedValue([])
    mockApi.description.mockResolvedValue({ description: '' })

    let current = mkCommit('A')
    nav.navigateDeferred(() => current, noAbort)
    current = mkCommit('B')
    nav.navigateDeferred(() => current, noAbort)  // cancels A's timer
    current = mkCommit('C')
    nav.navigateDeferred(() => current, noAbort)  // cancels B's timer

    // 49ms: nothing fired.
    await vi.advanceTimersByTimeAsync(49)
    expect(mockApi.revision).not.toHaveBeenCalled()

    // 50ms: fires once with C (what getCommit returns NOW).
    await vi.advanceTimersByTimeAsync(1)
    expect(mockApi.revision).toHaveBeenCalledTimes(1)
    expect(mockApi.revision).toHaveBeenCalledWith('C')
  })

  it('getCommit() returning null aborts — cursor cleared during debounce', async () => {
    const nav = createRevisionNavigator({ onError: vi.fn() })
    let current: ReturnType<typeof mkCommit> | null = mkCommit('A')
    nav.navigateDeferred(() => current, noAbort)

    current = null  // e.g. revisions became empty
    await vi.advanceTimersByTimeAsync(50)
    expect(mockApi.revision).not.toHaveBeenCalled()
  })

  it('entry-time revGen bump invalidates suspended loadDiffAndFiles', async () => {
    // /simplify quality review found the asymmetry: navigateCached bumps
    // revGen at schedule time, navigateDeferred didn't. Without the bump,
    // a suspended loadDiffAndFiles(A) resumes during the 50ms window, passes
    // its gen check, and fires diff.load(A) — loader gen eventually discards
    // the stale result, but the fetch itself is wasted. Now both bump at entry.
    const nav = createRevisionNavigator({ onError: vi.fn() })
    let resolveA!: () => void
    mockApi.revision.mockImplementation(() => new Promise<void>(r => { resolveA = r }))
    const diffLoadSpy = vi.spyOn(nav.diff, 'load')

    void nav.loadDiffAndFiles(mkCommit('A'), noAbort)
    await Promise.resolve()  // reach the await

    nav.navigateDeferred(() => mkCommit('B'), noAbort)  // bumps revGen

    resolveA()
    await Promise.resolve()
    expect(diffLoadSpy).not.toHaveBeenCalled()  // A bailed at revGen check
  })

  it('cancel() clears pending debounce', async () => {
    // switchToLogView, handleRevsetSubmit, onDestroy all call nav.cancel().
    const nav = createRevisionNavigator({ onError: vi.fn() })
    nav.navigateDeferred(() => mkCommit('A'), noAbort)
    nav.cancel()
    await vi.advanceTimersByTimeAsync(100)
    expect(mockApi.revision).not.toHaveBeenCalled()
  })

  it('navigateCached cancels a pending navigateDeferred (cross-path)', async () => {
    // j (uncached, debounce scheduled) → j (cached, rAF scheduled). The
    // second must cancel the first's timer or we'd fire BOTH (debounce
    // loads stale, then rAF applies cached).
    const nav = createRevisionNavigator({ onError: vi.fn() })
    nav.navigateDeferred(() => mkCommit('A'), noAbort)
    nav.navigateCached(mkCommit('B'), { diff: 'B', files: [], description: '' }, () => false)

    await vi.advanceTimersByTimeAsync(100)
    expect(mockApi.revision).not.toHaveBeenCalled()  // debounce cancelled
  })
})

// Separate describe — needs REAL timers for jsdom rAF (setTimeout(16)).
describe('cancel() — rAF path', () => {
  const frame = () => new Promise(r => requestAnimationFrame(() => r(undefined)))

  it('cancel() clears pending rAF', async () => {
    const nav = createRevisionNavigator({ onError: vi.fn() })
    nav.navigateCached(mkCommit('B'), { diff: 'B', files: [], description: '' }, () => false)
    nav.cancel()
    await frame(); await frame()
    expect(targetCommitId(nav)).toBeUndefined()
  })

  it('navigateDeferred cancels a pending navigateCached (reverse cross-path)', async () => {
    // j (cached, rAF scheduled) → j (uncached, debounce scheduled).
    // clearSchedule() in navigateDeferred must cancel BOTH rAF and setTimeout.
    // If it only cleared its own timer kind, the stale rAF would fire and
    // applyCacheHit(A) would land AFTER the debounce's loadDiffAndFiles(B).
    const nav = createRevisionNavigator({ onError: vi.fn() })
    nav.navigateCached(mkCommit('A'), { diff: 'A', files: [], description: '' }, () => false)
    nav.navigateDeferred(() => mkCommit('B'), noAbort)

    await frame(); await frame()
    expect(targetCommitId(nav)).toBeUndefined()  // A's rAF cancelled
  })
})

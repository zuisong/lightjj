// Fetch orchestration for the revision diff/files/description triple.
// Extracted from App.svelte to make the revGen await-gap race testable
// (docs/CACHING.md "Race-safety layer"). Owns the three content loaders;
// App.svelte wires selectedIndex/checkedRevisions/debounce around it.

import { createLoader, type Loader } from './loader.svelte'
import { api, effectiveId, diffTargetKey, type LogEntry, type FileChange, type DiffTarget } from './api'

type Commit = LogEntry['commit']
type CacheHit = { diff: string; files: FileChange[]; description: string }

// diff loader carries its DiffTarget alongside the content so identity and
// value land in one $state write — structurally in phase. loadedTarget (what
// DiffPanel renders) is derived from here, not from the cursor position.
// Closes the "identity changes 50ms before content" edge that every timing
// bug in the diff view traces back to.
export type LoadedDiff = { target: DiffTarget | undefined; diff: string }

export interface RevisionNavigator {
  readonly diff: Loader<LoadedDiff, [DiffTarget]>
  readonly files: Loader<FileChange[], [string]>
  readonly description: Loader<string, [string]>
  singleTarget(c: Commit): DiffTarget
  /**
   * Batch fetch diff+files+description, seeding the api.ts cache, then fire
   * the individual loaders (cache hits). `shouldAbort` is re-checked after
   * the await — e.g. "user checked a revision while we were fetching, the
   * multi-check effect already fired, don't clobber".
   */
  loadDiffAndFiles(commit: Commit, shouldAbort: () => boolean): Promise<void>
  /**
   * Synchronous cache-hit application. Bumps revGen so any suspended
   * loadDiffAndFiles bails before firing its `diff.load()` — without this,
   * the resumed call's `diff.load(stale)` would bump loader.generation PAST
   * the `diff.set()` here and win. See docs/CACHING.md "revGen await-gap race".
   */
  applyCacheHit(commit: Commit, hit: CacheHit): void
  /**
   * Invalidate any in-flight loadDiffAndFiles AND any pending navigate*
   * schedule without changing loader values. For App-level "stop whatever's
   * pending" cases (clear-checks, mode entry, switchToLogView).
   */
  cancel(): void
  /**
   * Schedule applyCacheHit past the next paint (double-rAF). Cancels any
   * prior navigate* schedule. `abort()` re-checked at fire — guards against
   * cursor moving via a path that doesn't call navigate* (loadLog's
   * selectedIndex reset, selectRevisionCursorOnly).
   *
   * Double-rAF: rAF callbacks run BEFORE paint in the same frame (event →
   * microtasks → rAF → style → layout → paint). Outer rAF = frame N pre-paint;
   * inner = frame N+1 pre-paint. Frame N paints the cursor move alone; the
   * diff DOM lands in frame N+1. Single rAF would batch cursor + diff into
   * one frame, making cached j/k feel SLOWER than uncached.
   */
  navigateCached(commit: Commit, hit: CacheHit, abort: () => boolean): void
  /**
   * Schedule loadDiffAndFiles after a 50ms debounce. Cancels any prior
   * navigate* schedule. `getCommit()` is re-read at fire — rapid uncached
   * j/k coalesces to whatever the cursor points at WHEN the debounce expires,
   * not what it pointed at when scheduled. Return null to abort.
   */
  navigateDeferred(getCommit: () => Commit | null, abort: () => boolean): void
}

export function createRevisionNavigator(opts: {
  onError: (e: unknown) => void
}): RevisionNavigator {
  const diff = createLoader(
    (t: DiffTarget) => api.diff(diffTargetKey(t)).then(r => ({ target: t, diff: r.diff })),
    { target: undefined, diff: '' } as LoadedDiff,
    opts.onError,
  )
  const files = createLoader((id: string) => api.files(id), [] as FileChange[], opts.onError)
  const description = createLoader((id: string) => api.description(id).then(r => r.description), '')

  // revGen guards the gap between `await api.revision()` and `diff.load()`.
  // loader.generation alone isn't enough: it invalidates in-flight load()
  // calls, but a suspended loadDiffAndFiles hasn't CALLED diff.load() yet —
  // when it resumes and calls it, that call bumps loader.generation past any
  // intervening set()/load() and wins. revGen catches it before the call.
  let revGen = 0

  function singleTarget(c: Commit): DiffTarget {
    return {
      kind: 'single',
      commitId: c.commit_id,
      changeId: effectiveId(c),
      isWorkingCopy: c.is_working_copy,
      immutable: c.immutable,
    }
  }

  async function loadDiffAndFiles(commit: Commit, shouldAbort: () => boolean): Promise<void> {
    const gen = ++revGen
    let batchFailed = false
    await api.revision(commit.commit_id).catch(() => { batchFailed = true })
    if (gen !== revGen || shouldAbort()) return
    diff.load(singleTarget(commit))
    // On batch failure, only diff.load fires — one error toast, not three.
    if (batchFailed) return
    files.load(commit.commit_id)
    description.load(commit.commit_id)
  }

  function applyCacheHit(commit: Commit, hit: CacheHit): void {
    revGen++
    // target + diff in one $state write → DiffPanel sees them together.
    diff.set({ target: singleTarget(commit), diff: hit.diff })
    files.set(hit.files)
    description.set(hit.description)
  }

  // Scheduling timers — previously App.svelte instance state (navRafId,
  // navDebounceTimer). Owning them here means cancel() clears everything
  // in one call, and the double-rAF timing is testable via fake timers.
  let navRafId = 0
  let navDebounceTimer: ReturnType<typeof setTimeout> | undefined

  function clearSchedule(): void {
    cancelAnimationFrame(navRafId)
    clearTimeout(navDebounceTimer)
  }

  function navigateCached(commit: Commit, hit: CacheHit, abort: () => boolean): void {
    clearSchedule()
    // revGen bump NOW: a loadDiffAndFiles suspended at its await would
    // otherwise resume AFTER the rAF fires below, call diff.load(stale),
    // and bump the loader generation past applyCacheHit's set(). Bumping
    // here invalidates it before it can race.
    revGen++
    navRafId = requestAnimationFrame(() => {
      navRafId = requestAnimationFrame(() => {
        if (abort()) return
        applyCacheHit(commit, hit)
      })
    })
  }

  function navigateDeferred(getCommit: () => Commit | null, abort: () => boolean): void {
    clearSchedule()
    // Same entry-time bump as navigateCached: a suspended loadDiffAndFiles
    // could otherwise resume during the 50ms window, pass its revGen check,
    // and fire diff.load(stale). Loader gen eventually discards the stale
    // result, but the fetch itself is wasted. Bumping here stops it before
    // diff.load is ever called.
    revGen++
    navDebounceTimer = setTimeout(() => {
      const commit = getCommit()
      if (!commit || abort()) return
      loadDiffAndFiles(commit, abort)
    }, 50)
  }

  function cancel(): void {
    clearSchedule()
    revGen++
  }

  return {
    diff, files, description, singleTarget,
    loadDiffAndFiles, applyCacheHit, cancel,
    navigateCached, navigateDeferred,
  }
}

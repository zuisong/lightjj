// Shared mutation-concurrency policy for the two review stores
// (annotations.svelte.ts + doc-session.svelte.ts). Both stores mutate a
// server-backed comment list while navigation, polling, and typing can
// concurrently rewrite the same local state. Before this factory each store
// hand-rolled its own policy (annotations: apply-after-confirm + gen-check
// discard; doc-session: optimistic apply + rollback) and race fixes landed in
// one but not the other. This is the single place the policy lives.
//
// Strategy: OPTIMISTIC apply + rollback-on-error.
// - apply() runs synchronously before the server write → instant UI feedback
//   (a comment appears the moment you press Enter, a checkbox toggles on
//   click). Visible on every SSH round-trip (~400ms).
// - If persist() rejects, rollback(stillCurrent) undoes the local write, the
//   message is recorded in `error`, and the rejection is rethrown (callers
//   that surface errors via state instead of exceptions catch it themselves).
// - Why optimistic over apply-after-confirm: apply-after-confirm punishes
//   every successful mutation (UI lags the click by a network round trip) to
//   simplify the rare failed one. The failure path here is still safe —
//   rollback restores the pre-apply state and the error is surfaced.
//
// Generation counter: shared across mutations AND the store's own
// loads/refreshes/position-remaps — the store calls bump() from those paths
// and current() to discard their own stale completions. rollback receives
// stillCurrent = "no other write bumped the generation since this mutation
// applied":
// - snapshot-restore rollbacks MUST check it (restoring a stale snapshot
//   would clobber a newer load/refresh/remap),
// - surgical by-id rollbacks (remove the phantom item that failed to save)
//   can ignore it — deleting by id is safe regardless of what else changed.

export interface ReviewMutation {
  /** Synchronous local state write — runs before the server call. */
  apply: () => void
  /** The server write. */
  persist: () => Promise<unknown>
  /** Undo apply() after a persist failure. `stillCurrent` is false when
   *  another mutation/load/remap bumped the generation since apply(). */
  rollback: (stillCurrent: boolean) => void
}

export interface ReviewMutations {
  /** True while a track()-wrapped operation (load) is in flight. Reactive. */
  readonly busy: boolean
  /** True while any run()-routed mutation is in flight. Stores use this to
   *  suppress background refreshes that would race the optimistic write.
   *  NON-reactive (plain counter) — imperative reads from async store code
   *  only, never from templates/$derived. */
  readonly mutating: boolean
  /** Message from the most recent failed mutation. Cleared when the next
   *  mutation starts. */
  readonly error: string
  /** Invalidate in-flight work: pending loads see current() === false,
   *  pending mutation rollbacks see stillCurrent === false. */
  bump(): number
  /** Whether generation `g` is still current (no bump since). */
  current(g: number): boolean
  /** Busy-flag bookkeeping for non-mutation async work (loads). */
  track<T>(fn: () => Promise<T>): Promise<T>
  /** Run an optimistic mutation: apply → persist → on failure rollback +
   *  record + rethrow. */
  run(m: ReviewMutation): Promise<void>
}

export function createReviewMutations(): ReviewMutations {
  let gen = 0
  // PLAIN counters + write-only $state flags — NOT $state counters.
  // track()/run() execute synchronously inside callers' $effects (DiffPanel's
  // annotation-load effect calls store.load() → track()), and `count++` on a
  // $state signal is a read+write of the same signal from inside that effect →
  // effect_update_depth_exceeded. The $state flags below are only ever
  // ASSIGNED here (never read), so calling effects don't pick them up as
  // dependencies; readers (templates, store getters) get reactivity from the
  // flag, not the counter.
  let trackCount = 0
  let runCount = 0
  let busy = $state(false)
  let error = $state('')

  return {
    get busy() {
      return busy
    },
    // Non-reactive by design: read imperatively from store-internal async
    // paths (refresh suppression), never from templates.
    get mutating() {
      return runCount > 0
    },
    get error() {
      return error
    },
    bump: () => ++gen,
    current: (g) => g === gen,
    async track<T>(fn: () => Promise<T>): Promise<T> {
      trackCount++
      busy = true
      try {
        return await fn()
      } finally {
        busy = --trackCount > 0
      }
    },
    async run({ apply, persist, rollback }: ReviewMutation): Promise<void> {
      const g = ++gen
      apply()
      error = ''
      runCount++
      try {
        await persist()
      } catch (e) {
        rollback(g === gen)
        error = e instanceof Error ? e.message : String(e)
        throw e
      } finally {
        runCount--
      }
    },
  }
}

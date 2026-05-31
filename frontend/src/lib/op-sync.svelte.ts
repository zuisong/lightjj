// Op-id-driven auto-refresh policy for repo-scoped server state.
//
// Pairs with createLoader: the loader owns the VALUE (value/loading/error + generation
// supersede); an OpSync owns the WHEN — op-id staleness, gate/enabled suppression,
// throttling, and explicit-vs-auto refresh dedup. Together they replace hand-wired
// staleness effects + per-mirror load scheduling: a server-state mirror is one
// createLoader + one createOpSync declaration.
//
// EFFECT-WIRING RULE (verified against svelte 5.55 reactivity source): the auto-refresh
// $effect reads its staleness inputs RAW — opId(), reflectsOpId, epoch — never through a
// memoized boolean $derived. A $derived that recomputes true→true does not advance its
// write version, so dependent effects do NOT re-run. Folding staleness into a derived
// boolean would swallow: an op-id arriving while already stale (a failed fetch would
// never retry), an op-id arriving mid-fetch (the "exactly one more refresh" guarantee),
// and every other true→true transition. This is the inverse of the derived-boolean-gate
// rule in docs/design-notes/frontend-perf.md — that rule is for effects that WANT
// fewer re-fires; staleness effects need every one.

import { untrack } from 'svelte'

export interface OpSyncOptions {
  /**
   * The load thunk. Must apply its own value (a Loader.load call, or a load function
   * built on one) and resolve true iff the result was applied (not superseded).
   */
  run: () => Promise<boolean>
  /** Raw op-id read (the host component's currentOpId $state). */
  opId: () => string | null
  /**
   * Suppression gate (mutating / modal open / inline mode / log loading). Read ONLY
   * while stale, so it becomes a dependency exactly when it matters: a suppressed
   * refresh re-fires the moment the gate clears. Staleness is retained, never dropped.
   */
  gate?: () => boolean
  /** Auto-refresh runs only while enabled (panel-open predicates). Read only while stale. */
  enabled?: () => boolean
  /** Minimum interval between AUTO refreshes. Explicit refresh() bypasses and stamps it. */
  throttleMs?: number
  /**
   * Treat creation as a completed fetch: no auto-refresh until the first op-id change,
   * and the throttle window starts at creation. For expensive scans that must never run
   * at mount (e.g. the stale-immutable check — a divergent()&immutable() revset scan
   * that costs seconds on monorepo-scale repos).
   */
  startFresh?: boolean
}

export interface OpSync {
  /**
   * Explicit refresh (post-mutation hooks, 'r' key, panel refresh buttons, mount).
   * Bypasses gate/enabled/throttle, stamps the attempted op-id and the throttle
   * timestamp, and resolves only after run() completes — callers may read the applied
   * value immediately after the await.
   */
  refresh(): Promise<boolean>
  /**
   * Stamp "the current value reflects the current op-id" after an optimistic
   * loader.set() — e.g. clearing stale-immutable groups right after the cleanup
   * mutation. Also stamps the throttle timestamp so the optimistic value isn't
   * refetched the moment the mutation's own op-id advance lands.
   */
  markFresh(): void
}

/** Create an OpSync. Must be called during component init (it creates an $effect). */
export function createOpSync(o: OpSyncOptions): OpSync {
  // Op-id captured at the start of the last APPLIED run. $state: applying a run must
  // re-evaluate the effect — an op-id that arrived mid-run leaves us stale → exactly
  // one more refresh.
  let reflectsOpId = $state<string | null>(null)
  // Bumped on EVERY run completion — applied, superseded, or failed. $state: failures
  // don't move reflectsOpId, but the effect still must re-evaluate (to release the
  // in-flight hold; the retry itself waits for the next op-id via the attempted check).
  let epoch = $state(0)
  // Has any run ever applied (or startFresh)? A never-loaded resource is stale by
  // definition — this is what makes a panel's first open fetch even though no op-id
  // change has been observed yet (currentOpId stays null until the first CHANGE).
  // Plain: every write site also writes a $state (epoch or reflectsOpId).
  let hasApplied = false
  // Op-id of the last STARTED run. Plain (non-reactive) on purpose: one auto attempt
  // per op-id, so a persistently failing fetch doesn't retry-loop. `undefined` =
  // never attempted — distinct from "attempted while the op-id was still null".
  let attempted: string | null | undefined = undefined
  // Throttle timestamp. Plain: changes never need to re-fire the effect.
  let lastRun = 0
  let inFlight = false

  if (o.startFresh) {
    // Creation counts as a completed fetch — without this, a gate/enabled flap
    // after the throttle window (but before any operation) would run the fetch.
    hasApplied = true
    lastRun = Date.now()
  }

  async function attempt(): Promise<boolean> {
    // untrack: refresh() may be called from inside an effect or template handler; the
    // op-id read must not become that caller's reactive dependency.
    const op = untrack(o.opId)
    attempted = op
    lastRun = Date.now()
    inFlight = true
    let applied = false
    try {
      applied = await o.run()
    } catch {
      // run() is normally a Loader.load, which never rejects; treat a rejection like a
      // failed (unapplied) load so refresh() callers don't need try/catch.
      applied = false
    } finally {
      inFlight = false
      // Capture-at-start: the value is at least as fresh as the op-id read before
      // running (op-ids only advance). An op-id that arrived mid-run leaves
      // reflectsOpId behind → still stale → the epoch bump re-fires the effect.
      if (applied) {
        reflectsOpId = op
        hasApplied = true
      }
      epoch++
    }
    return applied
  }

  /** The auto-refresh decision, shared by the effect body and the deferred re-check. */
  function shouldAttempt(op: string | null, reflects: string | null): boolean {
    const stale = !hasApplied || (op !== null && op !== reflects)
    if (!stale) return false
    if (o.enabled && !o.enabled()) return false
    if (o.gate && o.gate()) return false
    if (inFlight) return false // completion bumps epoch → the effect re-enters
    if (o.throttleMs && Date.now() - lastRun < o.throttleMs) return false
    if (attempted === op) return false // one auto attempt per (op-id, never-attempted)
    return true
  }

  $effect(() => {
    // RAW reads — the always-on dependencies (see header). The suppression reads
    // inside shouldAttempt() become dependencies only when execution reaches them,
    // i.e. only while stale.
    const op = o.opId()
    const reflects = reflectsOpId
    void epoch

    if (!shouldAttempt(op, reflects)) return

    // Defer one macrotask and re-check: post-mutation flows call refresh() right after
    // the mutation's response; their attempted stamp lands inside this window and the
    // re-check skips the duplicate fetch.
    const t = setTimeout(() => {
      // Runs outside the effect's tracked scope — these reads create no dependencies.
      if (!shouldAttempt(o.opId(), reflectsOpId)) return
      void attempt()
    }, 0)
    return () => clearTimeout(t)
  })

  return {
    refresh: attempt,
    markFresh() {
      reflectsOpId = untrack(o.opId)
      hasApplied = true
      attempted = reflectsOpId
      lastRun = Date.now()
    },
  }
}

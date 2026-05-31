import { describe, it, expect, vi, afterEach } from 'vitest'
import { flushSync } from 'svelte'
import { createOpSync, type OpSync, type OpSyncOptions } from './op-sync.svelte'

// Yield to the macrotask queue — lets the sync's deferred-refresh timer fire and
// promise continuations run.
const macrotask = () => new Promise(r => setTimeout(r, 0))

/**
 * Test harness: reactive op-id / gate / enabled signals, a run() mock returning
 * manually-resolved deferreds, and the sync under test inside an $effect.root.
 */
function makeHarness(opts: Partial<OpSyncOptions> = {}) {
  let opId = $state<string | null>(null)
  let gateOn = $state(false)
  let enabledOn = $state(true)

  const runs: Array<{ resolve: (applied: boolean) => void; reject: (e: unknown) => void }> = []
  const run = vi.fn(
    () => new Promise<boolean>((resolve, reject) => { runs.push({ resolve, reject }) }),
  )

  let sync!: OpSync
  const destroy = $effect.root(() => {
    sync = createOpSync({
      run,
      opId: () => opId,
      gate: () => gateOn,
      enabled: () => enabledOn,
      ...opts,
    })
  })
  flushSync()

  return {
    run,
    runs,
    get sync() { return sync },
    destroy,
    setOpId(v: string | null) { opId = v; flushSync() },
    setGate(v: boolean) { gateOn = v; flushSync() },
    setEnabled(v: boolean) { enabledOn = v; flushSync() },
    /** Resolve the i-th run() call and let continuations + effects settle. */
    async resolveRun(i: number, applied: boolean) {
      runs[i].resolve(applied)
      await macrotask()
      flushSync()
    },
    async rejectRun(i: number) {
      runs[i].reject(new Error('boom'))
      await macrotask()
      flushSync()
    },
    /** Let the deferred-refresh timer fire, then run scheduled effects. */
    async settle() {
      await macrotask()
      flushSync()
    },
  }
}

let cleanup: Array<() => void> = []
afterEach(() => {
  for (const fn of cleanup) fn()
  cleanup = []
  vi.restoreAllMocks()
})
const tracked = <T extends { destroy: () => void }>(h: T): T => {
  cleanup.push(h.destroy)
  return h
}

describe('createOpSync — auto-refresh', () => {
  it('a never-fetched sync is stale by definition: fetches once even before any op-id', async () => {
    // currentOpId stays null until the first op-id CHANGE (api.ts treats the first
    // observation as the baseline) — a resource that has never loaded must not wait
    // for an operation to happen before showing data.
    const h = tracked(makeHarness())
    await h.settle()
    expect(h.run).toHaveBeenCalledTimes(1)
    await h.resolveRun(0, true)
    // Applied (under op-id null) → no longer stale → inert.
    await h.settle()
    expect(h.run).toHaveBeenCalledTimes(1)
  })

  it('panel-open before the first op-id: the enable flip triggers the first fetch', async () => {
    const h = tracked(makeHarness())
    h.setEnabled(false) // panel closed from the start (clears the creation-time defer)
    await h.settle()
    expect(h.run).not.toHaveBeenCalled()
    h.setEnabled(true) // first open — no op-id has ever been observed
    await h.settle()
    expect(h.run).toHaveBeenCalledTimes(1)
  })

  it('an explicit mount-time refresh() pre-empts the never-fetched auto-fetch', async () => {
    const h = tracked(makeHarness())
    const p = h.sync.refresh() // mount block front-runs the effect's deferred fetch
    expect(h.run).toHaveBeenCalledTimes(1)
    await h.resolveRun(0, true)
    await p
    await h.settle()
    expect(h.run).toHaveBeenCalledTimes(1) // the deferred re-check found it applied
  })

  it('fetches when the first op-id arrives, after one macrotask defer', async () => {
    const h = tracked(makeHarness())
    await h.settle()
    await h.resolveRun(0, true) // never-fetched initial load
    h.setOpId('op1')
    expect(h.run).toHaveBeenCalledTimes(1) // deferred — not synchronous
    await h.settle()
    expect(h.run).toHaveBeenCalledTimes(2)
    await h.resolveRun(1, true)
    // Applied under op1 → no longer stale → no further fetches.
    await h.settle()
    expect(h.run).toHaveBeenCalledTimes(2)
  })

  it('refetches when a new op-id arrives after a successful apply', async () => {
    const h = tracked(makeHarness())
    h.setOpId('op1')
    await h.settle()
    await h.resolveRun(0, true)
    h.setOpId('op2')
    await h.settle()
    expect(h.run).toHaveBeenCalledTimes(2)
  })

  it('coalesces op-ids arriving before the deferred timer fires into one fetch', async () => {
    const h = tracked(makeHarness())
    h.setOpId('op1')
    h.setOpId('op2') // before macrotask — effect re-runs, old timer cleared, new one set
    await h.settle()
    expect(h.run).toHaveBeenCalledTimes(1)
    await h.resolveRun(0, true)
    // The single fetch captured op2 at start → applying it covers both.
    await h.settle()
    expect(h.run).toHaveBeenCalledTimes(1)
  })
})

describe('createOpSync — the three review races', () => {
  it('RACE 1: a failed fetch retries on the NEXT op-id (one attempt per op-id, no loop)', async () => {
    const h = tracked(makeHarness())
    h.setOpId('op1')
    await h.settle()
    expect(h.run).toHaveBeenCalledTimes(1)
    await h.rejectRun(0)
    // Still stale (nothing applied) but attempted=op1 → no retry loop for op1.
    await h.settle()
    await h.settle()
    expect(h.run).toHaveBeenCalledTimes(1)
    // A new op-id is a new attempt.
    h.setOpId('op2')
    await h.settle()
    expect(h.run).toHaveBeenCalledTimes(2)
  })

  it('RACE 2: an op-id arriving mid-fetch triggers exactly one more refresh after completion', async () => {
    const h = tracked(makeHarness())
    h.setOpId('op1')
    await h.settle()
    expect(h.run).toHaveBeenCalledTimes(1)
    // op2 lands while the op1 fetch is in flight — no concurrent auto fetch.
    h.setOpId('op2')
    await h.settle()
    expect(h.run).toHaveBeenCalledTimes(1)
    // Completion: applied under op1 → still stale vs op2 → exactly one more.
    await h.resolveRun(0, true)
    await h.settle()
    expect(h.run).toHaveBeenCalledTimes(2)
    await h.resolveRun(1, true)
    await h.settle()
    expect(h.run).toHaveBeenCalledTimes(2) // and no third
  })

  it('RACE 3: op-ids arriving while suppressed by the gate still refresh when it clears', async () => {
    const h = tracked(makeHarness())
    h.setGate(true)
    h.setOpId('op1')
    await h.settle()
    expect(h.run).not.toHaveBeenCalled()
    // Staleness deepens while gated — must not be dropped.
    h.setOpId('op2')
    await h.settle()
    expect(h.run).not.toHaveBeenCalled()
    h.setGate(false)
    await h.settle()
    expect(h.run).toHaveBeenCalledTimes(1)
    await h.resolveRun(0, true)
    await h.settle()
    expect(h.run).toHaveBeenCalledTimes(1) // captured op2 at start → done
  })
})

describe('createOpSync — capture-at-start', () => {
  it('a superseded run (applied=false) does not mark the sync fresh', async () => {
    const h = tracked(makeHarness())
    h.setOpId('op1')
    await h.settle()
    expect(h.run).toHaveBeenCalledTimes(1)
    // The loader superseded this result (e.g. an explicit load won the race).
    await h.resolveRun(0, false)
    // Still stale, but attempted=op1 → waits for the next op-id (parity with failure).
    await h.settle()
    expect(h.run).toHaveBeenCalledTimes(1)
    h.setOpId('op2')
    await h.settle()
    expect(h.run).toHaveBeenCalledTimes(2)
  })
})

describe('createOpSync — explicit refresh()', () => {
  it('bypasses gate and enabled', async () => {
    const h = tracked(makeHarness())
    h.setGate(true)
    h.setEnabled(false)
    h.setOpId('op1')
    const p = h.sync.refresh()
    expect(h.run).toHaveBeenCalledTimes(1)
    await h.resolveRun(0, true)
    expect(await p).toBe(true)
  })

  it('resolves only after run() completes, with its applied result', async () => {
    const h = tracked(makeHarness())
    h.setOpId('op1')
    const p = h.sync.refresh()
    let resolved = false
    void p.then(() => { resolved = true })
    await macrotask()
    expect(resolved).toBe(false) // run still pending
    await h.resolveRun(0, true)
    expect(await p).toBe(true)
    expect(resolved).toBe(true)
  })

  it('stamps the attempted op-id so the auto effect skips the duplicate fetch', async () => {
    const h = tracked(makeHarness())
    // Mutation flow: op-id from the response header arrives, then the post-mutation
    // explicit refresh() runs — both inside the same macrotask window.
    h.setOpId('op1')
    const p = h.sync.refresh() // before the deferred auto timer fires
    expect(h.run).toHaveBeenCalledTimes(1)
    await h.resolveRun(0, true)
    await p
    // The auto timer fires after — and must not start a second fetch.
    await h.settle()
    expect(h.run).toHaveBeenCalledTimes(1)
  })

  it('a rejected run() resolves refresh() to false instead of throwing', async () => {
    const h = tracked(makeHarness())
    h.setOpId('op1')
    const p = h.sync.refresh()
    await h.rejectRun(0)
    expect(await p).toBe(false)
  })
})

describe('createOpSync — enabled (panel-open predicates)', () => {
  it('no auto-refresh while disabled; becoming enabled while stale triggers one', async () => {
    const h = tracked(makeHarness())
    h.setEnabled(false)
    h.setOpId('op1')
    await h.settle()
    expect(h.run).not.toHaveBeenCalled()
    h.setEnabled(true) // panel opened
    await h.settle()
    expect(h.run).toHaveBeenCalledTimes(1)
  })

  it('becoming enabled when NOT stale does not refetch (reopen with fresh data)', async () => {
    const h = tracked(makeHarness())
    h.setOpId('op1')
    await h.settle()
    await h.resolveRun(0, true)
    h.setEnabled(false) // panel closed
    h.setEnabled(true) // reopened, op-id unchanged
    await h.settle()
    expect(h.run).toHaveBeenCalledTimes(1)
  })
})

describe('createOpSync — throttle', () => {
  it('suppresses auto refresh within throttleMs; the next op-id after the window fetches', async () => {
    let now = 1_000_000
    vi.spyOn(Date, 'now').mockImplementation(() => now)
    const h = tracked(makeHarness({ throttleMs: 60_000 }))
    h.setOpId('op1')
    await h.settle()
    expect(h.run).toHaveBeenCalledTimes(1) // first fetch: lastRun was 0 → no suppression
    await h.resolveRun(0, true)
    // Second op-id 10s later → inside the window → suppressed.
    now += 10_000
    h.setOpId('op2')
    await h.settle()
    expect(h.run).toHaveBeenCalledTimes(1)
    // Third op-id past the window → fetches.
    now += 60_000
    h.setOpId('op3')
    await h.settle()
    expect(h.run).toHaveBeenCalledTimes(2)
  })

  it('explicit refresh() ignores the throttle and stamps it', async () => {
    let now = 1_000_000
    vi.spyOn(Date, 'now').mockImplementation(() => now)
    const h = tracked(makeHarness({ throttleMs: 60_000 }))
    h.setOpId('op1')
    await h.settle()
    await h.resolveRun(0, true)
    // Explicit refresh right after — bypasses the window.
    now += 1_000
    const p = h.sync.refresh()
    expect(h.run).toHaveBeenCalledTimes(2)
    await h.resolveRun(1, true)
    await p
    // And it stamped the window: an op-id 10s after the explicit fetch is suppressed.
    now += 10_000
    h.setOpId('op2')
    await h.settle()
    expect(h.run).toHaveBeenCalledTimes(2)
  })
})

describe('createOpSync — startFresh', () => {
  it('treats creation as a completed fetch: first op-id inside the window is suppressed', async () => {
    let now = 1_000_000
    vi.spyOn(Date, 'now').mockImplementation(() => now)
    const h = tracked(makeHarness({ throttleMs: 60_000, startFresh: true }))
    // First op-id 10s after creation → inside the creation-stamped window → no fetch.
    now += 10_000
    h.setOpId('op1')
    await h.settle()
    expect(h.run).not.toHaveBeenCalled()
    // Op-id after the window → fetches.
    now += 60_000
    h.setOpId('op2')
    await h.settle()
    expect(h.run).toHaveBeenCalledTimes(1)
  })
})

describe('createOpSync — markFresh (optimistic writes)', () => {
  it('stamps the current op-id and throttle: no refetch for the op-id it covers', async () => {
    let now = 1_000_000
    vi.spyOn(Date, 'now').mockImplementation(() => now)
    const h = tracked(makeHarness({ throttleMs: 60_000 }))
    h.setOpId('op1')
    await h.settle()
    await h.resolveRun(0, true)
    // Cleanup mutation: its op-id lands, the after-hook writes the value optimistically
    // and marks fresh — the expensive scan must NOT re-run.
    now += 70_000 // past the throttle window, so only markFresh protects it
    h.setOpId('op2')
    h.sync.markFresh()
    await h.settle()
    expect(h.run).toHaveBeenCalledTimes(1)
    // A later op-id outside the (re-stamped) window refetches normally.
    now += 70_000
    h.setOpId('op3')
    await h.settle()
    expect(h.run).toHaveBeenCalledTimes(2)
  })
})

describe('createOpSync — teardown', () => {
  it('destroying the root cancels a pending deferred refresh', async () => {
    const h = makeHarness()
    h.setOpId('op1')
    h.destroy() // before the macrotask timer fires
    await macrotask()
    expect(h.run).not.toHaveBeenCalled()
  })
})

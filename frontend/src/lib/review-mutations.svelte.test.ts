import { describe, expect, it } from 'vitest'
import { createReviewMutations } from './review-mutations.svelte'

/** Manually-resolvable promise for in-flight assertions. */
function deferred<T = void>() {
  let resolve!: (v: T) => void
  let reject!: (e: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

describe('createReviewMutations', () => {
  it('run(): apply happens before persist resolves (optimistic)', async () => {
    const m = createReviewMutations()
    const d = deferred()
    let state = 0
    const p = m.run({
      apply: () => {
        state = 1
      },
      persist: () => d.promise,
      rollback: () => {
        state = 0
      },
    })
    expect(state).toBe(1) // applied synchronously
    expect(m.mutating).toBe(true)
    d.resolve()
    await p
    expect(state).toBe(1)
    expect(m.mutating).toBe(false)
    expect(m.error).toBe('')
  })

  it('run(): rollback + error + rethrow on persist failure', async () => {
    const m = createReviewMutations()
    let state = 0
    await expect(
      m.run({
        apply: () => {
          state = 1
        },
        persist: () => Promise.reject(new Error('boom')),
        rollback: (cur) => {
          if (cur) state = 0
        },
      }),
    ).rejects.toThrow('boom')
    expect(state).toBe(0) // rolled back (gen unchanged)
    expect(m.error).toBe('boom')
    expect(m.mutating).toBe(false)
  })

  it('run(): rollback sees stillCurrent=false when another write bumped the gen', async () => {
    const m = createReviewMutations()
    const d = deferred()
    let snapshotRestored = false
    const p = m.run({
      apply: () => {},
      persist: () => d.promise,
      rollback: (cur) => {
        if (cur) snapshotRestored = true
      },
    })
    // Concurrent write (a load completing, the user typing) invalidates the
    // pending rollback's snapshot.
    m.bump()
    d.reject(new Error('net'))
    await expect(p).rejects.toThrow('net')
    expect(snapshotRestored).toBe(false) // stale snapshot NOT restored
    expect(m.error).toBe('net')
  })

  it('run(): surgical rollbacks (ignore stillCurrent) always run', async () => {
    const m = createReviewMutations()
    const d = deferred()
    const list: string[] = []
    const p = m.run({
      apply: () => list.push('phantom'),
      persist: () => d.promise,
      // Surgical: delete-by-id is safe regardless of concurrent writes.
      rollback: () => {
        const i = list.indexOf('phantom')
        if (i >= 0) list.splice(i, 1)
      },
    })
    m.bump() // concurrent write
    d.reject(new Error('x'))
    await expect(p).rejects.toThrow('x')
    expect(list).toEqual([]) // phantom removed despite gen bump
  })

  it('run(): a new mutation clears the previous error', async () => {
    const m = createReviewMutations()
    await m
      .run({
        apply: () => {},
        persist: () => Promise.reject(new Error('first')),
        rollback: () => {},
      })
      .catch(() => {})
    expect(m.error).toBe('first')
    await m.run({ apply: () => {}, persist: async () => {}, rollback: () => {} })
    expect(m.error).toBe('')
  })

  it('bump()/current(): loads discard their own stale completions', async () => {
    const m = createReviewMutations()
    const g1 = m.bump()
    expect(m.current(g1)).toBe(true)
    const g2 = m.bump()
    expect(m.current(g1)).toBe(false)
    expect(m.current(g2)).toBe(true)
    // A mutation also invalidates pending loads.
    await m.run({ apply: () => {}, persist: async () => {}, rollback: () => {} })
    expect(m.current(g2)).toBe(false)
  })

  it('track(): busy covers tracked work, not run() mutations', async () => {
    const m = createReviewMutations()
    const dLoad = deferred()
    const dMut = deferred()

    const load = m.track(() => dLoad.promise)
    expect(m.busy).toBe(true)
    expect(m.mutating).toBe(false)

    const mut = m.run({ apply: () => {}, persist: () => dMut.promise, rollback: () => {} })
    expect(m.mutating).toBe(true)

    dLoad.resolve()
    await load
    expect(m.busy).toBe(false)
    expect(m.mutating).toBe(true) // mutation still in flight

    dMut.resolve()
    await mut
    expect(m.mutating).toBe(false)
  })

  it('track(): busy clears on rejection and rethrows', async () => {
    const m = createReviewMutations()
    await expect(m.track(() => Promise.reject(new Error('load failed')))).rejects.toThrow('load failed')
    expect(m.busy).toBe(false)
  })

  it('overlapping mutations: each rollback checks its own gen capture', async () => {
    const m = createReviewMutations()
    const dA = deferred()
    const dB = deferred()
    const restored: string[] = []

    const a = m.run({
      apply: () => {},
      persist: () => dA.promise,
      rollback: (cur) => {
        if (cur) restored.push('a')
      },
    })
    const b = m.run({
      apply: () => {},
      persist: () => dB.promise,
      rollback: (cur) => {
        if (cur) restored.push('b')
      },
    })

    // A's gen was invalidated by B starting; B's gen is still current.
    dA.reject(new Error('a-fail'))
    dB.reject(new Error('b-fail'))
    await expect(a).rejects.toThrow('a-fail')
    await expect(b).rejects.toThrow('b-fail')
    expect(restored).toEqual(['b'])
  })
})

import { describe, it, expect } from 'vitest'
import fc from 'fast-check'
import { diffBlocks, blocksToLineSets, type ChangeBlock } from './merge-diff'

// Replace each block's b-range with its a-range, right-to-left so earlier
// indices stay valid. The LINE-LEVEL inverse of "take all of a" — no char
// offsets, so it's correct under blank lines (unlike planTake's separator math).
const applyBlocks = (a: string[], b: string[], blocks: ChangeBlock[]): string[] => {
  const result = b.slice()
  for (let i = blocks.length - 1; i >= 0; i--) {
    const blk = blocks[i]
    result.splice(blk.bFrom - 1, blk.bTo - blk.bFrom, ...a.slice(blk.aFrom - 1, blk.aTo - 1))
  }
  return result
}

describe('diffBlocks', () => {
  it('identical → no blocks', () => {
    expect(diffBlocks(['a', 'b'], ['a', 'b'])).toEqual([])
  })

  it('single mid-line change → one block', () => {
    const r = diffBlocks(['foo', 'bar', 'baz'], ['foo', 'BAR', 'baz'])
    expect(r).toEqual([{ aFrom: 2, aTo: 3, bFrom: 2, bTo: 3 }])
  })

  it('insertion in b → block with empty a-range', () => {
    // a=['a','c'] b=['a','b','c'] → b added line 2
    const r = diffBlocks(['a', 'c'], ['a', 'b', 'c'])
    expect(r).toEqual([{ aFrom: 2, aTo: 2, bFrom: 2, bTo: 3 }])
  })

  it('deletion from a → block with empty b-range', () => {
    const r = diffBlocks(['a', 'b', 'c'], ['a', 'c'])
    expect(r).toEqual([{ aFrom: 2, aTo: 3, bFrom: 2, bTo: 2 }])
  })

  it('two separate conflict regions → two blocks', () => {
    const a = ['same', 'ours1', 'same', 'ours2', 'same']
    const b = ['same', 'theirs1', 'same', 'theirs2', 'same']
    const r = diffBlocks(a, b)
    expect(r).toEqual([
      { aFrom: 2, aTo: 3, bFrom: 2, bTo: 3 },
      { aFrom: 4, aTo: 5, bFrom: 4, bTo: 5 },
    ])
  })

  it('multi-line replacement block', () => {
    const a = ['head', 'x1', 'x2', 'tail']
    const b = ['head', 'y1', 'y2', 'y3', 'tail']
    const r = diffBlocks(a, b)
    expect(r).toEqual([{ aFrom: 2, aTo: 4, bFrom: 2, bTo: 5 }])
  })

  it('leading + trailing changes', () => {
    const a = ['A', 'mid', 'C']
    const b = ['X', 'mid', 'Z']
    const r = diffBlocks(a, b)
    expect(r).toEqual([
      { aFrom: 1, aTo: 2, bFrom: 1, bTo: 2 },
      { aFrom: 3, aTo: 4, bFrom: 3, bTo: 4 },
    ])
  })

  it('empty a → one block covering all of b', () => {
    const r = diffBlocks([], ['x', 'y'])
    expect(r).toEqual([{ aFrom: 1, aTo: 1, bFrom: 1, bTo: 3 }])
  })

  it('both empty → no blocks', () => {
    expect(diffBlocks([], [])).toEqual([])
  })

  it('merge semantics: applying ours-block to theirs produces ours', () => {
    // Round-trip check — the whole point of ChangeBlock.
    const ours = ['shared', 'OURS-A', 'OURS-B', 'mid', 'OURS-C', 'end']
    const theirs = ['shared', 'theirs-a', 'mid', 'theirs-c', 'theirs-d', 'end']
    const blocks = diffBlocks(ours, theirs)
    expect(applyBlocks(ours, theirs, blocks)).toEqual(ours)
  })
})

// ── diffBlocks — property sweep (fast-check) ─────────────────────────────────
// Line-level invariants. Blanks INCLUDED: diffBlocks is offset-free (operates on
// line arrays), so the blank-line bug that scopes the planTake sweep doesn't
// apply here — these properties hold for any line content.
describe('diffBlocks — property sweep (fast-check)', () => {
  // Small alphabet (incl. '') so LCS finds real common subsequences → multi-
  // block shapes, blank-line runs, reshuffles. minLength 0 covers the empty-side
  // base cases (diffBlocks has dedicated m===0 / n===0 branches).
  const linesArb = fc.array(fc.constantFrom('A', 'B', 'C', 'D', 'X', 'Y', ''), { maxLength: 8 })

  it('reconstruction: applyBlocks(a, b, diffBlocks(a,b)) === a', () => {
    // The keystone invariant — transitively proves blocks cover exactly the
    // non-LCS regions (a stray differing line outside a block would survive).
    fc.assert(fc.property(linesArb, linesArb, (a, b) => {
      expect(applyBlocks(a, b, diffBlocks(a, b))).toEqual(a)
    }), { numRuns: 500 })
  })

  it('blocks are ordered and non-overlapping in BOTH coordinate spaces', () => {
    fc.assert(fc.property(linesArb, linesArb, (a, b) => {
      const blocks = diffBlocks(a, b)
      for (let i = 1; i < blocks.length; i++) {
        // Strictly after the previous block ends (LCS line between them, so
        // gap ≥ 1 — adjacent blocks would have been merged into one).
        expect(blocks[i].bFrom).toBeGreaterThan(blocks[i - 1].bTo)
        expect(blocks[i].aFrom).toBeGreaterThan(blocks[i - 1].aTo)
      }
    }), { numRuns: 300 })
  })

  it('every block is well-formed: in-bounds, non-inverted, ≥1 non-empty side', () => {
    fc.assert(fc.property(linesArb, linesArb, (a, b) => {
      for (const blk of diffBlocks(a, b)) {
        expect(blk.aFrom).toBeGreaterThanOrEqual(1)
        expect(blk.aTo).toBeLessThanOrEqual(a.length + 1)
        expect(blk.bFrom).toBeGreaterThanOrEqual(1)
        expect(blk.bTo).toBeLessThanOrEqual(b.length + 1)
        expect(blk.aTo).toBeGreaterThanOrEqual(blk.aFrom)
        expect(blk.bTo).toBeGreaterThanOrEqual(blk.bFrom)
        // A block with both sides empty would be a no-op — the flush() guard
        // (merge-diff.ts:55) drops those.
        expect(blk.aTo - blk.aFrom + (blk.bTo - blk.bFrom)).toBeGreaterThan(0)
      }
    }), { numRuns: 300 })
  })

  it('blocksToLineSets = union of the block ranges', () => {
    fc.assert(fc.property(linesArb, linesArb, (a, b) => {
      const blocks = diffBlocks(a, b)
      const { aOnly, bOnly } = blocksToLineSets(blocks)
      const expA = new Set<number>()
      const expB = new Set<number>()
      for (const blk of blocks) {
        for (let i = blk.aFrom; i < blk.aTo; i++) expA.add(i)
        for (let i = blk.bFrom; i < blk.bTo; i++) expB.add(i)
      }
      expect([...aOnly].sort()).toEqual([...expA].sort())
      expect([...bOnly].sort()).toEqual([...expB].sort())
    }), { numRuns: 300 })
  })

  it('reconstruction holds in the reverse direction too (b from a)', () => {
    // NOT block-count symmetry: when multiple equal-length common subsequences
    // exist, LCS tie-breaking can split the regions differently each way (e.g.
    // a=['D','','Y'], b=['A','D','Y','D',''] → 2 blocks one way, 3 the other).
    // Reconstruction is the direction-independent invariant.
    fc.assert(fc.property(linesArb, linesArb, (a, b) => {
      expect(applyBlocks(b, a, diffBlocks(b, a))).toEqual(b)
    }), { numRuns: 300 })
  })
})

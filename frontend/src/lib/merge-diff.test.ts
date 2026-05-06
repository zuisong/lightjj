import { describe, it, expect } from 'vitest'
import { diffBlocks } from './merge-diff'

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
    // Apply each block (replace theirs[bFrom..bTo) with ours[aFrom..aTo))
    // in reverse order so indices stay valid.
    let result = theirs.slice()
    for (const blk of [...blocks].reverse()) {
      const oursSlice = ours.slice(blk.aFrom - 1, blk.aTo - 1)
      result.splice(blk.bFrom - 1, blk.bTo - blk.bFrom, ...oursSlice)
    }
    expect(result).toEqual(ours)
  })
})

import { describe, it, expect } from 'vitest'
import { expandGaps } from './context-expand'
import type { DiffFile, DiffLine } from './diff-parser'

const ctx = (s: string): DiffLine => ({ type: 'context', content: ` ${s}` })
const add = (s: string): DiffLine => ({ type: 'add', content: `+${s}` })

// 10-line file, hunks at lines 3 and 8.
const original: DiffFile = {
  header: '', filePath: 'f.txt',
  hunks: [
    { header: '@@', oldStart: 3, newStart: 3, newCount: 1, lines: [add('C')] },
    { header: '@@', oldStart: 8, newStart: 8, newCount: 1, lines: [add('H')] },
  ],
}

// Full-context: single hunk from line 1, all 10 lines.
const full: DiffFile = {
  header: '', filePath: 'f.txt',
  hunks: [{
    header: '@@', oldStart: 1, newStart: 1, newCount: 10,
    lines: [ctx('a'), ctx('b'), add('C'), ctx('d'), ctx('e'), ctx('f'), ctx('g'), add('H'), ctx('i'), ctx('j')],
  }],
}

describe('expandGaps', () => {
  it('empty set → original unchanged, identity gapMap', () => {
    const r = expandGaps(original, full, new Set())
    expect(r.file).toBe(original)
    expect(r.gapMap).toEqual([0, 1, 2])
  })

  it('gap 0 → prepends file-start context, hunk starts at line 1', () => {
    const r = expandGaps(original, full, new Set([0]))
    expect(r.file.hunks).toHaveLength(2)
    expect(r.file.hunks[0].newStart).toBe(1)
    expect(r.file.hunks[0].lines.map(l => l.content)).toEqual([' a', ' b', '+C'])
    expect(r.file.hunks[1]).toEqual(original.hunks[1])
    expect(r.gapMap).toEqual([0, 1, 2])  // still 2 hunks → same shape
  })

  it('gap 1 → merges hunk 0+1, gapMap skips merged index', () => {
    const r = expandGaps(original, full, new Set([1]))
    expect(r.file.hunks).toHaveLength(1)
    expect(r.file.hunks[0].newStart).toBe(3)
    expect(r.file.hunks[0].lines.map(l => l.content))
      .toEqual(['+C', ' d', ' e', ' f', ' g', '+H'])
    // 1 effective hunk → 2 effective gaps. Gap-before = orig 0, trailing = orig 2.
    expect(r.gapMap).toEqual([0, 2])
  })

  it('trailing gap → appends end-of-file context to last hunk', () => {
    const r = expandGaps(original, full, new Set([2]))
    expect(r.file.hunks).toHaveLength(2)
    expect(r.file.hunks[1].lines.map(l => l.content)).toEqual(['+H', ' i', ' j'])
    expect(r.gapMap).toEqual([0, 1, 2])
  })

  it('all gaps → single hunk equivalent to full', () => {
    const r = expandGaps(original, full, new Set([0, 1, 2]))
    expect(r.file.hunks).toHaveLength(1)
    expect(r.file.hunks[0].newStart).toBe(1)
    expect(r.file.hunks[0].lines).toHaveLength(10)
  })

  it('does not mutate inputs', () => {
    const origLen = original.hunks[0].lines.length
    expandGaps(original, full, new Set([0, 1, 2]))
    expect(original.hunks[0].lines).toHaveLength(origLen)
  })
})

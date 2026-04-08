import { describe, it, expect, vi } from 'vitest'
import { render, fireEvent } from '@testing-library/svelte'
import SearchResults from './SearchResults.svelte'
import type { SearchMatch } from './DiffPanel.svelte'

function m(over: Partial<SearchMatch> = {}): SearchMatch {
  return {
    filePath: 'src/foo.ts',
    hunkIdx: 0, lineIdx: 0,
    startCol: 0, endCol: 3,
    lineNum: 10, side: 'add',
    content: 'foo bar',
    ...over,
  }
}

describe('SearchResults', () => {
  it('renders summary, path, line chip, snippet highlight', () => {
    const matches = [
      m({ filePath: 'a/b/c.py', lineNum: 42, side: 'add', content: 'x = needle()', startCol: 4, endCol: 10 }),
      m({ filePath: 'd.go', lineNum: 7, side: 'remove', content: 'needle := 1', startCol: 0, endCol: 6 }),
      m({ filePath: 'd.go', lineNum: 9, side: 'context', content: '  // needle here', startCol: 5, endCol: 11 }),
    ]
    const { container } = render(SearchResults, { props: { matches, currentIdx: 0, fileCount: 2, onjump: vi.fn() } })

    expect(container.querySelector('.sr-summary')?.textContent).toContain('3 matches in 2 files')

    const rows = container.querySelectorAll('.sr-row')
    expect(rows.length).toBe(3)

    // row 0: dir/base split, +42 green chip
    expect(rows[0].querySelector('.sr-dir')?.textContent).toBe('a/b/')
    expect(rows[0].querySelector('.sr-base')?.textContent).toBe('c.py')
    const chip0 = rows[0].querySelector('.sr-line')!
    expect(chip0.textContent).toBe('+42')
    expect(chip0.classList.contains('sr-line-add')).toBe(true)
    expect(rows[0].querySelector('.sr-hit')?.textContent).toBe('needle')

    // row 1: -7 red chip
    expect(rows[1].querySelector('.sr-line')?.textContent).toBe('-7')
    expect(rows[1].querySelector('.sr-line')?.classList.contains('sr-line-remove')).toBe(true)

    // row 2: context → bare number
    expect(rows[2].querySelector('.sr-line')?.textContent).toBe('9')

    // currentIdx=0 → first row marked current
    expect(rows[0].classList.contains('sr-current')).toBe(true)
    expect(rows[1].classList.contains('sr-current')).toBe(false)
  })

  it('click row → onjump(idx)', async () => {
    const onjump = vi.fn()
    const matches = [m(), m({ lineNum: 20 }), m({ lineNum: 30 })]
    const { container } = render(SearchResults, { props: { matches, currentIdx: 0, fileCount: 1, onjump } })

    const rows = container.querySelectorAll('.sr-row')
    await fireEvent.click(rows[2])
    expect(onjump).toHaveBeenCalledWith(2)
  })

  it('long line → snippet windowed with ellipsis', () => {
    const long = 'x'.repeat(50) + 'NEEDLE' + 'y'.repeat(100)
    const matches = [m({ content: long, startCol: 50, endCol: 56 })]
    const { container } = render(SearchResults, { props: { matches, currentIdx: 0, fileCount: 1, onjump: vi.fn() } })

    const ells = container.querySelectorAll('.sr-ell')
    expect(ells.length).toBe(2) // both lead and trail
    expect(container.querySelector('.sr-hit')?.textContent).toBe('NEEDLE')
  })

  it('caps rendering at 200', () => {
    const matches = Array.from({ length: 250 }, (_, i) => m({ lineNum: i }))
    const { container } = render(SearchResults, { props: { matches, currentIdx: 0, fileCount: 1, onjump: vi.fn() } })

    expect(container.querySelectorAll('.sr-row').length).toBe(200)
    expect(container.querySelector('.sr-summary')?.textContent).toContain('showing first 200')
  })
})

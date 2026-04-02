import { describe, expect, it, vi } from 'vitest'
import { fireEvent, render } from '@testing-library/svelte'
import ConflictQueue from './ConflictQueue.svelte'
import type { ConflictEntry } from './api'

const entries: ConflictEntry[] = [
  {
    commit_id: 'abc12345', change_id: 'wlykovwr', description: 'rebase stack',
    files: [{ path: 'src/a.go', sides: 2 }, { path: 'src/b.go', sides: 3 }],
  },
  {
    commit_id: 'def67890', change_id: 'xyzmnopq', description: 'fix',
    files: [{ path: 'README.md', sides: 2 }],
  },
]

const props = (over: Partial<{ resolved: Set<string>; onselect: (it: unknown) => void }> = {}) => ({
  entries,
  resolved: new Set<string>(),
  onselect: vi.fn(),
  ...over,
})

describe('ConflictQueue', () => {
  it('flattens entries earliest-first (reverse jj log order = propagation roots first)', () => {
    const { container } = render(ConflictQueue, { props: props() })
    const paths = [...container.querySelectorAll('.cq-path')].map(e => e.textContent)
    // jj log emits heads-first; reversed → entries[1] (def67890) before entries[0].
    expect(paths).toEqual(['README.md', 'src/a.go', 'src/b.go'])
  })

  it('renders one group header per commit', () => {
    const { container } = render(ConflictQueue, { props: props() })
    expect(container.querySelectorAll('.cq-group')).toHaveLength(2)
    expect(container.querySelectorAll('.cq-change-id')[0].textContent).toBe('xyzmnopq')
  })

  it('auto-selects first item on mount (= earliest commit, the propagation root)', () => {
    const onselect = vi.fn()
    render(ConflictQueue, { props: props({ onselect }) })
    expect(onselect).toHaveBeenCalledWith(
      expect.objectContaining({ commitId: 'def67890', path: 'README.md' }),
    )
  })

  it('j/k navigate within bounds (no wrap — unlike MergePanel block nav)', () => {
    const onselect = vi.fn()
    const { component } = render(ConflictQueue, { props: props({ onselect }) })
    const kd = (key: string) => component.handleKeydown(new KeyboardEvent('keydown', { key }))

    // Auto-select fired once for idx=0.
    onselect.mockClear()
    kd('j'); kd('j'); kd('j')  // 0→1→2, then clamp at 2
    expect(onselect).toHaveBeenCalledTimes(2)
    expect(onselect).toHaveBeenLastCalledWith(expect.objectContaining({ path: 'src/b.go' }))

    onselect.mockClear()
    kd('k'); kd('k'); kd('k')  // 2→1→0, then clamp at 0
    expect(onselect).toHaveBeenCalledTimes(2)
  })

  it('N-way badge only for sides > 2', () => {
    const { container } = render(ConflictQueue, { props: props() })
    const badges = container.querySelectorAll('.cq-nway')
    expect(badges).toHaveLength(1)
    expect(badges[0].textContent).toBe('3-way')
  })

  it('resolved dots track the resolved set', () => {
    const { container } = render(ConflictQueue, {
      props: props({ resolved: new Set(['abc12345:src/a.go']) }),
    })
    const dots = [...container.querySelectorAll('.cq-dot')].map(d => d.textContent)
    expect(dots).toEqual(['○', '●', '○']) // src/a.go is now flat[1]
    expect(container.querySelector('.cq-footer')?.textContent).toContain('1/3')
  })

  it('marks later occurrences of same path as propagated (earliest = root)', () => {
    // a.go conflicts in BOTH commits. After reverse, def67890 (earliest) is
    // first → its a.go is the root; abc12345's a.go should be dimmed + ↑ hint.
    const ents: ConflictEntry[] = [
      { commit_id: 'abc12345', change_id: 'wlykovwr', description: 'tip',
        files: [{ path: 'a.go', sides: 2 }] },
      { commit_id: 'def67890', change_id: 'xyzmnopq', description: 'root',
        files: [{ path: 'a.go', sides: 2 }, { path: 'b.go', sides: 2 }] },
    ]
    const { container } = render(ConflictQueue, {
      props: { entries: ents, resolved: new Set<string>(), onselect: vi.fn() },
    })
    const paths = [...container.querySelectorAll('.cq-path')]
    expect(paths.map(e => e.textContent)).toEqual(['a.go', 'b.go', 'a.go'])
    expect(paths[0].classList.contains('cq-propagated')).toBe(false) // root
    expect(paths[1].classList.contains('cq-propagated')).toBe(false) // unique
    expect(paths[2].classList.contains('cq-propagated')).toBe(true)  // downstream
    expect(container.querySelector('.cq-footer-hint')?.textContent).toContain('1 propagated')
  })

  it('3+ occurrences: all later ones point at the SAME (earliest) root', () => {
    const ents: ConflictEntry[] = [
      { commit_id: 'c2', change_id: 'tip', description: '', files: [{ path: 'x', sides: 2 }] },
      { commit_id: 'c1', change_id: 'mid', description: '', files: [{ path: 'x', sides: 2 }] },
      { commit_id: 'c0', change_id: 'root', description: '', files: [{ path: 'x', sides: 2 }] },
    ]
    const { container } = render(ConflictQueue, {
      props: { entries: ents, resolved: new Set<string>(), onselect: vi.fn() },
    })
    const hints = [...container.querySelectorAll('.cq-hint')]
    expect(hints).toHaveLength(2) // mid + tip propagated, root not
    expect(hints.every(h => h.getAttribute('title')?.includes('root'))).toBe(true)
  })

  it('empty entries → "No conflicts" message, no footer', () => {
    const { container } = render(ConflictQueue, {
      props: { entries: [], resolved: new Set<string>(), onselect: vi.fn() },
    })
    expect(container.querySelector('.cq-empty')).toBeTruthy()
    expect(container.querySelector('.cq-footer')).toBeNull()
  })
})

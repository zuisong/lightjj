import { describe, it, expect, vi, beforeEach } from 'vitest'

// Mock the heavy deps — beautiful-mermaid pulls elkjs (~300KB), and we're
// testing our integration glue not their renderers.
vi.mock('beautiful-mermaid', () => ({
  renderMermaidSVG: vi.fn((src: string) => {
    if (src.includes('INVALID')) throw new Error('parse fail')
    return `<svg data-src="${src.slice(0, 20)}"></svg>`
  }),
}))
vi.mock('@panzoom/panzoom', () => ({
  default: vi.fn(() => ({ zoomWithWheel: vi.fn(), reset: vi.fn() })),
}))

import { renderMarkdown, ensureMermaidLoaded, wirePanzoom } from './markdown-render'

describe('renderMarkdown', () => {
  it('renders GFM basics', () => {
    const html = renderMarkdown('# Hi\n\n- [x] done\n- [ ] todo\n\n| a | b |\n|---|---|\n| 1 | 2 |')
    expect(html).toContain('<h1')
    expect(html).toContain('<table')
    expect(html).toContain('checked')
  })

  it('sanitizes script tags', () => {
    const html = renderMarkdown('hello <script>alert(1)</script> world')
    expect(html).not.toContain('<script')
    expect(html).toContain('hello')
  })

  it('sanitizes on* handlers', () => {
    const html = renderMarkdown('<img src=x onerror="alert(1)">')
    expect(html).not.toContain('onerror')
  })

  it.each([
    ['<style>', 'text <style>.edit-file-btn{display:none}</style> more', 'display:none'],
    ['<link>', '<link rel="stylesheet" href="https://evil.example/x.css"> text', 'evil.example'],
    ['<form>', '<form action="https://evil.example"><button>go</button></form>', 'action='],
  ])('strips %s (CSS/nav injection vector)', (_tag, src, forbidden) => {
    const html = renderMarkdown(src)
    expect(html).not.toContain(forbidden)
  })

  // Inline style attr NOT stripped — mermaid SVG may use it. The
  // position:fixed overlay attack is neutralized by `contain: layout` on
  // the .md-preview container (CSS, not sanitizer-level).

  describe('mermaid blocks', () => {
    beforeEach(() => ensureMermaidLoaded())

    it('renders mermaid fence as SVG after load', () => {
      const html = renderMarkdown('```mermaid\ngraph TD; A-->B\n```')
      expect(html).toContain('mermaid-block')
      expect(html).toContain('<svg')
    })

    it('falls back to <pre> on parse error', () => {
      const html = renderMarkdown('```mermaid\nINVALID SYNTAX\n```')
      expect(html).toContain('mermaid-fallback')
      expect(html).not.toContain('<svg')
    })

    it('falls back to <pre> when over line limit', () => {
      const big = 'graph TD\n' + Array.from({ length: 201 }, (_, i) => `A${i}-->B${i}`).join('\n')
      const html = renderMarkdown('```mermaid\n' + big + '\n```')
      expect(html).toContain('mermaid-fallback')
    })

    it('preserves SVG through DOMPurify', () => {
      const html = renderMarkdown('```mermaid\ngraph TD; A-->B\n```')
      // USE_PROFILES.svg keeps <svg>; without it DOMPurify strips to empty div
      expect(html).toMatch(/<svg[^>]*>/)
    })

    it('non-mermaid fences use default code block', () => {
      const html = renderMarkdown('```js\nconst x = 1\n```')
      expect(html).toContain('<pre><code')
      expect(html).not.toContain('mermaid')
    })
  })
})

describe('wirePanzoom', () => {
  it('no-ops on container without mermaid blocks', () => {
    const div = document.createElement('div')
    div.innerHTML = '<p>no diagrams</p>'
    expect(() => wirePanzoom(div)).not.toThrow()
  })

  it('wires each .mermaid-block > svg', async () => {
    await ensureMermaidLoaded()
    const div = document.createElement('div')
    div.innerHTML = '<div class="mermaid-block"><svg></svg></div><div class="mermaid-block"><svg></svg></div>'
    wirePanzoom(div)
    const pz = (await import('@panzoom/panzoom')).default
    expect(pz).toHaveBeenCalledTimes(2)
  })
})

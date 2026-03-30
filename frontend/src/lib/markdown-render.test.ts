import { describe, it, expect, vi, beforeEach } from 'vitest'

// Mock the heavy deps — beautiful-mermaid pulls elkjs (~300KB), and we're
// testing our integration glue not their renderers.
vi.mock('beautiful-mermaid', () => ({
  renderMermaidSVG: vi.fn((src: string) => {
    if (src.includes('INVALID')) throw new Error('parse fail')
    // Mirror the real parser's first-line-must-be-header constraint so the
    // %%{init} strip test has teeth.
    if (!/^(graph|flowchart|stateDiagram|sequenceDiagram|classDiagram|erDiagram)/.test(src.trimStart())) {
      throw new Error('Invalid mermaid header')
    }
    return `<svg data-src="${src.slice(0, 20)}"></svg>`
  }),
}))
import { renderMarkdown, renderMarkdownAnnotated, ensureMermaidLoaded, wirePanzoom, wireAnnotations } from './markdown-render'
import type { Annotation } from './api'

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

    it('strips %%{init} directive so diagram-type header reaches line 1', () => {
      const src = '```mermaid\n'
        + '%%{init: {"theme": "base", "themeVariables": {\n'
        + '  "primaryColor":"#F2F0E5"\n'
        + '}}}%%\n'
        + 'flowchart TD\n'
        + '  A --> B\n'
        + '```'
      const html = renderMarkdown(src)
      expect(html).toContain('<svg')
      expect(html).not.toContain('mermaid-fallback')
    })

    it('falls back to <pre> when over line limit', () => {
      const big = 'graph TD\n' + Array.from({ length: 201 }, (_, i) => `A${i}-->B${i}`).join('\n')
      const html = renderMarkdown('```mermaid\n' + big + '\n```')
      expect(html).toContain('mermaid-fallback')
    })

    it('SVG bypasses sanitize via placeholder (preserves internal <style>)', () => {
      const html = renderMarkdown('```mermaid\ngraph TD; A-->B\n```')
      expect(html).toContain('<svg')
      expect(html).toContain('mermaid-block')
      // The mock returns <svg data-src=...> — verify placeholder-replace worked
      expect(html).not.toContain('data-mermaid=')
    })

    it('markdown <style> still stripped even though mermaid bypasses sanitize', () => {
      const html = renderMarkdown('<style>body{display:none}</style>\n```mermaid\ngraph TD; A\n```')
      expect(html).not.toContain('<style>body')
      expect(html).toContain('<svg')  // mermaid survived, user <style> didn't
    })

    it('non-mermaid fences use default code block', () => {
      const html = renderMarkdown('```js\nconst x = 1\n```')
      expect(html).toContain('<pre><code')
      expect(html).not.toContain('mermaid')
    })
  })

  describe('image src rewriting', () => {
    const ctx = { revision: 'abc123', baseDir: 'docs' }

    it('rewrites relative src through /api/file-raw', () => {
      const html = renderMarkdown('![logo](img/logo.png)', ctx)
      expect(html).toContain('/api/file-raw?')
      expect(html).toContain('path=docs%2Fimg%2Flogo.png')
    })

    it('leaves http(s) and data:image/ unchanged', () => {
      for (const src of ['https://example.com/x.png', 'data:image/png;base64,AAA']) {
        const html = renderMarkdown(`![x](${src})`, ctx)
        expect(html).not.toContain('/api/file-raw')
      }
    })

    it('escapes quotes in alt — attribute breakout defense', () => {
      const html = renderMarkdown('![x" onerror="alert(1)](foo.png)', ctx)
      // Breakout = unescaped " closes alt then opens new attr. Escaped quote
      // means `onerror=...` stays as literal TEXT inside alt="...".
      expect(html).not.toMatch(/"\s*onerror\s*=/)
      expect(html).toContain('&quot;')
    })

    it('caps at MAX_PROXIED_IMAGES', () => {
      const md = Array.from({ length: 60 }, (_, i) => `![${i}](img${i}.png)`).join('\n')
      const html = renderMarkdown(md, ctx)
      const matches = html.match(/\/api\/file-raw/g) ?? []
      expect(matches.length).toBe(50)
    })

    it('no rewriting without ctx', () => {
      const html = renderMarkdown('![x](foo.png)')
      expect(html).not.toContain('/api/file-raw')
      expect(html).toContain('src="foo.png"')
    })

    it('root-relative paths skip baseDir', () => {
      const html = renderMarkdown('![x](/images/logo.png)', ctx)
      expect(html).toContain('path=images%2Flogo.png')
      expect(html).not.toContain('docs')  // baseDir not prepended
    })

    it('strips fragment and query from path', () => {
      const html = renderMarkdown('![x](flow.svg#layer1) ![y](logo.png?v=2)', ctx)
      expect(html).toContain('path=docs%2Fflow.svg')
      expect(html).toContain('path=docs%2Flogo.png')
      expect(html).not.toContain('%23')  // no encoded #
      expect(html).not.toContain('v%3D2')  // no encoded ?v=2
    })

    it('decodes percent-encoded paths (avoids double-encoding)', () => {
      const html = renderMarkdown('![x](my%20image.png)', ctx)
      // %20 decoded → space → URLSearchParams encodes as + → server gets space
      expect(html).toContain('path=docs%2Fmy+image.png')
      expect(html).not.toContain('%2520')  // NOT double-encoded
    })
  })
})

describe('renderMarkdownAnnotated', () => {
  // Multi-block fixture — heading, paragraph spanning 2 lines, nested list,
  // code fence, blockquote. Line numbers are the contract with reanchor().
  const DOC = [
    /* 1 */ '# Title',
    /* 2 */ '',
    /* 3 */ 'First para',
    /* 4 */ 'continues here.',
    /* 5 */ '',
    /* 6 */ '- apple',
    /* 7 */ '- apple',   // duplicate — tests monotone-cursor disambiguation
    /* 8 */ '',
    /* 9 */ '```js',
    /* 10 */ 'const x = 1',
    /* 11 */ '```',
    /* 12 */ '',
    /* 13 */ '> quoted',
  ].join('\n')

  const srcLines = (html: string) => {
    const doc = new DOMParser().parseFromString(html, 'text/html')
    return [...doc.querySelectorAll('[data-src-line]')].map(el => ({
      tag: el.tagName.toLowerCase(),
      line: +el.getAttribute('data-src-line')!,
    }))
  }

  it('stamps block elements with 1-indexed source lines', () => {
    const stamped = srcLines(renderMarkdownAnnotated(DOC))
    expect(stamped).toContainEqual({ tag: 'h1', line: 1 })
    expect(stamped).toContainEqual({ tag: 'p', line: 3 })
    expect(stamped).toContainEqual({ tag: 'pre', line: 9 })
    expect(stamped).toContainEqual({ tag: 'blockquote', line: 13 })
  })

  it('duplicate source slices resolve to distinct lines (monotone cursor)', () => {
    const lis = srcLines(renderMarkdownAnnotated(DOC)).filter(s => s.tag === 'li')
    expect(lis.map(l => l.line)).toEqual([6, 7])
  })

  it('plain renderMarkdown leaves zero stamps (no-cost fallthrough)', () => {
    expect(srcLines(renderMarkdown(DOC))).toEqual([])
  })

  it('DOMPurify preserves data-src-line', () => {
    // data-* is in the default allowlist; this test locks that assumption.
    const html = renderMarkdownAnnotated('# hi')
    expect(html).toContain('data-src-line="1"')
  })

  it('mermaid block carries data-src-line to .mermaid-block (no double-wrap)', async () => {
    await ensureMermaidLoaded()
    const html = renderMarkdownAnnotated('# Title\n\n```mermaid\ngraph TD; A-->B\n```')
    // Stamped on the mermaid-block div itself — no extra wrapper.
    expect(html).toMatch(/<div class="mermaid-block" data-src-line="3">/)
    expect(html).not.toMatch(/<div data-src-line="\d+"><div class="mermaid-block">/)
  })

  it('tables get data-src-line (per-table — TableCell has no raw)', () => {
    const html = renderMarkdownAnnotated('# Title\n\n| a | b |\n|---|---|\n| 1 | 2 |')
    expect(html).toMatch(/<table data-src-line="3">/)
    // Default renderer's align/header structure preserved
    expect(html).toContain('<thead>')
    expect(html).toContain('<tbody>')
  })

  it('task-list items keep checkbox', () => {
    const html = renderMarkdownAnnotated('- [x] done\n- [ ] todo')
    expect(html).toContain('checked')
    expect(html).toMatch(/<li data-src-line="1">.*checkbox/)
    expect(html).toMatch(/<li data-src-line="2">.*checkbox/)
  })
})

describe('wireAnnotations', () => {
  const mkAnn = (lineNum: number, comment = 'note'): Annotation => ({
    id: 'a', changeId: 'c', filePath: 'doc.md',
    lineNum, lineContent: `line ${lineNum}`, comment,
    severity: 'suggestion', createdAt: 0, createdAtCommitId: 'x', status: 'open',
  })

  const render = (src: string) => {
    const div = document.createElement('div')
    div.innerHTML = renderMarkdownAnnotated(src)
    return div
  }

  it('injects badge on block covering annotation line', () => {
    // heading@1, para@3 → ann at line 4 falls in para's [3, ∞) range
    const div = render('# Title\n\nPara text\ncontinues')
    const ann = mkAnn(4)
    wireAnnotations(div, ['# Title', '', 'Para text', 'continues'], n => n === 4 ? [ann] : [], undefined)

    expect(div.querySelector('h1 .annotation-badge')).toBeNull()
    const badge = div.querySelector('p .annotation-badge') as HTMLElement
    expect(badge).toBeTruthy()
    expect(badge.title).toBe('1 annotation: note')
  })

  it('nested block claims sub-range (li > inner p does not double-badge)', () => {
    // Loose list: li@1 contains p@1. Both claim line 1 initially, but
    // sorted-next-line gives li range [1,1) = empty, p range [1,end).
    // Only the innermost p gets the badge.
    const div = render('- item one\n\n- item two')
    wireAnnotations(div, ['- item one', '', '- item two'], n => n === 1 ? [mkAnn(1)] : [], undefined)
    const badges = div.querySelectorAll('.annotation-badge')
    expect(badges.length).toBe(1)
  })

  it('Alt+click emits innermost block start line + source content', () => {
    const div = render('# Title\n\nPara')
    const srcLines = ['# Title', '', 'Para']
    const calls: [number, string][] = []
    wireAnnotations(div, srcLines, () => [], (n, c) => { calls.push([n, c]) })

    const p = div.querySelector('p')!
    p.dispatchEvent(new MouseEvent('click', { altKey: true, bubbles: true }))
    expect(calls).toEqual([[3, 'Para']])
  })

  it('non-Alt click is ignored', () => {
    const div = render('# Title')
    let fired = false
    wireAnnotations(div, ['# Title'], () => [], () => { fired = true })
    div.querySelector('h1')!.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    expect(fired).toBe(false)
  })

  it('cleanup removes badges + listener', () => {
    const div = render('# Title')
    const ann = mkAnn(1)
    const cleanup = wireAnnotations(div, ['# Title'], () => [ann], () => {})
    expect(div.querySelector('.annotation-badge')).toBeTruthy()
    expect(div.querySelector('.md-ann-host')).toBeTruthy()
    cleanup()
    expect(div.querySelector('.annotation-badge')).toBeNull()
    expect(div.querySelector('.md-ann-host')).toBeNull()
  })
})

describe('wirePanzoom', () => {
  const mkContainer = (n = 1) => {
    const div = document.createElement('div')
    div.innerHTML = '<div class="mermaid-block"><svg></svg></div>'.repeat(n)
    // jsdom lacks setPointerCapture; stub on the canvas elements
    for (const block of div.querySelectorAll('.mermaid-block')) {
      ;(block as any).setPointerCapture = vi.fn()
      ;(block as any).releasePointerCapture = vi.fn()
    }
    return div
  }

  it('no-ops on container without mermaid blocks', () => {
    const div = document.createElement('div')
    div.innerHTML = '<p>no diagrams</p>'
    const cleanup = wirePanzoom(div)
    expect(() => cleanup()).not.toThrow()
  })

  it('drag translates the svg', () => {
    const div = mkContainer()
    wirePanzoom(div)
    const block = div.querySelector('.mermaid-block')!
    const svg = div.querySelector('svg')!
    block.dispatchEvent(new PointerEvent('pointerdown', { button: 0, clientX: 10, clientY: 10, pointerId: 1 }))
    block.dispatchEvent(new PointerEvent('pointermove', { clientX: 30, clientY: 25, pointerId: 1 }))
    expect(svg.style.transform).toBe('translate(20px,15px) scale(1)')
    block.dispatchEvent(new PointerEvent('pointerup', { pointerId: 1 }))
    block.dispatchEvent(new PointerEvent('pointermove', { clientX: 100, clientY: 100, pointerId: 1 }))
    expect(svg.style.transform).toBe('translate(20px,15px) scale(1)')  // released → ignored
  })

  it('dblclick resets transform', () => {
    const div = mkContainer()
    wirePanzoom(div)
    const block = div.querySelector('.mermaid-block')!
    const svg = div.querySelector('svg')!
    block.dispatchEvent(new PointerEvent('pointerdown', { button: 0, clientX: 0, clientY: 0, pointerId: 1 }))
    block.dispatchEvent(new PointerEvent('pointermove', { clientX: 50, clientY: 50, pointerId: 1 }))
    block.dispatchEvent(new MouseEvent('dblclick'))
    expect(svg.style.transform).toBe('translate(0px,0px) scale(1)')
  })

  it('cleanup removes listeners', () => {
    const div = mkContainer()
    const cleanup = wirePanzoom(div)
    const block = div.querySelector('.mermaid-block')!
    const svg = div.querySelector('svg')!
    cleanup()
    block.dispatchEvent(new PointerEvent('pointerdown', { button: 0, clientX: 0, clientY: 0, pointerId: 1 }))
    block.dispatchEvent(new PointerEvent('pointermove', { clientX: 50, clientY: 50, pointerId: 1 }))
    expect(svg.style.transform).toBe('')  // untouched after cleanup
  })
})

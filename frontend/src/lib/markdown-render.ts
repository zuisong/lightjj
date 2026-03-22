import { marked, type Tokens } from 'marked'
import DOMPurify from 'dompurify'
import { escapeHtml } from './highlighter'

// beautiful-mermaid + panzoom lazy-loaded together — ~300KB chunk (mostly
// elkjs), only fetched on first preview. Subsequent previews hit module cache.
// Promise-memoized so concurrent callers share one import.
type Renderer = typeof import('beautiful-mermaid').renderMermaidSVG
type Panzoom = typeof import('@panzoom/panzoom').default
let loadP: Promise<void> | null = null
let renderer: Renderer | null = null
let panzoom: Panzoom | null = null

export const ensureMermaidLoaded = () =>
  loadP ??= Promise.all([
    import('beautiful-mermaid').then(m => renderer = m.renderMermaidSVG),
    import('@panzoom/panzoom').then(m => panzoom = m.default),
  ]).then(() => {}, () => { loadP = null })  // clear memo on reject → next preview retries

// Sync render blocks the main thread via elkjs FakeWorker. README-scale
// diagrams (<200 lines) are sub-frame; huge architecture diagrams fall through
// to raw <pre>. Same mitigation shape as word-diff's 500k-cell LCS bail.
const DIAGRAM_LINE_LIMIT = 200

// Direct CSS-var references — SVG contains `fill="var(--base)"` which resolves
// against whichever :root theme is active. Theme toggle is a pure CSS cascade,
// zero re-render. Same principle as tok-* syntax highlighting.
const THEME = {
  bg: 'var(--base)',
  fg: 'var(--text)',
  accent: 'var(--blue)',
  transparent: true,
} as const

function tryRenderDiagram(src: string): string | null {
  if (!renderer || src.split('\n').length > DIAGRAM_LINE_LIMIT) return null
  try {
    return renderer(src, THEME)
  } catch {
    return null
  }
}

marked.use({
  gfm: true,
  renderer: {
    code({ text, lang }: Tokens.Code) {
      if (lang !== 'mermaid') return false
      const svg = tryRenderDiagram(text)
      if (svg) return `<div class="mermaid-block">${svg}</div>`
      // Not-yet-loaded, unsupported type, parse error, or over-limit — raw
      // code block. If loading was the reason, the caller re-derives once
      // mermaidReady flips and this path re-tries.
      return `<pre class="mermaid-fallback"><code>${escapeHtml(text)}</code></pre>`
    },
  },
})

// DOMPurify strips <svg> by default. beautiful-mermaid output is trusted
// (library-generated, no user input reaches SVG attrs); allow the tags it
// emits so the diagram survives sanitize. USE_PROFILES keeps html+svg,
// still strips <script>/on* handlers. FORBID_TAGS: <style>/<link> in
// reviewed markdown create GLOBAL stylesheets (UI-breaker). Inline style
// attr is NOT forbidden — mermaid SVG may use it; the position:fixed
// overlay attack is neutralized by `contain: layout` on .md-preview
// (creates a containing block for fixed-position descendants).
const SANITIZE_CFG = {
  USE_PROFILES: { html: true, svg: true, svgFilters: true },
  FORBID_TAGS: ['style', 'link', 'form'],
}

export function renderMarkdown(src: string): string {
  return DOMPurify.sanitize(marked.parse(src) as string, SANITIZE_CFG)
}

// Called post-mount from MarkdownPreview's $effect. Wires wheel-zoom +
// drag-pan + dblclick-reset on each rendered SVG. No-op if not loaded yet
// (first-render raw-fallback path).
export function wirePanzoom(container: HTMLElement): void {
  if (!panzoom) return
  for (const svg of container.querySelectorAll<SVGSVGElement>('.mermaid-block > svg')) {
    const pz = panzoom(svg, { maxScale: 5, minScale: 0.3, canvas: true })
    svg.parentElement!.addEventListener('wheel', pz.zoomWithWheel, { passive: false })
    svg.addEventListener('dblclick', () => pz.reset())
  }
}

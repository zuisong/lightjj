// beautiful-mermaid lazy-load + render helpers. Extracted from
// markdown-render.ts so doc-mode (pm-mermaid.ts) can import the renderer
// without pulling marked + DOMPurify + footnote machinery into its chunk —
// same motivation as panzoom.ts.

import { wireSvg } from './panzoom'

// ~300KB chunk (mostly elkjs), only fetched on first preview. Subsequent
// previews hit module cache. Promise-memoized so concurrent callers share
// one import.
type Renderer = typeof import('beautiful-mermaid').renderMermaidSVG
let loadP: Promise<void> | null = null
let renderer: Renderer | null = null

export const ensureMermaidLoaded = () =>
  loadP ??= import('beautiful-mermaid')
    .then(m => { renderer = m.renderMermaidSVG })
    .catch(() => { loadP = null })  // clear memo on reject → next preview retries

// Sync render blocks the main thread via elkjs FakeWorker. README-scale
// diagrams (<200 lines) are sub-frame; huge architecture diagrams fall through
// to raw <pre>.
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

// Strip mermaid %%{...}%% directive blocks (typically %%{init: {...}}%% for
// theme overrides). beautiful-mermaid's parser expects the diagram-type
// header on line 1; a multi-line init block pushes it down → "Invalid
// mermaid header" throw → silent fallback to <pre>. The directive is for
// mermaid.js's native theming which THEME below already replaces, so
// dropping it is semantically correct.
const DIRECTIVE_RE = /%%\{[\s\S]*?\}%%\s*\n?/g

export function tryRenderDiagram(src: string): string | null {
  if (!renderer) return null
  const stripped = src.replace(DIRECTIVE_RE, '')
  if (stripped.split('\n').length > DIAGRAM_LINE_LIMIT) return null
  try {
    return renderer(stripped, THEME)
  } catch {
    return null
  }
}

// Called post-mount from MarkdownPreview's $effect / pm-mermaid's render().
// Wires wheel-zoom + drag-pan + dblclick-reset on each rendered SVG. Returns
// cleanup — setPointerCapture keeps move/up on the canvas itself (not
// document), so {@html} subtree replacement would orphan them without
// explicit removal.
export function wirePanzoom(container: HTMLElement): () => void {
  const cleanups: Array<() => void> = []
  for (const svg of container.querySelectorAll<SVGSVGElement>('.mermaid-block > svg')) {
    cleanups.push(wireSvg(svg, svg.parentElement!))
  }
  return () => cleanups.forEach(fn => fn())
}

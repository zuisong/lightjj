<script lang="ts">
  import { renderMarkdown, renderMarkdownAnnotated, ensureMermaidLoaded, wirePanzoom, wireAnnotations, type PreviewContext } from './markdown-render'
  import type { Annotation } from './api'

  interface Props {
    content: string
    ctx?: PreviewContext
    // Same signatures as DiffFileView — DiffPanel threads them through
    // unchanged. forLine reads the annotation store's $derived byLine Map,
    // so the wireAnnotations $effect re-runs when annotations.list changes.
    annotationsForLine?: (lineNum: number) => readonly Annotation[]
    onannotationclick?: (lineNum: number, lineContent: string, e: MouseEvent) => void
  }

  let { content, ctx, annotationsForLine, onannotationclick }: Props = $props()
  let container: HTMLElement | undefined = $state()

  // Mermaid chunk lazy-loads on first preview. `mermaidReady` is a dep of
  // `html` so the preview re-derives once the renderer lands — first paint
  // shows raw ```mermaid blocks, ~100ms later they become SVGs. Subsequent
  // previews start with mermaidReady=true (module-level cache).
  let mermaidReady = $state(false)
  $effect(() => { ensureMermaidLoaded().then(() => mermaidReady = true) })

  let html = $derived((void mermaidReady, annotationsForLine
    ? renderMarkdownAnnotated(content, ctx)
    : renderMarkdown(content, ctx)))

  let sourceLines = $derived(annotationsForLine ? content.split('\n') : [])

  // Re-wire pan/zoom after every html change. Returned cleanup removes
  // the prior batch's listeners — they survive {@html} subtree replacement.
  $effect(() => {
    void html
    if (!container) return
    return wirePanzoom(container)
  })

  // ToC: query headings post-{@html}. Depth from tag (h1→1..h6→6) for indent.
  // Click scrolls the heading element directly — no IDs needed.
  // DECLARED BEFORE wireAnnotations — effects fire in source order within a
  // batch; wireAnnotations appends badge buttons to headings, which would
  // pollute textContent ("Section Title💬") if ToC queried after.
  interface TocEntry { el: HTMLElement; depth: number; text: string }
  let toc = $state<TocEntry[]>([])
  let activeHeading = $state<HTMLElement | null>(null)
  $effect(() => {
    void html
    // Reset first: on html re-derive, old elements are detached. Stale
    // activeHeading would never match new h.el until the observer fires.
    activeHeading = null
    if (!container) { toc = []; return }
    const headings = [...container.querySelectorAll<HTMLElement>('h1,h2,h3,h4,h5,h6')]
    toc = headings.map(el => ({
      el, depth: +el.tagName[1], text: el.textContent ?? '',
    }))
    if (headings.length < 2) return
    // Scroll-spy: whichever heading is nearest the top-of-viewport band is
    // "current". rootMargin -70% bottom = only the top 30% counts. When
    // multiple headings intersect (short sections), the last one to enter
    // wins — matches reading-order intuition.
    const io = new IntersectionObserver(
      entries => {
        for (const e of entries) {
          if (e.isIntersecting) activeHeading = e.target as HTMLElement
        }
      },
      { rootMargin: '0px 0px -70% 0px' },
    )
    headings.forEach(h => io.observe(h))
    return () => io.disconnect()
  })

  $effect(() => {
    void html
    if (!container || !annotationsForLine) return
    return wireAnnotations(container, sourceLines, annotationsForLine, onannotationclick)
  })
</script>

<div class="md-preview" bind:this={container}>
  {#if annotationsForLine}
    <div class="md-hint"><kbd class="nav-hint">Alt</kbd>+click any block to annotate</div>
  {/if}
  {#if toc.length > 1}
    <nav class="md-toc" aria-label="Table of contents">
      {#each toc as h}
        <button
          class="md-toc-item"
          class:active={h.el === activeHeading}
          class:deep={h.depth >= 4}
          style:padding-left="{(h.depth - 1) * 10 + 8}px"
          onclick={() => h.el.scrollIntoView({ block: 'start', behavior: 'smooth' })}
          title={h.text}
        >{h.text}</button>
      {/each}
    </nav>
  {/if}
  {@html html}
</div>

<style>
  .md-preview {
    padding: 12px 24px;
    font-family: system-ui, -apple-system, sans-serif;
    font-size: 14px;
    line-height: 1.6;
    color: var(--text);
    /* 1100px ≈ 90ch at 14px — upper bound of readable prose. Code blocks
       and mermaid get the full width; margin:auto centers on wider panes. */
    max-width: 1100px;
    margin: 0 auto;
    /* Containing block for fixed-position descendants — neutralizes the
       <div style="position:fixed;..."> phishing-overlay vector without
       stripping inline style (which mermaid SVG may use). */
    contain: layout paint;
  }
  .md-preview :global(h1),
  .md-preview :global(h2),
  .md-preview :global(h3) {
    border-bottom: 1px solid var(--surface1);
    padding-bottom: 0.3em;
    margin-top: 1.2em;
  }
  .md-preview :global(code) {
    background: var(--surface0);
    padding: 0.15em 0.35em;
    border-radius: 3px;
    font-family: ui-monospace, monospace;
    font-size: 0.9em;
  }
  .md-preview :global(pre) {
    background: var(--surface0);
    padding: 12px;
    border-radius: 4px;
    overflow-x: auto;
  }
  .md-preview :global(pre code) {
    background: none;
    padding: 0;
  }
  .md-preview :global(blockquote) {
    border-left: 3px solid var(--overlay0);
    margin-left: 0;
    padding-left: 12px;
    color: var(--overlay0);
  }
  .md-preview :global(table) {
    border-collapse: collapse;
    margin: 1em 0;
  }
  .md-preview :global(th),
  .md-preview :global(td) {
    border: 1px solid var(--surface2);
    padding: 6px 12px;
  }
  .md-preview :global(th) {
    background: var(--surface0);
  }
  .md-preview :global(a) {
    color: var(--blue);
  }
  .md-preview :global(hr) {
    border: none;
    border-top: 1px solid var(--surface1);
    margin: 1.5em 0;
  }
  .md-preview :global(.mermaid-block) {
    border: 1px solid var(--surface1);
    border-radius: 4px;
    margin: 1em 0;
    overflow: hidden;
    cursor: grab;
  }
  .md-preview :global(.mermaid-block:active) {
    cursor: grabbing;
  }
  .md-preview :global(.mermaid-fallback) {
    border-left: 3px solid var(--overlay0);
  }

  /* ToC minimap. position:sticky works through contain:paint (unlike fixed,
     which it traps) — sticks at scroll-top while the preview is in view,
     scrolls away when the file scrolls off. float:right takes it out of flow
     so prose wraps around it. */
  .md-toc {
    position: sticky;
    top: 8px;
    float: right;
    width: 170px;
    max-height: 70vh;
    overflow-y: auto;
    margin: 0 -8px 12px 20px;
    padding: 4px 0;
    background: color-mix(in srgb, var(--mantle) 80%, transparent);
    border-radius: 6px;
    backdrop-filter: blur(6px);
    font-size: 11px;
    opacity: 0.75;
    transition: opacity 120ms ease;
    z-index: 1;
    scrollbar-width: thin;
  }
  .md-toc:hover { opacity: 1; }
  .md-toc-item {
    display: block;
    width: 100%;
    padding: 3px 8px 3px 6px;
    background: transparent;
    border: none;
    border-left: 2px solid transparent;
    text-align: left;
    color: var(--subtext0);
    font-family: inherit;
    font-size: inherit;
    line-height: 1.4;
    cursor: pointer;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
    transition: border-color 80ms ease, color 80ms ease;
  }
  .md-toc-item:hover {
    color: var(--text);
    background: var(--surface0);
  }
  .md-toc-item.active {
    color: var(--text);
    border-left-color: var(--amber);
    background: color-mix(in srgb, var(--amber) 8%, transparent);
  }
  .md-toc-item.deep {
    color: var(--overlay0);
    font-size: 10px;
  }

  .md-hint {
    display: inline-block;
    font-size: 10px;
    color: var(--overlay0);
    margin: -4px 0 12px;
    padding: 2px 8px;
    background: var(--surface0);
    border-radius: 10px;
    user-select: none;
  }

  /* Annotation badge host — shared semantic rules in theme.css. */
  .md-preview :global(.md-ann-host) { position: relative; }
  .md-preview :global(.annotation-badge) {
    top: 2px;
    right: 2px;
    font-size: 13px;
    padding: 2px 4px;
  }
  .md-preview :global(.annotation-badge sup) { font-size: 9px; vertical-align: super; }
</style>

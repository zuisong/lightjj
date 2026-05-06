<script lang="ts">
  import { onDestroy } from 'svelte'
  import { EditorState } from 'prosemirror-state'
  import { EditorView, Decoration, DecorationSet } from 'prosemirror-view'
  import { keymap } from 'prosemirror-keymap'
  import { history, undo, redo } from 'prosemirror-history'
  import { baseKeymap } from 'prosemirror-commands'
  import { splitListItem, liftListItem, sinkListItem } from 'prosemirror-schema-list'
  import { docSchema } from './pm-schema'
  import type { DocSession } from './doc-session.svelte'

  let {
    session,
    editable = false,
    onaddcomment,
    onsave,
  }: {
    session: DocSession
    editable?: boolean
    onaddcomment?: (from: number, to: number) => void
    onsave?: () => void
  } = $props()

  // Editing plugins only matter when editable; created once. baseKeymap covers
  // Enter/Backspace/Delete; the chained map adds undo/redo + list structure.
  // Cmd+S returns true synchronously so the browser's save dialog is suppressed
  // even though onsave is async.
  const editPlugins = [
    history(),
    keymap({
      'Mod-z': undo,
      'Mod-y': redo,
      'Mod-Shift-z': redo,
      'Mod-s': () => { onsave?.(); return true },
      'Enter': splitListItem(docSchema.nodes.list_item),
      'Tab': sinkListItem(docSchema.nodes.list_item),
      'Shift-Tab': liftListItem(docSchema.nodes.list_item),
    }),
    keymap(baseKeymap),
  ]

  let mount: HTMLDivElement
  let view: EditorView | undefined
  let affordance = $state<{ x: number; y: number; from: number; to: number } | null>(null)

  // Comment highlights. Pure f(session.comments, session.doc) — pushed to
  // the view via setProps rather than plugin state.
  const decoSet = $derived.by(() => {
    const d = session.doc
    if (!d) return DecorationSet.empty
    const decos = session.comments
      .filter((c) => !c.parentId && !c.orphaned && c.from !== undefined && c.to !== undefined && c.from < c.to)
      .map((c) =>
        Decoration.inline(c.from!, c.to!, {
          class: c.resolution ? 'doc-comment-hl resolved' : 'doc-comment-hl',
          'data-comment-id': c.id,
        }),
      )
    return DecorationSet.create(d, decos)
  })

  // Create view once (first non-null state), then sync via updateState. No
  // cleanup-return — destroy+recreate per transaction would thrash; onDestroy
  // handles unmount. {#key docFilePath} in the parent gives a fresh mount per
  // file, so view is always 1:1 with session.
  // session.doc is a Node, not an EditorState — DocView owns the state (plugins
  // + history are view-local). dispatchTransaction applies tr here AND notifies
  // the session for comment-mapping. session.doc only changes externally on
  // import/reload, so the else-if branch fires once per file, not per keystroke.
  let importedDoc: typeof session.doc = null
  $effect(() => {
    const d = session.doc
    if (!d || !mount) return
    if (!view) {
      importedDoc = d
      view = new EditorView(mount, {
        state: EditorState.create({ schema: docSchema, doc: d, plugins: editPlugins }),
        editable: () => editable,
        decorations: () => decoSet,
        dispatchTransaction: (tr) => {
          if (!view) return
          const ns = view.state.apply(tr)
          view.updateState(ns)
          session.onTransaction(tr, ns.doc)
        },
      })
    } else if (d !== importedDoc && d !== view.state.doc) {
      importedDoc = d
      view.updateState(EditorState.create({ schema: docSchema, doc: d, plugins: editPlugins }))
    }
  })

  $effect(() => {
    view?.setProps({ editable: () => editable })
  })

  $effect(() => {
    const ds = decoSet
    view?.setProps({ decorations: () => ds })
  })

  onDestroy(() => view?.destroy())

  // Exported for parent (DocCommentRail click → scroll). BookmarksPanel pattern.
  export function scrollTo(pmPos: number) {
    if (!view) return
    const dom = view.domAtPos(pmPos)
    const el = dom.node instanceof Element ? dom.node : dom.node.parentElement
    el?.scrollIntoView({ block: 'center', behavior: 'smooth' })
  }

  function handleMouseUp() {
    if (!view) return
    const sel = view.state.selection
    if (sel.empty) {
      affordance = null
      return
    }
    const coords = view.coordsAtPos(sel.to)
    const box = mount.getBoundingClientRect()
    // coords/box are both viewport-relative; the affordance is position:absolute
    // inside the scroll container, so add scroll offset to land in content space.
    affordance = {
      x: coords.right - box.left + mount.scrollLeft,
      y: coords.top - box.top + mount.scrollTop,
      from: sel.from,
      to: sel.to,
    }
  }

  function handleAddClick() {
    if (affordance && onaddcomment) onaddcomment(affordance.from, affordance.to)
    affordance = null
  }
</script>

<!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
<div class="doc-view" bind:this={mount} onmouseup={handleMouseUp} role="document">
  {#if affordance}
    <button
      class="btn-sm doc-add-comment"
      style:left="{affordance.x + 6}px"
      style:top="{affordance.y}px"
      onclick={handleAddClick}
      onmousedown={(e) => e.preventDefault()}
    >
      💬 Comment
    </button>
  {/if}
</div>

<style>
  .doc-view {
    position: relative;
    height: 100%;
    overflow-y: auto;
    padding: 24px 32px;
    font-family: var(--font-ui);
    font-size: var(--fs-md);
    line-height: 1.6;
    color: var(--text);
  }
  .doc-view :global(.ProseMirror) {
    outline: none;
    max-width: 760px;
    margin: 0 auto;
  }
  .doc-view :global(.ProseMirror h1) { font-size: var(--fs-xl); margin: 1.2em 0 0.4em; }
  .doc-view :global(.ProseMirror h2) { font-size: var(--fs-lg); margin: 1.2em 0 0.4em; }
  .doc-view :global(.ProseMirror h3) { font-size: var(--fs-md); margin: 1em 0 0.3em; font-weight: 600; }
  .doc-view :global(.ProseMirror p) { margin: 0.5em 0; }
  .doc-view :global(.ProseMirror code) {
    font-family: var(--font-mono);
    font-size: 0.92em;
    background: var(--surface0);
    padding: 1px 4px;
    border-radius: 3px;
  }
  .doc-view :global(.ProseMirror pre) {
    font-family: var(--font-mono);
    background: var(--surface0);
    padding: 10px 12px;
    border-radius: 4px;
    overflow-x: auto;
  }
  .doc-view :global(.ProseMirror pre code) { background: none; padding: 0; }
  .doc-view :global(.ProseMirror blockquote) {
    border-left: 3px solid var(--surface2);
    margin: 0.5em 0;
    padding: 0 0 0 12px;
    color: var(--subtext0);
  }
  .doc-view :global(.ProseMirror hr) { border: none; border-top: 1px solid var(--surface1); margin: 1.5em 0; }
  .doc-view :global(.ProseMirror ul),
  .doc-view :global(.ProseMirror ol) { padding-left: 24px; margin: 0.4em 0; }

  .doc-view :global(.doc-comment-hl) {
    background: var(--bg-warning);
    border-bottom: 1px solid var(--amber);
    cursor: pointer;
  }
  .doc-view :global(.doc-comment-hl.resolved) {
    background: var(--surface0);
    border-bottom: 1px dotted var(--subtext0);
  }

  .doc-add-comment {
    position: absolute;
    z-index: 5;
    white-space: nowrap;
  }
</style>

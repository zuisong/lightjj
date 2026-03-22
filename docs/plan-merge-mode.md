# Merge Mode & File History — Design Plan

**Status:** Proposed
**Inspired by:** Kaleidoscope (file history + commit context + intuitive merge UI)

## Problem Statement

The current 3-pane `MergePanel` is functionally solid — position surgery, undo inversion, LCS block alignment all work. But it's **per-file, buried inside DiffPanel**, invoked one file at a time with no awareness of the broader conflict set. Kaleidoscope's model treats merge as a first-class mode with three things we lack:

1. **Global conflict queue** — "10 Unresolved Conflicts" across all files, with prev/next navigation
2. **File history** — browse every revision that touched a file, diff any two
3. **Commit context in-pane** — author/message/date/commit-id on each merge column, so you know *who* wrote what you're about to discard

The current flow forces: open DiffPanel → spot a conflict badge → click "Resolve" → MergePanel for ONE file → save → back to DiffPanel → find the next one. For a rebase that conflicts 5 files across 3 commits, that's 15 modal round-trips.

## What we already have (don't rebuild)

| Piece | Location | Reusable as-is? |
|---|---|---|
| 3-pane CM6 editor + arrows | `MergePanel.svelte` | ✅ Core stays; props interface widens |
| Position surgery | `merge-surgery.ts` (pure, tested) | ✅ No changes |
| LCS block diff | `merge-diff.ts` | ✅ No changes |
| Conflict marker parser | `conflict-extract.ts` | ⚠️ Extend to capture commit refs, not just description labels |
| File-at-revision | `api.fileShow(rev, path)` | ✅ |
| Cross-revision diff | `api.diffRange(from, to, files?)` | ✅ Powers file history compare |
| Conflict file list | `FilesTemplate` → `conflict_sides` | ✅ Already per-commit via `/api/files` |
| jj file-scoped log | `jj log <path>` (not yet wrapped) | Needs `commands.go` builder |

## Phase 1 — MergePanel quick wins

**Goal:** Make the existing per-file editor feel like a polished tool before widening scope. Each item is self-contained.

### 1.1 Conflict navigation within a file

Kaleidoscope's bottom-right "Conflict 1 of 10 ⬆ ⬇".

- **Data:** Already in `blocks[]` — each `ChangeBlock` is one conflict. `pendingCount` already derived.
- **UI:** Bottom-right nav pill in toolbar. `n`/`p` keyboard (or `]`/`[` to match vim-diff). Scrolls center pane to block `i`, flashes the highlight.
- **Impl:** `scrollToBlock(i)` → `centerView.dispatch({ effects: EditorView.scrollIntoView(tracked[i].from, { y: 'center' }) })`. `currentBlockIdx` tracked via an `IntersectionObserver` on a sentinel decoration, or simpler: derived from `scrollTop` vs `tracked[i].from` line position.

### 1.2 Minimap gutter

Kaleidoscope's right-edge color strip showing where conflicts sit in the file.

- **Impl:** Absolute-positioned `<div class="merge-minimap">` right of theirs pane, height = pane height. Each block renders a colored chip at `y = (block.from / docLength) * paneHeight`, height = `(block.to - block.from) / docLength * paneHeight` (min 3px). Color = `source` (amber=theirs/unresolved, green=ours, subtext=mixed). Click-to-scroll.
- **Cheap:** No new deps. ~40 lines.

### 1.3 Rich commit metadata in column headers

Current headers show only `sides.oursLabel` (the quoted commit description from conflict markers). Kaleidoscope shows author + commit-id + date + message.

- **Problem:** `reconstructSides()` extracts `extractSideLabel()` → just the quoted description. The full marker line looks like `wlykovwr 562576c8 "commit message"` — the change-id and commit-id are RIGHT THERE, we're throwing them away.
- **Fix:** `conflict-extract.ts`: return `MergeSideMeta = { label, changeId?, commitId? }` instead of bare string. Parse with `/^(\w+)\s+(\w+)\s+"(.+)"/`.
- **Enrichment:** `startMerge()` in DiffPanel fires `api.revision(commitId)` for each side (cached, so free on revisit) → `MergePanel` receives `{sides, oursCommit?, theirsCommit?}` → header shows `change_id · author · timestamp.ago() · message`.
- **Fallback:** Marker format varies (`side #1` vs commit-ref). If regex misses, keep current behavior.

### 1.4 "Take all ours" / "Take all theirs" bulk actions

- Toolbar buttons: `→→ All ours` / `All theirs ←←`.
- Loop `takeBlock(i, side)` over all `blocks`. Already idempotent, so safe.
- Add a single `history` transaction annotation so one Cmd+Z undoes the batch (wrap in `centerView.dispatch({ annotations: Transaction.addToHistory.of(true) })` per-block OR build one composite changeset — the latter is cleaner but needs `planTake` to return the full plan list first, then dispatch once).

### 1.5 Keyboard-first block navigation

Current: mouse-only arrows.

- `]` / `[` → next/prev block (scrolls + highlights)
- `h` / `l` (or `←` / `→`) → take ours / take theirs **for the current block** (the one under cursor or last-navigated)
- `Space` → toggle block source (ours ↔ theirs)
- Gate behind a "nav mode" so normal CM6 editing isn't hijacked. Toggle via `Esc` (nav) / `i` or click (edit) — vim-modal style.

## Phase 2 — Merge Mode (`activeView='merge'`)

**Goal:** Promote conflict resolution to a top-level view alongside `log` / `branches`. Toolbar nav tab `⧉ Merge [5]` (badge = conflict count across the selected revision, or across `conflicts()` revset if nothing selected).

### Layout

```
┌─────────────────────────────────────────────────────────────┐
│  ◉ Revisions  ⑂ Branches  ⧉ Merge [3]                       │  toolbar
├──────────────┬──────────────────────────────────────────────┤
│ Conflict     │                                              │
│ queue        │         MergePanel (current file)            │
│ (left rail)  │                                              │
│              │                                              │
│ ○ foo.go     │  ← ours  │  result  │  theirs →             │
│ ● bar.ts  ◄──┤                                              │
│ ○ baz.md     │                                              │
│              │                                              │
│ [3/5 done]   │  Conflict 2 of 4          [n] [p]  minimap  │
└──────────────┴──────────────────────────────────────────────┘
```

### 2.1 Conflict queue (left rail)

A `ConflictQueue.svelte` component — thin list of `{path, sides, resolved}` entries.

- **Data source:** `changedFiles.filter(f => f.conflict)` is already in App via the `files` loader. But that's per-selected-revision. For merge mode we want: **all conflicted files in the `conflicts()` revset**, or just the selected revision if one is picked.
- **Backend:** New endpoint `GET /api/conflicts?revset=X` → returns `[{commitId, changeId, files: [{path, sides}]}]`. Template: `self.commit_id() ++ self.change_id() ++ conflicted_files.map(|f| f.path() ++ f.conflict_side_count())`. Essentially `FilesBatch` filtered to conflict-only.
- **Navigation:** j/k in the queue → `currentFile` → MergePanel remounts via `{#key currentFile.path}`. Saving auto-advances to next unresolved. `[` / `]` also work here (file-level, distinct from in-file `[` / `]`).
- **Resolved tracking:** In-memory per-session. `Set<path>` of saved files. Render ○/● dots. "3/5 done" footer.

### 2.2 Merge mode entry points

- **Toolbar tab** — `5` key (or `m`), always visible when `conflicts()` is non-empty (cheap: `GET /api/log?revset=conflicts()&limit=1` on the same cadence as the existing conflict badge in StatusBar).
- **From DiffPanel** — "Resolve all conflicts" button in the diff header when `conflictCount > 0` → `switchToMergeView()` pre-filtered to the displayed revision.
- **From a conflict badge in RevisionGraph** — click the `⚠ 3` badge → merge mode filtered to that commit.

### 2.3 Keeping App.svelte sane

`activeView='merge'` follows the `branches` pattern: right-column takeover, RevisionGraph hidden. `switchToMergeView()` helper mirroring `switchToLogView()`. `ModeBase.diffFollows` is N/A (merge doesn't use the diff loader) — merge mode gets its own `mergeQueueIndex` + `currentMergeFile` state, not overloaded onto `selectedIndex`.

**One footgun:** MergePanel currently swallows ALL keydown (`swallowKeydown`). Merge-mode keyboard (queue j/k, file nav) needs to reach App. Narrow the swallow to only when center CM6 has focus, or flip to an explicit allow-list (Escape, tab-switch keys pass through).

## Phase 3 — File History Mode

Kaleidoscope's headline feature: "browse and compare all revisions of a file."

### 3.1 Entry point

- Right-click any file in DiffPanel → "View history"
- `api.fileHistory(path)` → `GET /api/file-history?path=X&limit=50`
- Backend: `jj log <path> --template <LogGraph template>` — jj already supports path-filtered log natively. Wrap in `commands.go`:
  ```go
  func FileLog(path string, limit int) CommandArgs {
    return append(LogGraph("", limit), EscapeFileName(path))
  }
  ```

### 3.2 Layout

```
┌──────────────────────────────────────────────────────────────┐
│  File: src/lib/api.ts                         [✕ close]      │
├──────────────┬───────────────────────────────────────────────┤
│ Revisions    │  ┌─A──────────┐       ┌─B──────────┐         │
│ touching     │  │ rev A      │       │ rev B      │         │
│ this file    │  │ @ abc123   │  ⇄    │ @ def456   │         │
│              │  │ (pinned)   │       │ (cursor)   │         │
│ ◆ abc123 2d  │  └────────────┘       └────────────┘         │
│ ○ def456 5d  │                                               │
│ ○ fed321 2w  │       unified diff: A → B                     │
│ ○ 987cba 1mo │       (or split view — reuse DiffFileView)    │
│              │                                               │
└──────────────┴───────────────────────────────────────────────┘
```

### 3.3 Two-cursor compare

- **A-cursor (pinned):** Space to pin a revision. Sticky until re-pinned.
- **B-cursor (live):** j/k navigation. Diff auto-updates as you move.
- Default: A = newest revision, B = cursor. Moving j/k walks backward through history showing "what changed in this commit".
- **Diff source:** `api.diffRange(commitA, commitB, [path])` — already exists, already cached by `diffRange` LRU.

### 3.4 Component reuse

- `FileHistoryPanel.svelte` — new. Left rail = mini `RevisionGraph` (same 18px rows, same GraphSvg gutter, but filtered commit list). Right = `DiffFileView` fed from `diffRange`.
- `RevisionGraph` is too heavy (virtualizer, graph parsing). Extract a `RevisionList.svelte` that renders `Commit[]` without graph gutter — or pass a `compact` prop to RevisionGraph that skips the SVG gutter and forces eager rendering (file history is typically <50 entries, under `VIRTUALIZE_THRESHOLD`).

### 3.5 "Open this revision in merge" bridge

If the file-history revision is conflicted (jj tracks this), a "Resolve conflict here" button jumps to merge mode with that file pre-selected. Closes the loop between the two new modes.

## Phase 4 — Polish (Kaleidoscope parity)

### 4.1 Connecting ribbons between panes

The curvy SVG lines Kaleidoscope draws between matching blocks in A / center / B.

- **Impl:** Absolute-positioned `<svg>` overlay spanning all three panes. For each block, draw a bezier from `(oursPane.right, oursBlock.y)` → `(centerPane.left, centerBlock.y)` and mirror for theirs. Y positions already tracked in `oursArrows` / `theirsArrows` — they're the same data.
- **Complexity:** Scroll sync means Y coords shift together, so ribbons translate with `scrollTop`. The tricky bit is the X coords when a flank is hidden (`hiddenFlank`). Gate the SVG layer on `hiddenFlank === null`.
- **Value:** High visual payoff, ~100 lines of SVG path math. `GraphSvg.svelte` has the bezier patterns already.

### 4.2 Base-diff inline popup

Kaleidoscope's "BASE vs B" floating panel — shows what the base looked like vs what the side changed.

- **Data:** `sides.base` is already parsed by `reconstructSides()`. Currently unused.
- **UI:** Hover a block arrow for >500ms (or click a `ⓘ` icon) → floating popup with a mini 2-col diff of `base` vs `side` for JUST that block's line range. Reuses `diffBlocks()` + the highlight classes.
- **Value:** Medium. Helps answer "why did this side change this?" — particularly for rebase conflicts where "theirs" is your own stale commit.

### 4.3 Per-block "both" action

jj's conflict model supports "take both" (concatenate) for additive conflicts (e.g., two new imports, two new list entries).

- **UI:** Third arrow `⇅` on blocks where both sides are pure-add relative to base (`blk.aFrom !== blk.aTo && blk.bFrom !== blk.bTo` AND base has zero lines in that region — needs base-relative LCS, one more `diffBlocks(base, ours)` pass).
- **Impl:** `planTakeBoth()` in merge-surgery.ts — insert `ours + '\n' + theirs` at the tracked position. Source tag = `'both'` (new `BlockSource` variant).

### 4.4 Auto-resolve trivial conflicts

`jj resolve --tool :ours` / `:theirs` already exists. For blocks where one side == base (no-op change), offer "Auto-resolve trivial" button that runs `takeBlock(i, nonTrivialSide)` for all such blocks.

- **Detection:** Compare each block's `ours` slice vs `base` slice (extracted from `sides.base`). If identical → theirs is the real change → auto-take theirs. And vice versa.

## Implementation order & sizing

| Phase | Item | Size | Depends on |
|---|---|---|---|
| 1.1 | In-file conflict nav | S | — |
| 1.2 | Minimap | S | — |
| 1.3 | Rich headers | M | conflict-extract refactor |
| 1.4 | Take-all | S | — |
| 1.5 | Keyboard nav | M | 1.1 |
| 2.1 | Conflict queue | M | new `/api/conflicts` |
| 2.2 | Merge mode entry | S | 2.1 |
| 2.3 | App integration | M | 2.1, keyboard rework |
| 3.1 | File history API | S | `FileLog` builder |
| 3.2-3.4 | FileHistoryPanel | L | 3.1, RevisionList extraction |
| 3.5 | Merge↔History bridge | S | 2.x + 3.x |
| 4.1 | Ribbons | M | — |
| 4.2 | Base popup | M | — |
| 4.3 | Take-both | M | merge-surgery extension |
| 4.4 | Auto-resolve trivial | S | base-relative LCS |

**Suggested batching:**
- **v1.3.0:** Phase 1 complete (MergePanel polish). Low-risk, touches one component.
- **v1.4.0:** Phase 2 (merge mode). New `activeView`, backend endpoint, one new component.
- **v1.5.0:** Phase 3 (file history). Standalone feature, minimal coupling.
- **v1.6.0:** Phase 4 cherry-picked by demand.

## Open questions

1. **Merge mode scope:** Conflicts at `@` only, or across the whole `conflicts()` revset? The latter is more powerful (resolve a whole rebase stack in one session) but needs per-commit grouping in the queue. Lean toward revset-scoped with commit headers in the queue — matches jj's mental model where conflicts propagate through descendants.

2. **Saving semantics in merge mode:** Current `saveMerge` writes to WC via `api.fileWrite` — `@`-only. But `jj resolve -r <rev> --tool <name>` works for ANY revision. The pattern is **already proven** in this codebase: `writeHunkToolConfig` (handlers.go:1077) registers lightjj as an ephemeral merge tool via `--config-file`, jj invokes it with `$left`/`$right`/`$output` paths, handler writes the result. For merge mode:
   - Frontend POSTs `{revision, path, content}` to `/api/resolve-write`
   - Backend writes `content` to a temp file, emits a `merge-tools.lightjj-resolve` config with `merge-args = ["--write-resolved", tmpPath, "$output"]`, runs `jj resolve -r <rev> --tool lightjj-resolve <path>`
   - lightjj's `--write-resolved` mode (new CLI flag) just copies tmp → `$output`
   - Works for any revision, leverages jj's own conflict-resolution bookkeeping (marks file resolved, updates descendants)

   This also gives us `$base` for free — the tool config can capture it to a second temp file, letting us drop `reconstructSides()`'s marker-parsing entirely in favor of jj handing us the three sides directly. **Significant simplification** — no more {7,} regex edge cases.

3. **File history for renamed files:** `jj log <path>` follows renames? Need to verify. Git's `--follow` equivalent. If not, file history truncates at rename — acceptable v1, note in UI.

4. **N-way conflicts (sides > 2):** `reconstructSides()` returns `null` today → falls back to raw FileEditor. Kaleidoscope doesn't handle these either. Keep the fallback; show "N-way conflict, edit raw" in the queue with a distinct icon.

## Testing strategy

- **merge-surgery.ts:** Already has round-trip invariant tests. `planTakeBoth` (4.3) adds one more shape.
- **conflict-extract.ts:** Add fixtures with commit-ref markers for the `MergeSideMeta` regex (1.3).
- **ConflictQueue.svelte:** Mock `/api/conflicts` response, test j/k nav + auto-advance-on-save.
- **FileHistoryPanel:** Mock `diffRange` responses, test A/B cursor pinning + diff update on j/k.
- **Integration:** `handlers_test.go` for `/api/conflicts` + `/api/file-history` with MockRunner.

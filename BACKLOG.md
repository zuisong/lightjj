# lightjj Backlog

Open items only. Done-item narratives live in [docs/CHANGELOG-ARCHIVE.md](docs/CHANGELOG-ARCHIVE.md).

## Confirmed bugs (2026-03-20 — fixed in current WC, pending ship)

Three clusters from the 2026-03-18 targeted bughunts. Status per bug below.

### Watcher/SSE — fixed (5/7, 2 accepted)

`internal/api/watcher.go` + `handlers.go` + `frontend/src/lib/api.ts`.

- [x] **cachedOp never seeded** — `handleEvents` now refreshes if `getOpId()==""` (covers both local + SSH in one place). Frontend `mark()` helper counts stale/fresh events as watcher-alive too (defense in depth). `refreshOpId()` SSH fallback now has a 10s timeout (bughunter bug_003: `context.Background()` alone would block SSE setup indefinitely on SSH hang). `TestHandleEvents_SendsInitialOpIdOnConnect` table test covers both branches.
- [x] **Swap+broadcast race** — `setStale(bool)` helper serializes under `staleMu`; all 4 loop sites + 2 handler calls go through it. `TestWatcher_SetStale_EdgeOnlyBroadcast` locks the invariant.
- [x] **handleSnapshot asymmetry** — both handlers call `clearStale()`. `TestHandler_ClearsStale` table test.
- [x] **sshPollLoop cachedOp regression** — CAS against `preCached` (DURING-call race) + `lastBroadcast` local tracker (BETWEEN-tick mutations — collapsing these was a regression the first CAS fix introduced, caught by bughunter bug_017). `TestSSHPollLoop_CASGuardsConcurrentAdvance` + `TestSSHPollLoop_BroadcastsBetweenTickMutation`.
- [x] **WriteDeadline zeroed** — per-write `extendDeadline()` (60s). Dead TCP surfaces in ≤85s (25s keepalive + 60s deadline) instead of OS keepalive's ~2-10min.
- [ ] **sentinel drop on full buffer** — accepted. 4-element buffer + localhost = negligible. SSE-reconnect's connect-time state emit is the recovery path. Comment at `:314` documents.
- [ ] **(original bug #2 variant)** — merged into cachedOp-seed fix above.

### Merge editor — fixed (4/6, 1 accepted, 1 covered by full-pipeline test)

`frontend/src/lib/merge-surgery.ts` + `MergePanel.svelte` + `conflict-extract.ts`.

- [x] **invertedEffects missing restoreBlock branch** — added. Undo→redo now restores source tag.
- [x] **planTake srcEmpty+from===to no-op** — branch reorder (srcEmpty before from===to). Empty line tracks as zero-width; previously unreachable. Two new targeted tests.
- [x] **planTake blank-line at shared-empty-line no-op** — `oppEmpty` distinguisher (opposite-side block range). Empty line IS block content (oppEmpty=false) → replace. Shared LCS content (oppEmpty=true) → insert-before with trailing \n. Both cases tested.
- [x] **M_START escalated-content false-null** — shorter `<` run inside region is content (jj escalated BECAUSE of it). `TestEscalatedRegion_ShorterLtRun`.
- [ ] **`+` marker diff-mode labeled false positive** — accepted. Stem-checking jj's label format couples to jj output (commit-ref vs "Contents of side #N" varies by version). Rare trigger (6-plus-chars + ws + text in source), non-catastrophic (sideNum>2 → null → raw-editor fallback). Comment documents.
- [x] **srcEmpty \n crosses block boundary** — covered by the new `full-pipeline round-trip` `it.each` sweep (7 shapes × diffBlocks × every-block-ours→theirs-back = identity). If the crossing case manifested, the sweep would catch it.

### Divergence panel — fixed (4/8, 4 deferred as nits/low-impact)

`frontend/src/lib/DivergencePanel.svelte` + `divergence.ts`.

- [x] **Template crash on arity mismatch** — `nVersions = Math.max(...versions.map(l => l.length))` + optional chaining + "—" placeholders for missing cells. Keep stays disabled via `!alignable`.
- [x] **fileUnion tip-level only** — `found.versions.flat()` instead of tip-only. All-level paths feed refineRebaseKind.
- [x] **Shared error state clobbers panel** — `crossDiffError` separate; cleared at effect top (bughunter bug_010: early-returns left stale error displayed); rendered inline with `.diff-error { color: var(--red) }` (bughunter bug_018: first fix added the class but not the CSS rule). Main `error` only for load failures.
- [x] **Non-conflicted bookmarks cascade to trunk** — `buildKeepPlan` now scans ALL loser-column `v.bookmarks` directly (not conflicted-only subset). Dedup by name. Two new tests + sweep Invariant-6 now exercises real v.bookmarks.
- [ ] **confirmRebaseDescendants wrong target** — deferred. Requires per-descendant parent-level tracking; current `keeperTip` target is correct for the common case (descendants off tip). Mid-stack-branch case is uncommon.
- [ ] **Invisible versions/descendants** (nit × 2) — partially fixed by nVersions=MAX (all columns render); mid-stack descendant display still tip-filtered (low priority, confirm dialog shows them).
- [ ] **commit_id.short() TOCTOU** (nit) — deferred. Same window as `staleImmutableTemplate`; low-probability in practice.

## Active

- [ ] **OplogPanel visual diff** (Small, deferred) — Enter → `jj op show` expansion shipped. Remaining: visual diff between op snapshots (tree-at-op-A vs tree-at-op-B). `jj op show -p` gives per-change patches but comparing two arbitrary ops needs `--at-op` revset gymnastics. Defer until asked.

## Architecture debt

- [ ] **`RepoDir == ""` overloaded sentinel** (Low) — Used as SSH-mode flag across 4 sites (down from 6 — two were consolidated). Conflates "SSH mode" / "test mode" / "no local fs". A `hasLocalFS bool` would clarify but is cosmetic.
- [ ] **`recent-actions` localStorage port loss** (Trivial) — `localhost:0` randomizes port → localStorage resets each launch → BookmarkModal "recent first" sort is always cold. Migrate to server-side or accept soft-degrade.
- [ ] **No `storage` event listener in config.svelte.ts** (Trivial) — two browser tabs on same port: A writes localStorage, B's `$state` never re-reads. Diverge until reload.

## Deferred (explicit — don't do unless conditions change)

- [ ] **8 near-identical bookmark handlers** (Low, taste-dependent) — handlers.go. Each is decode → validate-non-empty → runMutation. Go's lack of structural typing makes table-driven dispatch awkward; current form is greppable.
- [ ] **Flat `api` object at ~50 methods** (Deferred) — bookmark sub-family (7 methods) is the strongest namespace case. Pure helpers don't belong in api.ts. Hold until next expansion.
- [ ] **Watcher struct does 5 things** (Deferred — testability already achieved) — Decomposition would add 3 lifecycle owners needing coordinated shutdown for zero new testability. Revisit only if a third `OpHeadsWatcher` impl appears.
- [ ] **Annotations repo-partitioning** (Trivial) — `annotations/{changeId}.json` — changeId is jj-random (~2^128 space), collision across repos is negligible but semantically wrong.
- [ ] **SSH stdin/stdout multiplexing protocol** (Complex) — one persistent SSH session, commands + responses over a framed protocol. Only worth it if port-forward isn't an option. `--remote` stays viable for quick-peek; heavy use → port-forward.

## Small features

- [ ] **`git push --option` / `-o`** (Trivial) — Add to `allowedGitPushFlags`. Gerrit reviewers, GitLab merge options. Low demand; wait for a request.
- [ ] **`--simplify-parents` on rebase** (Trivial) — Add to `Rebase()` builder signature, wire a checkbox in rebase mode. Useful when rebasing onto a descendant of the old parent.
- [ ] **Double-slice per diff line** (Trivial) — DiffFileView.svelte slices `line.content` twice per render. One alloc.

## Advanced features (roadmap 2.0)

- [ ] **Mega-file virtualization** (Low) — manual expand of 5000-line file renders all lines. Auto-collapse at 500 + total-line collapse at 2000 mitigate; `@tanstack/virtual` on the per-hunk `{#each}` inside DiffFileView would be the full fix.
- [ ] **Search across revisions** (Medium) — `jj log -r 'description(glob:"*query*")'` or tree-grep. Needs design.
- [ ] **SSH remote repo browser** (Low) — discover repos on remote host, open as tabs.
- [ ] **Drag-and-drop rebase** (Low) — drag revision onto destination. Inline keyboard rebase already covers the CUJ.
- [ ] **Hunk-level accept/reject** (Medium) — `jj split --tool` protocol. The "review mode" (`v` key) currently does file-level; hunk-level needs a tool handshake.
- [ ] **LSP-in-FileEditor** (Complex) — hover/goto in the inline editor. Depends on the LSP running relative to the repo root.

## Known non-goals

Kept here so they don't get re-proposed.

- **Modal-union for App.svelte** — of 9 booleans only 5 are real modals, all use `bind:open` (union would need 5 getter/setter binding pairs = more code than now).
- **Keybind registry** (PaletteCommand-shaped array with `when` predicates) — adding a new mode requires auditing every `when` to add `&& !newMode.active`; current early-return-and-swallow is structurally safer.
- **`createInlineEdit()` / `createDiffSearch()` factories** — stale-guard bug + net +LOC + `set error` smell; factorizing creates "distributed monolith" with injected getters replacing closure access.

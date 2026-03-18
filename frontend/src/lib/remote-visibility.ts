// Revset construction for the per-remote visibility feature.
// Extracted from App.svelte so the quoting rules and @-operator semantics are
// unit-testable — the "nothing visible" bug (quoting the @ operator as part of
// a string literal instead of leaving it unquoted) was found in live testing,
// not a unit test. Now it's locked in.

import type { Bookmark, RemoteVisibility } from './api'

// jj revset string-literal: backslash + double-quote need escaping. Git ref
// names forbid both (git-check-ref-format) but remote names are user-chosen;
// a remote named `my"repo` would otherwise produce a syntax-invalid revset.
export function revsetQuote(s: string): string {
  return `"${s.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`
}

// Builds a revset that shows commits reachable from the visible remote bookmarks.
// Uses remote_bookmarks(remote="X") — the named `remote=` arg selects by remote name,
// not bookmark name pattern. Returns '' if no remotes are visible.
//
// Returns null if a hidden-list is set but bookmarks is empty — per-bookmark
// enumeration needs the bookmark list to know what's NOT hidden. Without it,
// the output is indeterminate (not the same as '' = genuinely nothing visible).
// The caller's sync effect skips null so bookmarks-loading doesn't look like a
// user toggle.
//
// Per-bookmark enumeration uses `"name"@remote`, NOT `"name@remote"` — quoting
// the whole string makes jj look up a SYMBOL literally named `name@remote`
// (which doesn't exist). The `@` must stay unquoted to function as the
// operator. Remote is also quoted independently to survive special chars.
export function buildVisibilityRevset(vis: RemoteVisibility, bookmarks: Bookmark[]): string | null {
  const parts: string[] = []
  for (const [remote, entry] of Object.entries(vis)) {
    if (!entry.visible) continue
    const qRemote = revsetQuote(remote)
    if (!entry.hidden?.length) {
      parts.push(`remote_bookmarks(remote=${qRemote})`)
    } else {
      if (bookmarks.length === 0) return null
      const hidden = new Set(entry.hidden)
      const visible = bookmarks
        .flatMap(bm => (bm.remotes ?? [])
          .filter(r => r.remote === remote && !hidden.has(bm.name))
          .map(() => `${revsetQuote(bm.name)}@${qRemote}`)
        )
      if (visible.length > 0) parts.push(visible.join(' | '))
    }
  }
  if (parts.length === 0) return ''
  return `ancestors(${parts.join(' | ')}, 2)`
}

/** Sync-effect decision logic, extracted for table-driven testing.
 *  The effect fires on every visibilityRevset change; this decides whether
 *  to write revsetFilter (and what to write). `prev` is the LAST value this
 *  function observed (caller-threaded).
 *
 *  Returns { nextPrev, apply } — caller threads nextPrev forward and writes
 *  revsetFilter = apply iff apply !== null. */
export function syncVisibility(
  vr: string | null,
  prev: string | undefined,
  currentFilter: string,
): { nextPrev: string | undefined; apply: string | null } {
  // Indeterminate — bookmarks not loaded, hidden-mode can't enumerate.
  // RESET prev: repoPath arrives async, so there's a mount fire with
  // vis={} → vr='' that sets prev='' BEFORE this null. Preserving prev
  // would mean the next determinate vr sees prev='' === filter='' → apply.
  // Resetting makes null→determinate a true first-fire (set, don't apply).
  if (vr === null) return { nextPrev: undefined, apply: null }

  // First determinate fire. loadLog at mount handles the initial load;
  // applying here would double-request. Also covers null→determinate.
  if (prev === undefined) return { nextPrev: vr, apply: null }

  // Apply only if user is tracking visibility (filter still equals what
  // this effect last observed). User-cleared (''), user-custom ('mine()'),
  // or preset — all leave the effect dormant until they re-apply visibility.
  return { nextPrev: vr, apply: currentFilter === prev ? vr : null }
}

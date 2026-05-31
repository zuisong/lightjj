// Shared conflict-marker scanner: escalation-aware width discovery + exact-
// width matching. Both conflict-marker consumers run on this core:
//   - conflict-extract.ts  — raw `jj file show` content → MergePanel sides
//   - conflict-parser.ts   — diff-wrapped `+` lines → DiffFileView regions
//
// jj escalates marker length when file content already contains 7-char marker
// lookalikes (jj-lib conflicts.rs: max(7, longest-content-lookalike + 1)).
// All markers in one region share that exact length, so:
//   1. The `<<<<<<<` start marker DISCOVERS the width for its region.
//   2. Every other marker must match EXACTLY that width — a shorter run is the
//      content jj escalated to protect; a longer run is content too.
// Fixed `{7}` / sloppy `{7,}` regexes (the pre-unification approaches) misfire
// on both, e.g. a `-------` markdown HR inside a snapshot section.

/** Marker classification for one scanned line. */
export type MarkerEvent =
  /** `<<<<<<<` outside a region — opens one. markerLen = discovered width. */
  | { kind: 'start'; label: string; markerLen: number }
  /** `<<<<<<<` of >= current width INSIDE a region — nested/malformed. The
   *  scanner restarts its region tracking at this line; consumers choose to
   *  bail (conflict-extract → null) or flush-and-restart (conflict-parser). */
  | { kind: 'restart'; label: string; markerLen: number }
  /** `%%%%%%%` — a diff-format side section. */
  | { kind: 'diff'; label: string }
  /** `+++++++` — a snapshot-format side section. */
  | { kind: 'snapshot'; label: string }
  /** `-------` — the snapshot-style base section (not a pickable side). */
  | { kind: 'base'; label: string }
  /** `\\\\\\\` sub-marker inside a diff section — names the "to" commit. */
  | { kind: 'diffTo'; label: string }
  /** `>>>>>>>` — closes the region. */
  | { kind: 'end'; label: string }

export interface ConflictScanner {
  /** Classify one line (RAW marker line — diff consumers strip their `+`
   *  prefix first). Returns null for content, including escalation-protected
   *  marker lookalikes. Stateful: advances region/section tracking. */
  next(line: string): MarkerEvent | null
  /** True while inside an unterminated region (EOF-truncation detection). */
  readonly inRegion: boolean
}

// Width discovery for region starts: ≥7 `<` chars, then end-of-line or
// whitespace+label. Only the START marker uses a regex — every other marker is
// matched at the exact width this discovers.
const M_START = /^(<{7,})(?:\s+(.*))?$/

/** True if line is EXACTLY `len` repetitions of `ch` followed by nothing or
 *  whitespace+label. Returns the label (or '') on match, null otherwise.
 *  Exact-length matching is what distinguishes a real 8-char `--------` marker
 *  from a 7-char `-------` content line under escalation. */
function matchMarker(line: string, ch: string, len: number): string | null {
  if (line.length < len) return null
  for (let i = 0; i < len; i++) if (line[i] !== ch) return null
  // After the run: must be end-of-line, OR whitespace (label follows).
  // A longer run of the SAME char is NOT a match — that would be file content
  // like `--------` (8 dashes) when markers are 7, or vice versa.
  if (line.length === len) return ''
  if (line[len] === ch) return null
  if (!/\s/.test(line[len])) return null
  return line.slice(len + 1).trim()
}

export function createConflictScanner(): ConflictScanner {
  let inRegion = false
  // Marker length for the CURRENT region, discovered from the <<<<<<< width.
  // All jj markers in one region use the same length (escalation is per-file).
  // 0 = not in a region.
  let mLen = 0
  // Current section type — gates three false-match defenses:
  //  - `\` diffTo sub-markers are only valid inside a diff section.
  //  - `+` markers inside a diff section require a non-empty label: an added
  //    content line of (mLen-1) plus chars gets a `+` diff prefix → bare
  //    mLen-char run. jj always labels real markers.
  //  - `-` base markers never appear after a `%%%%%%%` section (Diff style
  //    encodes base via `-`-prefixed lines, not a separate block); without the
  //    gate, a deleted dash-line inside a diff section false-positives even
  //    when the width happens to match.
  let mode: 'out' | 'diff' | 'snap' | 'base' = 'out'

  function openRegion(len: number) {
    inRegion = true
    mLen = len
    mode = 'out'
  }

  function next(line: string): MarkerEvent | null {
    const m = line.match(M_START)
    if (m) {
      const label = (m[2] ?? '').trim()
      if (!inRegion) {
        openRegion(m[1].length)
        return { kind: 'start', label, markerLen: m[1].length }
      }
      if (m[1].length >= mLen) {
        openRegion(m[1].length)
        return { kind: 'restart', label, markerLen: m[1].length }
      }
      // Shorter run = content. jj escalated mLen BECAUSE the file contains
      // <mLen-char runs; re-matching them here would misfire on the very line
      // jj was protecting. Fall through to the (non-matching) checks below.
    }
    if (!inRegion) return null

    let lbl: string | null
    if ((lbl = matchMarker(line, '>', mLen)) !== null) {
      inRegion = false
      mLen = 0
      mode = 'out'
      return { kind: 'end', label: lbl }
    }
    if ((lbl = matchMarker(line, '%', mLen)) !== null) {
      mode = 'diff'
      return { kind: 'diff', label: lbl }
    }
    if (mode === 'diff' && (lbl = matchMarker(line, '\\', mLen)) !== null) {
      return { kind: 'diffTo', label: lbl }
    }
    // The + marker CAN follow a %%%%%%% section (Diff style: diff then
    // snapshot) — but see the diff-mode label requirement above.
    //
    // Known edge: content `++++++  foo` + `+` prefix = mLen plus chars + ws +
    // text → passes `lbl !== ''` → false marker. Rare (6-plus-chars followed
    // by ws+text in source) and non-catastrophic (extract sees an extra side →
    // null → raw-editor fallback). Stem-checking jj's label format would
    // couple to jj's output (commit-ref labels vs "Contents of side #N" vary
    // by version/config).
    if ((lbl = matchMarker(line, '+', mLen)) !== null && (mode !== 'diff' || lbl !== '')) {
      mode = 'snap'
      return { kind: 'snapshot', label: lbl }
    }
    if (mode !== 'diff' && (lbl = matchMarker(line, '-', mLen)) !== null) {
      mode = 'base'
      return { kind: 'base', label: lbl }
    }
    return null
  }

  return {
    next,
    get inRegion() { return inRegion },
  }
}

// Extract a human-readable label from jj's conflict marker text.
// Marker text looks like:
//   diff from: lpymxuwk 75ef1147 "Conflict resolution"
//   wlykovwr 562576c8 "side Y: modify existing file differently"
//   Changes from base to side #1
// We prefer the quoted commit description, falling back to the raw text.
export function extractSideLabel(markerText: string): string {
  const quoted = markerText.match(/"([^"]+)"/)
  if (quoted) return quoted[1]
  return markerText.trim()
}

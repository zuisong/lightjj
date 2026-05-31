// Parses jj conflict markers from diff lines to identify conflict regions.
//
// In unified diff output, conflict markers appear as `+` lines since the file
// now contains them. We scan for patterns like:
//   +<<<<<<< Conflict 1 of 3
//   +%%%%%%% Changes from base to side #1
//   ++++++++  Contents of side #2
//   +>>>>>>> Conflict 1 of 3 ends
//
// The marker grammar (escalation-aware width discovery, exact-width matching,
// false-match defenses) lives in the shared scanner — conflict-markers.ts —
// the same core conflict-extract.ts runs on raw file content. This file is the
// diff-side adapter: it strips the `+` diff prefix, feeds add-type lines, and
// maps scanner events back onto DiffLine indices in the
// ConflictRegion/ConflictSide shape DiffFileView consumes.

import type { DiffLine } from './diff-parser'
import { createConflictScanner, extractSideLabel } from './conflict-markers'

export interface ConflictSide {
  type: 'diff' | 'snapshot'
  // For 'snapshot' sides, label is the commit that produced this content.
  // For 'diff' sides, label is the "to" commit (from the \\\\\\\ sub-marker) —
  // that's what `:ours`/`:theirs` actually KEEPS when you pick this side.
  label: string
  startIdx: number
  endIdx: number  // inclusive
}

export interface ConflictRegion {
  startIdx: number    // index into hunk.lines (the <<<<<<< line)
  endIdx: number      // inclusive (the >>>>>>> line)
  label: string       // e.g. "Conflict 1 of 3"
  sides: ConflictSide[]
}

export function findConflicts(lines: DiffLine[]): ConflictRegion[] {
  const regions: ConflictRegion[] = []
  let current: ConflictRegion | null = null
  let currentSide: ConflictSide | null = null
  const scanner = createConflictScanner()

  // Flush the in-progress region ending at `endIdx` (malformed restart / EOF).
  // Pushes the partial region so the UI at least shows something.
  const flushAt = (endIdx: number) => {
    if (!current) return
    if (currentSide) currentSide.endIdx = endIdx
    current.endIdx = endIdx
    regions.push(current)
    current = null
    currentSide = null
  }

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    // Conflict markers only ever appear as ADDED lines (the conflicted file
    // contains them). Context/removed lines are not part of the marker stream
    // — they're skipped without advancing the scanner, matching the historical
    // "ignore context lines inside conflict regions" behavior.
    if (line.type !== 'add') continue

    // Strip the `+` diff prefix — the scanner sees raw marker lines.
    const ev = scanner.next(line.content.slice(1))
    if (!ev) {
      // Content line (including escalation-protected marker lookalikes).
      if (currentSide) currentSide.endIdx = i
      continue
    }

    switch (ev.kind) {
      case 'start':
      case 'restart':
        // restart = nested/malformed marker — flush the in-progress region
        // (truncated diff output etc.), then start fresh.
        if (ev.kind === 'restart') flushAt(i - 1)
        current = { startIdx: i, endIdx: i, label: ev.label, sides: [] }
        currentSide = null
        break
      case 'diff':
      case 'snapshot':
        if (!current) break
        if (currentSide) currentSide.endIdx = i - 1
        // For diff sides the %%%%%%% line has "diff from: X" — but choosing
        // that side keeps the TO state, not the FROM state. The \\\\\\\ "to:"
        // sub-marker below will overwrite this label with what the user
        // actually keeps. Falls back to the %%%%%%% text if no \\\\\\\ marker
        // (e.g. the "Changes from base to side #1" format, which already
        // names the result).
        currentSide = { type: ev.kind, label: extractSideLabel(ev.label), startIdx: i, endIdx: i }
        current.sides.push(currentSide)
        break
      case 'diffTo':
        // The \\\\\\\ "to:" sub-marker names what this diff transforms INTO.
        // That's what `:ours`/`:theirs` keeps if you pick this side, so it
        // becomes the side's primary label (overwrites the "from" label).
        if (currentSide && currentSide.type === 'diff') {
          currentSide.label = extractSideLabel(ev.label)
          currentSide.endIdx = i
        }
        break
      case 'base':
        // Snapshot-style base section — not a pickable side. Close the current
        // side so base lines aren't attributed to it.
        if (currentSide) {
          currentSide.endIdx = i - 1
          currentSide = null
        }
        break
      case 'end':
        if (!current) break
        if (currentSide) currentSide.endIdx = i - 1
        current.endIdx = i
        regions.push(current)
        current = null
        currentSide = null
        break
    }
  }

  // Handle unterminated conflict at EOF (e.g., truncated diff output).
  flushAt(lines.length - 1)

  return regions
}

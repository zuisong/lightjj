import { describe, it, expect } from 'vitest'
import { findConflicts } from './conflict-parser'
import type { DiffLine } from './diff-parser'

function addLine(content: string): DiffLine {
  return { type: 'add', content }
}

function ctxLine(content: string): DiffLine {
  return { type: 'context', content }
}

describe('findConflicts', () => {
  it('returns empty for no conflicts', () => {
    const lines: DiffLine[] = [
      addLine('+normal add line'),
      ctxLine(' context line'),
    ]
    expect(findConflicts(lines)).toEqual([])
  })

  it('detects a single conflict', () => {
    const lines: DiffLine[] = [
      ctxLine(' before'),
      addLine('+<<<<<<< Conflict 1 of 1'),
      addLine('+%%%%%%% Changes from base to side #1'),
      addLine('+-old line'),
      addLine('++side 1 line'),
      addLine('++++++++ Contents of side #2'),
      addLine('+side 2 line'),
      addLine('+>>>>>>> Conflict 1 of 1 ends'),
      ctxLine(' after'),
    ]
    const regions = findConflicts(lines)
    expect(regions).toHaveLength(1)
    expect(regions[0].startIdx).toBe(1)
    expect(regions[0].endIdx).toBe(7)
    expect(regions[0].label).toBe('Conflict 1 of 1')
    expect(regions[0].sides).toHaveLength(2)
    expect(regions[0].sides[0].type).toBe('diff')
    expect(regions[0].sides[0].startIdx).toBe(2)
    expect(regions[0].sides[0].endIdx).toBe(4)
    expect(regions[0].sides[1].type).toBe('snapshot')
    expect(regions[0].sides[1].startIdx).toBe(5)
    expect(regions[0].sides[1].endIdx).toBe(6)
  })

  it('detects multiple conflicts', () => {
    const lines: DiffLine[] = [
      addLine('+<<<<<<< Conflict 1 of 2'),
      addLine('+%%%%%%% Changes from base to side #1'),
      addLine('+line1'),
      addLine('++++++++ Contents of side #2'),
      addLine('+line2'),
      addLine('+>>>>>>> Conflict 1 of 2 ends'),
      ctxLine(' between'),
      addLine('+<<<<<<< Conflict 2 of 2'),
      addLine('+%%%%%%% Changes from base to side #1'),
      addLine('+line3'),
      addLine('++++++++ Contents of side #2'),
      addLine('+line4'),
      addLine('+>>>>>>> Conflict 2 of 2 ends'),
    ]
    const regions = findConflicts(lines)
    expect(regions).toHaveLength(2)
    expect(regions[0].label).toBe('Conflict 1 of 2')
    expect(regions[1].label).toBe('Conflict 2 of 2')
    expect(regions[1].startIdx).toBe(7)
    expect(regions[1].endIdx).toBe(12)
  })

  it('ignores context lines inside conflict regions', () => {
    const lines: DiffLine[] = [
      addLine('+<<<<<<< Conflict 1 of 1'),
      addLine('+%%%%%%% Changes'),
      ctxLine(' this is context, not part of conflict content'),
      addLine('+side 1'),
      addLine('++++++++ Side #2'),
      addLine('+side 2'),
      addLine('+>>>>>>> Conflict 1 of 1 ends'),
    ]
    const regions = findConflicts(lines)
    expect(regions).toHaveLength(1)
    // Context line at index 2 is skipped; diff side runs from marker at 1 to add at 3
    expect(regions[0].sides[0].startIdx).toBe(1)
    expect(regions[0].sides[0].endIdx).toBe(3)
  })

  it('handles unterminated conflict at EOF', () => {
    const lines: DiffLine[] = [
      addLine('+<<<<<<< Conflict 1 of 1'),
      addLine('+%%%%%%% side #1'),
      addLine('+content'),
      // no >>>>>>> line
    ]
    const regions = findConflicts(lines)
    expect(regions).toHaveLength(1)
    expect(regions[0].startIdx).toBe(0)
    expect(regions[0].endIdx).toBe(2) // last line
    expect(regions[0].sides).toHaveLength(1)
  })

  it('handles empty snapshot side', () => {
    const lines: DiffLine[] = [
      addLine('+<<<<<<< Conflict 1 of 1'),
      addLine('+%%%%%%% Changes from base to side #1'),
      addLine('+content'),
      addLine('++++++++ Contents of side #2'),
      addLine('+>>>>>>> Conflict 1 of 1 ends'),
    ]
    const regions = findConflicts(lines)
    expect(regions).toHaveLength(1)
    expect(regions[0].sides).toHaveLength(2)
    // Empty snapshot: startIdx === endIdx (marker only)
    expect(regions[0].sides[1].startIdx).toBe(3)
    expect(regions[0].sides[1].endIdx).toBe(3)
  })

  it('ignores conflict-like text in context lines', () => {
    const lines: DiffLine[] = [
      ctxLine(' <<<<<<< this is just content'),
      ctxLine(' >>>>>>> also content'),
    ]
    expect(findConflicts(lines)).toEqual([])
  })

  it('handles conflict with only diff section (no snapshot)', () => {
    // Edge case: only one side
    const lines: DiffLine[] = [
      addLine('+<<<<<<< Conflict 1 of 1'),
      addLine('+%%%%%%% Changes from base to side #1'),
      addLine('+content'),
      addLine('+>>>>>>> Conflict 1 of 1 ends'),
    ]
    const regions = findConflicts(lines)
    expect(regions).toHaveLength(1)
    expect(regions[0].sides).toHaveLength(1)
    expect(regions[0].sides[0].type).toBe('diff')
  })

  it('extracts commit description as side label (no \\ sub-marker)', () => {
    // Without a \\\\\\\ "to:" sub-marker, the %%%%%%% "from" label stays.
    const lines: DiffLine[] = [
      addLine('+<<<<<<< Conflict 1 of 1'),
      addLine('+%%%%%%% diff from: lpymxuwk 75ef1147 "Conflict resolution"'),
      addLine('+content'),
      addLine('++++++++ wlykovwr 562576c8 "side Y: modify existing file differently"'),
      addLine('+content2'),
      addLine('+>>>>>>> Conflict 1 of 1 ends'),
    ]
    const regions = findConflicts(lines)
    expect(regions[0].sides[0].label).toBe('Conflict resolution')
    expect(regions[0].sides[1].label).toBe('side Y: modify existing file differently')
  })

  it('diff side label is the "to" commit, not "from" (\\ sub-marker overwrites)', () => {
    // CRITICAL SEMANTICS: :ours/:theirs keeps the side's RESULT state.
    // For %%%%%%% diff sides, that's the "to" commit (\\\\\\\ marker),
    // NOT the "from" commit (%%%%%%% marker). The button must say
    // "Keep <to>" so users know what they're choosing.
    const lines: DiffLine[] = [
      addLine('+<<<<<<< Conflict 1 of 1'),
      addLine('+%%%%%%% diff from: aaaa1111 "the base state"'),
      addLine('+\\\\\\\\\\\\\\        to: bbbb2222 "the result state"'),
      addLine('+-removed'),
      addLine('++added'),
      addLine('++++++++ cccc3333 "other side"'),
      addLine('+snapshot content'),
      addLine('+>>>>>>> Conflict 1 of 1 ends'),
    ]
    const regions = findConflicts(lines)
    expect(regions[0].sides[0].type).toBe('diff')
    expect(regions[0].sides[0].label).toBe('the result state')  // what :ours KEEPS — NOT "the base state"
    expect(regions[0].sides[1].type).toBe('snapshot')
    expect(regions[0].sides[1].label).toBe('other side')         // what :theirs KEEPS
  })

  it('falls back to raw marker text when no quoted description', () => {
    const lines: DiffLine[] = [
      addLine('+<<<<<<< Conflict 1 of 1'),
      addLine('+%%%%%%% Changes from base to side #1'),
      addLine('+content'),
      addLine('++++++++ Contents of side #2'),
      addLine('+content2'),
      addLine('+>>>>>>> Conflict 1 of 1 ends'),
    ]
    const regions = findConflicts(lines)
    expect(regions[0].sides[0].label).toBe('Changes from base to side #1')
    expect(regions[0].sides[1].label).toBe('Contents of side #2')
  })

  it('parses 3-way conflict (2 diff + 1 snapshot)', () => {
    const lines = [
      addLine('+<<<<<<< Conflict 1 of 1'),
      addLine('+%%%%%%% diff from: "side A"'),
      addLine('+-old line A'),
      addLine('++new line A'),
      addLine('+%%%%%%% diff from: "side B"'),
      addLine('+-old line B'),
      addLine('++new line B'),
      addLine('++++++++ "side C"'),
      addLine('+content from C'),
      addLine('+>>>>>>> Conflict 1 of 1 ends'),
    ]
    const regions = findConflicts(lines)
    expect(regions).toHaveLength(1)
    expect(regions[0].sides).toHaveLength(3)
    expect(regions[0].sides[0].type).toBe('diff')
    expect(regions[0].sides[1].type).toBe('diff')
    expect(regions[0].sides[2].type).toBe('snapshot')
    // Side boundaries are correct
    expect(regions[0].sides[0].startIdx).toBe(1)
    expect(regions[0].sides[0].endIdx).toBe(3)
    expect(regions[0].sides[1].startIdx).toBe(4)
    expect(regions[0].sides[1].endIdx).toBe(6)
    expect(regions[0].sides[2].startIdx).toBe(7)
    expect(regions[0].sides[2].endIdx).toBe(8)
  })

  // ── Marker escalation + false-match defenses ──────────────────────────────
  // Ported from conflict-extract.test.ts now that both parsers run on the
  // shared scanner (conflict-markers.ts). The diff side historically used
  // fixed {7} regexes and had every bug class its sibling defended against.

  it('handles escalated marker length (8+ chars) with clean labels', () => {
    // jj escalates when file content has 7-char lookalikes. The old {7} regex
    // matched only the first 7 chars → the 8th leaked into the label.
    const lines: DiffLine[] = [
      addLine('+<<<<<<<< Conflict 1 of 1'),
      addLine('+%%%%%%%% Changes from base to side #1'),
      addLine('++side 1'),
      addLine('+++++++++ Contents of side #2'),  // 8-char marker + diff prefix
      addLine('+side 2'),
      addLine('+>>>>>>>> Conflict 1 of 1 ends'),
    ]
    const regions = findConflicts(lines)
    expect(regions).toHaveLength(1)
    expect(regions[0].label).toBe('Conflict 1 of 1')  // not '< Conflict 1 of 1'
    expect(regions[0].endIdx).toBe(5)
    expect(regions[0].sides).toHaveLength(2)
    expect(regions[0].sides[0].type).toBe('diff')
    expect(regions[0].sides[0].label).toBe('Changes from base to side #1')
    expect(regions[0].sides[1].type).toBe('snapshot')
    expect(regions[0].sides[1].label).toBe('Contents of side #2')
  })

  it('escalated region: shorter `<` run inside is content, not a region restart', () => {
    // The file contains a 7-char `<<<<<<<` line — the very reason jj escalated
    // to 8. The old fixed-{7} regex re-matched that content line → flushed the
    // real region and started a bogus second one.
    const lines: DiffLine[] = [
      addLine('+<<<<<<<< Conflict 1 of 1'),
      addLine('+++++++++ Side 1'),
      addLine('+<<<<<<<'),          // CONTENT: 7-char run < marker width 8
      addLine('+ours rest'),
      addLine('+++++++++ Side 2'),
      addLine('+theirs'),
      addLine('+>>>>>>>> Conflict 1 of 1 ends'),
    ]
    const regions = findConflicts(lines)
    expect(regions).toHaveLength(1)            // NOT two flushed fragments
    expect(regions[0].sides).toHaveLength(2)
    // The lookalike stays inside side 1's range as content.
    expect(regions[0].sides[0].startIdx).toBe(1)
    expect(regions[0].sides[0].endIdx).toBe(3)
    expect(regions[0].sides[1].startIdx).toBe(4)
    expect(regions[0].sides[1].endIdx).toBe(5)
  })

  it('escalated markers: 7-dash content in a snapshot section is not a marker', () => {
    // A `-------` markdown HR inside a snapshot side. Markers are 8 chars
    // BECAUSE of that line — exact-width matching keeps it as content.
    const lines: DiffLine[] = [
      addLine('+<<<<<<<<'),
      addLine('+++++++++ Side 1'),
      addLine('+line above'),
      addLine('+-------'),          // CONTENT: 7 dashes ≠ marker width 8
      addLine('+line below'),
      addLine('+++++++++ Side 2'),
      addLine('+theirs'),
      addLine('+>>>>>>>>'),
    ]
    const regions = findConflicts(lines)
    expect(regions).toHaveLength(1)
    expect(regions[0].sides).toHaveLength(2)
    expect(regions[0].sides[0].endIdx).toBe(4)  // dash line stays inside side 1
  })

  it('diff-prefixed plus content does not become a snapshot side (escalated)', () => {
    // Inside a %%%%%%%% diff section, an added content line of 6 plus chars
    // gets a conflict `+` prefix (7 chars) and a diff `+` prefix (8 in the
    // diff). With 8-char markers, exact width + the diff-mode label rule keep
    // it as content.
    const lines: DiffLine[] = [
      addLine('+<<<<<<<<'),
      addLine('+%%%%%%%% Changes from base to side #1'),
      addLine('+ context'),
      addLine('++++++++'),           // 7 plus after strip — content, not a side
      addLine('+ more context'),
      addLine('+++++++++ Contents of side #2'),
      addLine('+theirs'),
      addLine('+>>>>>>>>'),
    ]
    const regions = findConflicts(lines)
    expect(regions).toHaveLength(1)
    expect(regions[0].sides).toHaveLength(2)   // NOT three
    expect(regions[0].sides[0].type).toBe('diff')
    expect(regions[0].sides[0].endIdx).toBe(4)
    expect(regions[0].sides[1].type).toBe('snapshot')
    expect(regions[0].sides[1].startIdx).toBe(5)
  })

  it('bare 7-plus run inside a 7-char diff section is content, not a side (label rule)', () => {
    // Non-escalated variant: markers are 7 chars and the false-match candidate
    // is also 7 chars — width alone can't disambiguate. Real jj side markers
    // always carry a label; a bare run inside a diff section never does.
    const lines: DiffLine[] = [
      addLine('+<<<<<<< Conflict 1 of 1'),
      addLine('+%%%%%%% Changes from base to side #1'),
      addLine('+ ctx'),
      addLine('++++++++'),                       // raw `+++++++`, no label — content
      addLine('++++++++ Contents of side #2'),   // raw `+++++++ Contents…` — real marker
      addLine('+theirs'),
      addLine('+>>>>>>> Conflict 1 of 1 ends'),
    ]
    const regions = findConflicts(lines)
    expect(regions).toHaveLength(1)
    expect(regions[0].sides).toHaveLength(2)
    expect(regions[0].sides[0].type).toBe('diff')
    expect(regions[0].sides[0].endIdx).toBe(3)   // bare-plus line is side 1 content
    expect(regions[0].sides[1].type).toBe('snapshot')
    expect(regions[0].sides[1].startIdx).toBe(4)
  })

  it('deleted dash-line inside a diff section does not match the base marker (mode gate)', () => {
    // Raw file: `-` conflict-diff prefix + `------` content = 7 dashes — the
    // exact width of the markers. The mode gate (base markers never follow a
    // %%%%%%% section) is the only defense; width matching can't help here.
    const lines: DiffLine[] = [
      addLine('+<<<<<<< Conflict 1 of 1'),
      addLine('+%%%%%%% Changes from base to side #1'),
      addLine('+ context'),
      addLine('+-------'),           // 7 dashes after strip — content, not base
      addLine('++replacement'),
      addLine('++++++++ Contents of side #2'),
      addLine('+theirs'),
      addLine('+>>>>>>> Conflict 1 of 1 ends'),
    ]
    const regions = findConflicts(lines)
    expect(regions).toHaveLength(1)
    expect(regions[0].sides).toHaveLength(2)
    expect(regions[0].sides[0].endIdx).toBe(4)   // dash + replacement stay in side 1
  })

  it('snapshot-style base section is excluded from side ranges', () => {
    // Snapshot style (`-------` base block between the two `+++++++` sides).
    // Base lines belong to no pickable side — the badge ranges must not
    // attribute them to side 1.
    const lines: DiffLine[] = [
      addLine('+<<<<<<< Conflict 1 of 1'),
      addLine('++++++++ Contents of side #1'),
      addLine('+OURS'),
      addLine('+------- Contents of base'),
      addLine('+BASE'),
      addLine('++++++++ Contents of side #2'),
      addLine('+THEIRS'),
      addLine('+>>>>>>> Conflict 1 of 1 ends'),
    ]
    const regions = findConflicts(lines)
    expect(regions).toHaveLength(1)
    expect(regions[0].sides).toHaveLength(2)
    expect(regions[0].sides[0].startIdx).toBe(1)
    expect(regions[0].sides[0].endIdx).toBe(2)   // ends BEFORE the base marker
    expect(regions[0].sides[1].startIdx).toBe(5)
    expect(regions[0].sides[1].endIdx).toBe(6)
  })

  it('parses multiple conflict regions in one file', () => {
    const lines = [
      addLine('+<<<<<<< Conflict 1 of 2'),
      addLine('+%%%%%%% "first diff"'),
      addLine('+-a'),
      addLine('++++++++ "first snap"'),
      addLine('+b'),
      addLine('+>>>>>>> Conflict 1 of 2 ends'),
      { type: 'add' as const, content: '+normal line between conflicts' },
      addLine('+<<<<<<< Conflict 2 of 2'),
      addLine('+%%%%%%% "second diff"'),
      addLine('+-c'),
      addLine('++++++++ "second snap"'),
      addLine('+d'),
      addLine('+>>>>>>> Conflict 2 of 2 ends'),
    ]
    const regions = findConflicts(lines)
    expect(regions).toHaveLength(2)
    expect(regions[0].label).toBe('Conflict 1 of 2')
    expect(regions[1].label).toBe('Conflict 2 of 2')
    expect(regions[0].sides).toHaveLength(2)
    expect(regions[1].sides).toHaveLength(2)
  })
})

import type { DiffFile, DiffHunk, DiffLine } from './diff-parser'

/** Extract context lines from a full-context hunk for newLine range [from, to).
 *  Walks the lines array with a running newLine counter (remove lines don't
 *  advance newLine). Only context lines are returned — add/remove lines in the
 *  range belong to an original hunk, not a gap. */
function sliceContext(full: DiffHunk, from: number, to: number): DiffLine[] {
  const out: DiffLine[] = []
  let newLine = full.newStart
  for (const line of full.lines) {
    if (newLine >= to) break
    if (line.type === 'context' && newLine >= from) out.push(line)
    if (line.type !== 'remove') newLine++
  }
  return out
}

export interface ExpandedDiff {
  file: DiffFile
  /** gapMap[i] = ORIGINAL gap index for effective (post-merge) gap i.
   *  When hunks merge, effective indices shift; DiffFileView uses this to
   *  call onexpand with the right original index. Length = file.hunks.length+1. */
  gapMap: number[]
}

/** Merge revealed gaps into the original diff.
 *  Gap i sits BEFORE hunk[i]; gap hunks.length is after the last hunk.
 *  A revealed gap fills with context from `full` and MERGES the hunks on
 *  either side into one — revealing all gaps yields the full-context diff. */
export function expandGaps(
  original: DiffFile,
  full: DiffFile,
  gaps: ReadonlySet<number>,
): ExpandedDiff {
  const N = original.hunks.length
  const identityMap = Array.from({ length: N + 1 }, (_, i) => i)
  if (gaps.size === 0 || full.hunks.length === 0) {
    return { file: original, gapMap: identityMap }
  }
  const fullHunk = full.hunks[0]
  const merged: DiffHunk[] = []
  const gapMap: number[] = []
  let cur: DiffHunk | null = null

  const prevEnd = (i: number) =>
    i === 0 ? 1 : original.hunks[i - 1].newStart + original.hunks[i - 1].newCount

  for (let i = 0; i < N; i++) {
    const h = original.hunks[i]
    if (gaps.has(i)) {
      const gap = sliceContext(fullHunk, prevEnd(i), h.newStart)
      if (cur) {
        cur.lines.push(...gap, ...h.lines)
        cur.newCount += gap.length + h.newCount
      } else {
        const start = prevEnd(i)
        // Gap-i revealed with no prior hunk — this new merged hunk starts at
        // the gap. The gap BEFORE it is still gap-i conceptually, but since
        // gap-i is revealed it won't render a button. Map to i so clicking
        // would be idempotent (already revealed).
        gapMap.push(i)
        cur = {
          header: `@@ -${start} +${start} @@`,
          oldStart: start,
          newStart: start,
          newCount: gap.length + h.newCount,
          lines: [...gap, ...h.lines],
        }
        merged.push(cur)
      }
    } else {
      gapMap.push(i)
      cur = { ...h, lines: [...h.lines] }
      merged.push(cur)
    }
  }

  gapMap.push(N)  // trailing gap always maps to N

  if (gaps.has(N) && cur) {
    const last = original.hunks[N - 1]
    const trailing = sliceContext(fullHunk, last.newStart + last.newCount, Infinity)
    cur.lines.push(...trailing)
    cur.newCount += trailing.length
  }

  return { file: { ...original, hunks: merged }, gapMap }
}

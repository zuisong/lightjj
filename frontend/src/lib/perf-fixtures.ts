// Synthetic diff fixtures for the perf benchmarks (diff-compute.bench.ts). Deterministic — no randomness, so runs are
// comparable across machines and across optimization passes.
//
// The generated code is real, parseable TypeScript/Go so Lezer's parse cost is
// representative (escaped-plaintext fallback would make highlight look free).
// Hunk shape mirrors a typical refactor diff: context runs, paired
// remove/add lines (small edits — the word-diff LCS sweet spot), and a few
// pure additions.

export interface GenFileSpec {
  path: string
  /** Approximate total diff lines (context + removes + adds) for this file. */
  lines: number
}

const TS_LINES = [
  (i: number) => `export function compute${i}(input: Record<string, number>, limit = ${(i % 50) + 1}): number {`,
  (i: number) => `  const items = Object.entries(input).filter(([key, value]) => value > ${i % 100} && key.length < limit)`,
  (i: number) => `  let total = items.reduce((acc, [, value]) => acc + value * ${(i % 7) + 1}, 0)`,
  (i: number) => `  if (total > limit) { total = Math.min(total, limit * ${(i % 13) + 1}) } // clamp to budget`,
  (i: number) => `  const label = \`result-\${total.toFixed(2)}-${i}\``,
  (i: number) => `  console.debug('computed', { label, total, count: items.length })`,
  (i: number) => `  return total + ${i % 31}`,
  () => `}`,
]

const GO_LINES = [
  (i: number) => `func Compute${i}(input map[string]int, limit int) (int, error) {`,
  (i: number) => `\ttotal := 0`,
  (i: number) => `\tfor key, value := range input {`,
  (i: number) => `\t\tif value > ${i % 100} && len(key) < limit {`,
  (i: number) => `\t\t\ttotal += value * ${(i % 7) + 1} // weighted by bucket ${i % 7}`,
  () => `\t\t}`,
  () => `\t}`,
  (i: number) => `\treturn total + ${i % 31}, nil`,
]

function sourceLine(path: string, i: number): string {
  const gens = path.endsWith('.go') ? GO_LINES : TS_LINES
  return gens[i % gens.length](i)
}

/** A small textual edit to a source line — what a real refactor diff looks
 *  like, and what keeps word-diff LCS on its realistic (mostly-equal) path. */
function editedLine(line: string, i: number): string {
  return line
    .replace(/limit/g, 'budget')
    .replace(/total/g, `total${i % 3 === 0 ? 'Sum' : ''}`)
}

/**
 * Generate a unified git-style diff for one file. Hunk shape (≈46 diff lines):
 * 12 context · 8 remove/add pairs (edited lines) · 6 pure adds · 12 context,
 * with a 20-line unrendered gap between hunks (so context-expansion gaps exist).
 */
export function genFileDiff(spec: GenFileSpec): string {
  const LINES_PER_HUNK = 46
  const hunkCount = Math.max(1, Math.round(spec.lines / LINES_PER_HUNK))
  const out: string[] = [
    `diff --git a/${spec.path} b/${spec.path}`,
    `--- a/${spec.path}`,
    `+++ b/${spec.path}`,
  ]
  let oldLine = 1
  let newLine = 1
  let src = 0
  for (let h = 0; h < hunkCount; h++) {
    // skip a gap between hunks
    oldLine += 20
    newLine += 20
    src += 20
    const oldCount = 12 + 8 + 12
    const newCount = 12 + 8 + 6 + 12
    out.push(`@@ -${oldLine},${oldCount} +${newLine},${newCount} @@ ${sourceLine(spec.path, src)}`)
    for (let c = 0; c < 12; c++) out.push(' ' + sourceLine(spec.path, src + c))
    src += 12
    for (let p = 0; p < 8; p++) out.push('-' + sourceLine(spec.path, src + p))
    for (let p = 0; p < 8; p++) out.push('+' + editedLine(sourceLine(spec.path, src + p), src + p))
    src += 8
    for (let a = 0; a < 6; a++) out.push('+' + editedLine(sourceLine(spec.path, src + a), src + a + 1))
    for (let c = 0; c < 12; c++) out.push(' ' + sourceLine(spec.path, src + 6 + c))
    src += 18
    oldLine += oldCount
    newLine += newCount
  }
  return out.join('\n') + '\n'
}

/** Multi-file diff: `count` files of `linesEach` diff lines. */
export function genDiff(files: GenFileSpec[]): string {
  return files.map(genFileDiff).join('')
}

/** Convenience: n files named src/gen/file<i>.ts of equal size. */
export function tsFiles(count: number, linesEach: number): GenFileSpec[] {
  return Array.from({ length: count }, (_, i) => ({ path: `src/gen/file${i}.ts`, lines: linesEach }))
}

/** Plain source lines (no diff markers) — for highlightLines benchmarks. */
export function genSourceLines(path: string, count: number): string[] {
  return Array.from({ length: count }, (_, i) => sourceLine(path, i))
}

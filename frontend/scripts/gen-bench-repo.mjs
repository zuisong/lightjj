#!/usr/bin/env node
// Generates source-file states for the lightjj diff-render benchmark repo.
// Usage: node gen-bench-repo.mjs <repoDir> <state>
//   state = base | small | medium | large | huge | wide
//
// Each state rewrites the tracked .ts files; commit each state as a sibling of
// `base` (see docs/design-notes/diff-perf-benchmarks.md) so each revision's
// diff-vs-base has a known measured size (total hunk lines incl. context, the
// quantity DiffPanel's totalDiffLines counts):
//   small  ≈   533 diff lines (1 file, light edits)
//   medium ≈ 3,800 diff lines (4 files, dense edits)
//   wide   ≈ 4,700 diff lines (25 files × ~215 lines — under the per-file
//            compute caps, so highlight + word-diff fully run)
//   large  ≈ 19,000 diff lines (16-20 files, dense edits)
//   huge   ≈ 38,800 diff lines (all files + 5 new 2k-line files)

import { mkdirSync, writeFileSync } from 'fs'
import { join } from 'path'

const [repoDir, state] = process.argv.slice(2)
if (!repoDir || !state) { console.error('usage: gen-bench-repo.mjs <repoDir> <state>'); process.exit(1) }

const FILES = 25
const LINES_PER_FILE = 800

const TS_LINES = [
  (i) => `export function compute${i}(input: Record<string, number>, limit = ${(i % 50) + 1}): number {`,
  (i) => `  const items = Object.entries(input).filter(([key, value]) => value > ${i % 100} && key.length < limit)`,
  (i) => `  let total = items.reduce((acc, [, value]) => acc + value * ${(i % 7) + 1}, 0)`,
  (i) => `  if (total > limit) { total = Math.min(total, limit * ${(i % 13) + 1}) } // clamp to budget`,
  (i) => `  const label = \`result-\${total.toFixed(2)}-${i}\``,
  (i) => `  console.debug('computed', { label, total, count: items.length })`,
  (i) => `  return total + ${i % 31}`,
  () => `}`,
]

function srcLine(i, edit) {
  let line = TS_LINES[i % TS_LINES.length](i)
  if (edit) {
    line = line.replace(/limit/g, 'budget').replace(/total/g, 'totalSum').replace(/value/g, 'weight')
  }
  return line
}

// editEvery: replace every Nth line (paired remove/add in the diff, spread out
// so hunks are realistic). 0 = untouched.
function genFile(fileIdx, lines, editEvery) {
  const out = []
  for (let i = 0; i < lines; i++) {
    const edit = editEvery > 0 && i % editEvery === 0
    out.push(srcLine(i + fileIdx * 7, edit))
  }
  return out.join('\n') + '\n'
}

// state → per-file editEvery (0 = untouched), plus extra new files for "huge".
function plan(state) {
  const edits = new Array(FILES).fill(0)
  let extraFiles = 0
  switch (state) {
    case 'base': break
    case 'small': edits[0] = 12; break                       // ~70 pairs ≈ 200 diff lines w/ context
    case 'medium': for (let i = 0; i < 4; i++) edits[i] = 4; break    // 4 files × 200 pairs ≈ 2k
    case 'large': for (let i = 0; i < 20; i++) edits[i] = 4; break    // 20 files × 200 pairs ≈ 10k
    case 'huge': for (let i = 0; i < FILES; i++) edits[i] = 2; extraFiles = 5; break // ≈ 38.8k
    // wide: every file lightly edited (every 30th line) → ~215 diff lines and
    // ~13k chars per file — UNDER the per-file compute caps, so this is the
    // "many moderate files" shape where highlight + word-diff + full DOM all run.
    case 'wide': for (let i = 0; i < FILES; i++) edits[i] = 30; break
    default: console.error(`unknown state ${state}`); process.exit(1)
  }
  return { edits, extraFiles }
}

const { edits, extraFiles } = plan(state)
const srcDir = join(repoDir, 'src')
mkdirSync(srcDir, { recursive: true })
for (let f = 0; f < FILES; f++) {
  writeFileSync(join(srcDir, `module${String(f).padStart(2, '0')}.ts`), genFile(f, LINES_PER_FILE, edits[f]))
}
for (let f = 0; f < extraFiles; f++) {
  writeFileSync(join(srcDir, `extra${f}.ts`), genFile(100 + f, 2000, 0))
}
console.log(`wrote state=${state} (${FILES} files${extraFiles ? ` + ${extraFiles} extra` : ''})`)

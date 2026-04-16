// Diff parsing utilities — extracts structured data from unified diff output

export interface DiffLine {
  type: 'add' | 'remove' | 'context' | 'header'
  /** Display-ready: tabs expanded to spaces (issue #9). */
  content: string
  /** Original line including diff marker — only set when it differs from
   *  content (i.e., line had tabs). Write-back paths must prefer this. */
  raw?: string
}

export interface DiffHunk {
  header: string
  oldStart: number  // line number where this hunk starts in the old file
  newStart: number  // line number where this hunk starts in the new file
  newCount: number  // number of lines in the new file version
  lines: DiffLine[]
}

export interface DiffFile {
  header: string
  filePath: string
  // Source path for pure renames (from `rename from <path>` in git-diff header).
  // Only present when jj emits an explicit rename record — rename-with-edits
  // decomposes into separate A+D entries instead. Used by Discard to pass BOTH
  // paths to `jj restore -c`: dest-only would delete the new path without
  // restoring the source, turning the rename into a delete.
  sourcePath?: string
  hunks: DiffHunk[]
}

export function expandTabs(s: string, width = 4): string {
  if (!s.includes('\t')) return s
  let out = ''
  let col = 0
  for (const ch of s) {
    if (ch === '\t') {
      const n = width - (col % width)
      out += ' '.repeat(n)
      col += n
    } else {
      out += ch
      col++
    }
  }
  return out
}

export function parseDiffContent(raw: string): DiffFile[] {
  if (!raw) return []

  const files: DiffFile[] = []
  const lines = raw.split('\n')
  let currentFile: DiffFile | null = null
  let currentHunk: DiffHunk | null = null

  for (const line of lines) {
    if (line.startsWith('diff --git') || line.startsWith('=== ') || line.startsWith('Modified ') || line.startsWith('Added ') || line.startsWith('Deleted ') || line.startsWith('Copied ') || line.startsWith('Renamed ')) {
      // jj uses different diff headers than git
      currentFile = { header: line, filePath: '', hunks: [] }
      files.push(currentFile)
      currentHunk = null
    } else if (line.startsWith('@@')) {
      const hunkMatch = line.match(/^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,(\d+))? @@/)
      currentHunk = {
        header: line,
        oldStart: hunkMatch ? parseInt(hunkMatch[1]) : 1,
        newStart: hunkMatch ? parseInt(hunkMatch[2]) : 1,
        newCount: hunkMatch ? parseInt(hunkMatch[3] ?? '1') : 1,
        lines: [],
      }
      if (currentFile) {
        currentFile.hunks.push(currentHunk)
      } else {
        currentFile = { header: '(unknown file)', filePath: '(unknown file)', hunks: [currentHunk] }
        files.push(currentFile)
      }
    } else if (line.startsWith('---') || line.startsWith('+++')) {
      // file markers — attach to current file header
      if (currentFile) {
        currentFile.header += '\n' + line
      }
    } else if (currentFile && line.startsWith('rename from ')) {
      currentFile.sourcePath = line.slice('rename from '.length)
      currentFile.header += '\n' + line
    } else if (currentHunk) {
      // Expand tabs in the SOURCE portion (after the +/-/space marker) for
      // display. CSS tab stops are measured from the block's content edge, so
      // the gutter width eats into the first tab and renders it ~1ch wide
      // (issue #9). `raw` preserves the original for write-back paths
      // (hunk-apply) — set only when expansion actually changed the string.
      const src = line.slice(1)
      const expanded = expandTabs(src)
      const dl: DiffLine = { type: 'context', content: (line[0] ?? '') + expanded }
      if (line.startsWith('+')) dl.type = 'add'
      else if (line.startsWith('-')) dl.type = 'remove'
      if (expanded !== src) dl.raw = line
      currentHunk.lines.push(dl)
    } else if (currentFile && line.trim()) {
      // Lines between file header and first hunk (e.g. "Binary file..." or index lines)
      currentFile.header += '\n' + line
    }
  }

  // Compute filePath for each file now that headers are fully assembled
  for (const file of files) {
    if (!file.filePath) {
      file.filePath = filePathFromHeader(file.header)
    }
    // Reconcile newCount with actual parsed lines. context-expand.ts uses
    // newStart+newCount for gap boundaries; a header/content mismatch
    // (truncated diff, malformed input) would duplicate lines on expand.
    for (const h of file.hunks) {
      h.newCount = h.lines.filter(l => l.type !== 'remove').length
    }
  }

  return files
}

// Extract file path from diff header for matching with changedFiles.
// Uses the b/ (destination) path from git-style headers to handle copies/renames
// correctly — the a/ path is the source and can appear in multiple diff entries.
export function filePathFromHeader(header: string): string {
  // jj headers: "Modified regular file src/main.go:" or "Added regular file new.go:" etc.
  // Also git-style: "diff --git a/file b/file"
  const firstLine = header.split('\n')[0]
  // Match jj-style: "Modified regular file path/to/file:"
  const jjMatch = firstLine.match(/^(?:Modified|Added|Deleted|Copied|Renamed)\s+(?:regular\s+)?file\s+(.+?)(?::)?$/)
  if (jjMatch) return jjMatch[1]
  // Match git-style: "diff --git a/source b/destination"
  // Use b/ (destination) to avoid duplicate keys on copies/renames
  const gitMatch = firstLine.match(/^diff --git a\/.+? b\/(.+)$/)
  if (gitMatch) return gitMatch[1]
  return firstLine
}

// New-side line numbers that are additions. Same hunk-walk as lineContentAt
// (annotations.svelte.ts): count from newStart, advance on add/context, skip
// remove. Used by markdown preview's diff gutter — preview renders the NEW
// content, so removed lines don't exist to mark; only "added" is meaningful.
export function newSideAddedLines(hunks: readonly DiffHunk[]): Set<number> {
  const s = new Set<number>()
  for (const h of hunks) {
    let n = h.newStart
    for (const l of h.lines) {
      if (l.type === 'add') s.add(n++)
      else if (l.type === 'context') n++
    }
  }
  return s
}

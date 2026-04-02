import { parseJJVersion } from './api'

/** Per-feature jj version gates. Each entry is the FIRST jj release that
 *  supports the capability + a short label for the startup warning.
 *  Backend has a parallel table (internal/jj/version.go) for gates that
 *  pick between command-builder codepaths — the two tables don't share
 *  entries (frontend gates UI affordances, backend gates jj args). */
export const JJ_FEATURES = {
  indexChangedPaths: { min: [0, 30], label: 'file-history index' },
  // workspaceRootTmpl is backend-only (template selection); listed here so
  // the startup warning mentions it — users on 0.39 see fewer workspace
  // paths in the dropdown (additive-only protobuf store gap).
  workspaceRootTmpl: { min: [0, 40], label: 'complete workspace paths' },
} as const satisfies Record<string, { min: readonly [number, number]; label: string }>

export type JJFeature = keyof typeof JJ_FEATURES

let detected = $state<readonly [number, number] | null>(null)

/** Set by App.svelte from api.info().jj_version once at startup. */
export function setDetectedJJVersion(raw: string): void {
  const v = parseJJVersion(raw)
  detected = v ? [v[0], v[1]] : null
}

/** Whether the detected jj supports `feature`. Reactive (reads $state).
 *  Unknown version (parse failure / not yet loaded) → TRUE: optimistic so
 *  dev builds and the ~50ms pre-loadInfo window don't hide UI. A wrong
 *  guess surfaces as jj's own error toast — recoverable. (Contrast backend
 *  jjSupports: pessimistic, since a wrong guess there is a 500.) */
export function jjSupports(feature: JJFeature): boolean {
  if (!detected) return true
  const [maj, min] = JJ_FEATURES[feature].min
  return detected[0] > maj || (detected[0] === maj && detected[1] >= min)
}

/** Labels of features the detected jj is missing — drives the startup
 *  warning. Empty until setDetectedJJVersion runs (optimistic). */
export function missingJJFeatures(): string[] {
  if (!detected) return []
  return (Object.keys(JJ_FEATURES) as JJFeature[])
    .filter(f => !jjSupports(f))
    .map(f => `${JJ_FEATURES[f].label} (≥${JJ_FEATURES[f].min.join('.')})`)
}

export function detectedJJVersion(): readonly [number, number] | null {
  return detected
}

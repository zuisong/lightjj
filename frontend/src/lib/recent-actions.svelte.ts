// Generic frequency tracker. Stored server-side via config — `localhost:0`
// randomizes port every launch so the old localStorage storage was cold each
// session. config.svelte.ts already persists to $XDG_CONFIG_HOME/lightjj/
// config.json; piggybacking gets port-survival + the same 500ms debounce.
//
// Usage: const history = recentActions('namespace')
// history.record('key')   — increment count
// history.count('key')    — get frequency (0 if never used)
// history.clear()         — reset all counts

import { config } from './config.svelte'

const MAX_ENTRIES = 200

export function recentActions(namespace: string) {
  const bucket = () => config.recentActions[namespace] ?? {}

  function write(data: Record<string, number>) {
    const entries = Object.entries(data)
    if (entries.length > MAX_ENTRIES) {
      entries.sort((a, b) => b[1] - a[1])
      data = Object.fromEntries(entries.slice(0, MAX_ENTRIES))
    }
    // Spread triggers the config setter → $effect → debounced disk write.
    config.recentActions = { ...config.recentActions, [namespace]: data }
  }

  return {
    record(key: string) {
      const data = { ...bucket() }
      data[key] = (data[key] ?? 0) + 1
      write(data)
    },

    count(key: string): number {
      return bucket()[key] ?? 0
    },

    /** One-shot read of all counts. Prefer this over count() in sort
     *  comparators — count() re-reads the reactive source per call. */
    snapshot(): Record<string, number> {
      return bucket()
    },

    clear() {
      const { [namespace]: _, ...rest } = config.recentActions
      config.recentActions = rest
    },
  }
}

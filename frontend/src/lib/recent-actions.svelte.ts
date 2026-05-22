// Generic last-used tracker. Stored server-side via config — `localhost:0`
// randomizes port every launch so the old localStorage storage was cold each
// session. config.svelte.ts already persists to $XDG_CONFIG_HOME/lightjj/
// config.json; piggybacking gets port-survival + the same 500ms debounce.
//
// Values are Date.now() timestamps (recency, not frequency) — "what did I
// touch last" ages out naturally, where a frequency count lets a long-time
// favourite (main) sit on top forever. Values persisted by the old
// frequency-counter version read as ancient timestamps: they never rank as
// recent and are evicted first, so no migration is needed.
//
// Usage: const history = recentActions('namespace')
// history.record('key')   — stamp key with the current time
// history.snapshot()      — one-shot read of all last-used timestamps
// history.clear()         — reset the namespace

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
      write({ ...bucket(), [key]: Date.now() })
    },

    /** One-shot read of all last-used timestamps. Prefer this over per-key
     *  reads in sort comparators — the bucket is a reactive source. */
    snapshot(): Record<string, number> {
      return bucket()
    },

    clear() {
      const { [namespace]: _, ...rest } = config.recentActions
      config.recentActions = rest
    },
  }
}

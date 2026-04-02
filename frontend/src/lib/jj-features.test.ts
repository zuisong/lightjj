import { describe, it, expect } from 'vitest'
import { setDetectedJJVersion, jjSupports, missingJJFeatures, detectedJJVersion } from './jj-features.svelte'

// Module-level $state means tests share `detected`; each test sets it
// explicitly so order doesn't matter (the "optimistic on null" case is
// covered by the unparseable test, which is the only path to null in prod).
describe('jj-features', () => {
  it('0.29 → indexChangedPaths unsupported, listed as missing', () => {
    setDetectedJJVersion('jj 0.29.0')
    expect(detectedJJVersion()).toEqual([0, 29])
    expect(jjSupports('indexChangedPaths')).toBe(false)
    expect(jjSupports('workspaceRootTmpl')).toBe(false)
    const missing = missingJJFeatures()
    expect(missing).toContain('file-history index (≥0.30)')
    expect(missing).toContain('complete workspace paths (≥0.40)')
  })

  it('0.39 → indexChangedPaths supported, workspaceRootTmpl not', () => {
    setDetectedJJVersion('jj 0.39.0')
    expect(jjSupports('indexChangedPaths')).toBe(true)
    expect(jjSupports('workspaceRootTmpl')).toBe(false)
    expect(missingJJFeatures()).toEqual(['complete workspace paths (≥0.40)'])
  })

  it('0.40 → all current gates pass', () => {
    setDetectedJJVersion('jj 0.40.0')
    expect(jjSupports('indexChangedPaths')).toBe(true)
    expect(jjSupports('workspaceRootTmpl')).toBe(true)
    expect(missingJJFeatures()).toEqual([])
  })

  it('nightly suffix parses', () => {
    setDetectedJJVersion('jj 0.41.0-nightly+abc')
    expect(detectedJJVersion()).toEqual([0, 41])
    expect(jjSupports('workspaceRootTmpl')).toBe(true)
  })

  it('unparseable → optimistic (true), missing=[]', () => {
    setDetectedJJVersion('garbage')
    expect(detectedJJVersion()).toBeNull()
    expect(jjSupports('indexChangedPaths')).toBe(true)
    expect(missingJJFeatures()).toEqual([])
  })
})

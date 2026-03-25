import { describe, it, expect, vi, beforeEach } from 'vitest'
import { parseSemver, semverGt, semverMinorGt, checkForUpdate, _resetUpdateCheck } from './version'

describe('parseSemver', () => {
  it('parses x.y.z', () => {
    expect(parseSemver('1.2.3')).toEqual({ major: 1, minor: 2, patch: 3 })
  })
  it('parses with trailing junk', () => {
    expect(parseSemver('1.2.3-rc1')).toEqual({ major: 1, minor: 2, patch: 3 })
  })
  it('rejects malformed', () => {
    expect(parseSemver('v1.2')).toBeNull()
    expect(parseSemver('')).toBeNull()
  })
})

describe('semverGt', () => {
  const v = (s: string) => parseSemver(s)!
  it('compares major', () => expect(semverGt(v('2.0.0'), v('1.9.9'))).toBe(true))
  it('compares minor', () => expect(semverGt(v('1.3.0'), v('1.2.9'))).toBe(true))
  it('compares patch', () => expect(semverGt(v('1.2.4'), v('1.2.3'))).toBe(true))
  it('equal is not gt', () => expect(semverGt(v('1.2.3'), v('1.2.3'))).toBe(false))
})

describe('semverMinorGt', () => {
  const v = (s: string) => parseSemver(s)!
  it('ignores patch', () => expect(semverMinorGt(v('1.2.9'), v('1.2.0'))).toBe(false))
  it('minor bump is gt', () => expect(semverMinorGt(v('1.3.0'), v('1.2.9'))).toBe(true))
})

describe('checkForUpdate', () => {
  const mockFetch = vi.fn()
  beforeEach(() => {
    vi.stubGlobal('fetch', mockFetch)
    mockFetch.mockReset()
    _resetUpdateCheck()
  })

  const ghResponse = (tag: string, ok = true) => ({
    ok,
    json: () => Promise.resolve({ tag_name: tag }),
  })

  it('caches successful result', async () => {
    mockFetch.mockResolvedValue(ghResponse('v99.0.0'))
    const a = await checkForUpdate()
    const b = await checkForUpdate()
    expect(mockFetch).toHaveBeenCalledTimes(1)
    expect(a).toEqual(b)
    expect(a?.latest).toBe('99.0.0')
  })

  it('caches null when up-to-date', async () => {
    mockFetch.mockResolvedValue(ghResponse('v0.0.0'))
    await checkForUpdate()
    await checkForUpdate()
    expect(mockFetch).toHaveBeenCalledTimes(1)
  })

  it('clears memo on non-ok response → retries', async () => {
    mockFetch.mockResolvedValueOnce(ghResponse('', false))
    mockFetch.mockResolvedValueOnce(ghResponse('v99.0.0'))
    expect(await checkForUpdate()).toBeNull()
    expect((await checkForUpdate())?.latest).toBe('99.0.0')
    expect(mockFetch).toHaveBeenCalledTimes(2)
  })

  it('clears memo on network error → retries', async () => {
    mockFetch.mockRejectedValueOnce(new Error('offline'))
    mockFetch.mockResolvedValueOnce(ghResponse('v99.0.0'))
    expect(await checkForUpdate()).toBeNull()
    expect((await checkForUpdate())?.latest).toBe('99.0.0')
    expect(mockFetch).toHaveBeenCalledTimes(2)
  })
})

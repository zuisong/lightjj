import { describe, it, expect, vi } from 'vitest'
import { relativeTime, firstLine } from './time-format'

describe('relativeTime', () => {
  const NOW = new Date('2026-03-25T12:00:00.000-07:00').getTime()

  function ago(secs: number) {
    vi.setSystemTime(NOW)
    const d = new Date(NOW - secs * 1000)
    // jj format: "YYYY-MM-DD HH:MM:SS.mmm ±HH:MM". UTC methods + +00:00 so
    // the test is TZ-independent (local methods with hardcoded offset fail on
    // non-PDT runners).
    const pad = (n: number) => String(n).padStart(2, '0')
    return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())} ` +
           `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())}.000 +00:00`
  }

  it('buckets correctly', () => {
    expect(relativeTime(ago(30))).toBe('now')
    expect(relativeTime(ago(90))).toBe('1m')
    expect(relativeTime(ago(3600 * 2))).toBe('2h')
    expect(relativeTime(ago(86400 * 3))).toBe('3d')
    expect(relativeTime(ago(86400 * 60))).toBe('2mo')
    expect(relativeTime(ago(86400 * 400))).toBe('1y')
  })

  it('handles clock skew (negative secs → now)', () => {
    expect(relativeTime(ago(-100))).toBe('now')
  })

  it('handles malformed input', () => {
    expect(relativeTime(undefined)).toBe('')
    expect(relativeTime('not a timestamp')).toBe('')
  })
})

describe('firstLine', () => {
  it('returns first line only', () => {
    expect(firstLine('hello\nworld')).toBe('hello')
    expect(firstLine('single line')).toBe('single line')
    expect(firstLine('')).toBe('')
  })
})

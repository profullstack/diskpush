import { describe, expect, it } from 'vitest'
import { isNewer } from './self-update.js'

describe('isNewer', () => {
  it('compares numerically, not lexically', () => {
    // The bug this exists to prevent: "0.10.0" < "0.9.0" as strings.
    expect(isNewer('0.10.0', '0.9.0')).toBe(true)
    expect(isNewer('0.9.0', '0.10.0')).toBe(false)
  })

  it('is false for the same version', () => {
    expect(isNewer('1.2.3', '1.2.3')).toBe(false)
  })

  it('handles a shorter version string', () => {
    expect(isNewer('1.3', '1.2.9')).toBe(true)
    expect(isNewer('1.2', '1.2.1')).toBe(false)
  })

  it('does not treat an older release as newer', () => {
    expect(isNewer('0.1.0', '0.2.0')).toBe(false)
  })
})

import { describe, expect, it } from 'vitest'
import type { CleanerItem, CleanerReport } from './api'
import { plannedItems, selectedBytes, sizeLabel } from './cleaner'

const item = (id: string, over: Partial<CleanerItem> = {}): CleanerItem => ({
  id,
  category: 'build',
  safety: 'safe-if-idle',
  title: id,
  path: `/x/${id}`,
  bytes: 1000,
  upTo: false,
  eligible: true,
  why: '',
  suggested: null,
  risk: 2,
  score: 500,
  step: null,
  ...over,
})

describe('cleaner tab helpers', () => {
  it('ticks only planned, eligible, safe-class items', () => {
    const items = [item('a'), item('b', { eligible: false }), item('c', { safety: 'human', eligible: false }), item('d')]
    const report = { items, plan: { ids: ['a', 'b', 'c'], bytes: 0 } } as unknown as CleanerReport
    expect(plannedItems(report).map((i) => i.id)).toEqual(['a'])
  })

  it('never counts a needs-a-human item toward what will be freed', () => {
    const items = [item('a'), item('c', { safety: 'human', eligible: false, bytes: 1e12 })]
    expect(selectedBytes(items, new Set(['a', 'c']))).toBe(1000)
  })

  it('labels unknown and upper-bound sizes', () => {
    expect(sizeLabel(item('a', { bytes: -1 }))).toBe('?')
    expect(sizeLabel(item('a', { upTo: true }))).toMatch(/^≤ /)
  })
})

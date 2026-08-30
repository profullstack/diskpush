import { beforeEach, describe, expect, it, vi } from 'vitest'
import { clearDraft, EMPTY_DRAFT, readDraft, writeDraft } from './fleet-draft'

/** A stand-in for localStorage, since vitest runs this without a DOM. */
function installStorage(impl?: Partial<Storage>) {
  const data = new Map<string, string>()
  const storage = {
    getItem: (k: string) => data.get(k) ?? null,
    setItem: (k: string, v: string) => void data.set(k, v),
    removeItem: (k: string) => void data.delete(k),
    ...impl,
  }
  vi.stubGlobal('window', { localStorage: storage })
  return data
}

beforeEach(() => {
  vi.unstubAllGlobals()
})

describe('readDraft', () => {
  it('is empty when nothing was ever written', () => {
    installStorage()
    expect(readDraft()).toEqual(EMPTY_DRAFT)
  })

  it('round-trips what was written', () => {
    installStorage()
    const draft = {
      script: 'systemctl restart app.service',
      interpreter: 'bash' as const,
      sudo: true,
      concurrency: 7,
      timeoutSeconds: 45,
      stopOnError: true,
      label: 'restart-app',
      selected: ['id-web-01', 'id-web-03'],
    }
    writeDraft(draft)
    expect(readDraft()).toEqual(draft)
  })

  it('returns a blank draft rather than throwing on nonsense', () => {
    // Last week's shape after a schema change, or a half-written value.
    const data = installStorage()
    data.set('diskpush:fleet-draft:v1', '{not json')
    expect(readDraft()).toEqual(EMPTY_DRAFT)
  })

  it('falls back field by field, so one bad value does not lose the script', () => {
    const data = installStorage()
    data.set(
      'diskpush:fleet-draft:v1',
      JSON.stringify({ script: 'keep me', interpreter: 'python', concurrency: -4, selected: 'nope' }),
    )
    const draft = readDraft()
    expect(draft.script).toBe('keep me')
    expect(draft.interpreter).toBe(EMPTY_DRAFT.interpreter)
    expect(draft.concurrency).toBe(EMPTY_DRAFT.concurrency)
    expect(draft.selected).toEqual([])
  })

  it('survives storage that throws outright', () => {
    // Private windows and blocked site data throw on access, not on read.
    installStorage({
      getItem: () => {
        throw new Error('access denied')
      },
    })
    expect(readDraft()).toEqual(EMPTY_DRAFT)
  })

  it('is a blank draft, never a crash, with no window at all', () => {
    vi.stubGlobal('window', undefined)
    expect(readDraft()).toEqual(EMPTY_DRAFT)
  })
})

describe('writeDraft', () => {
  it('never throws, because losing a draft must not break a run', () => {
    installStorage({
      setItem: () => {
        throw new Error('quota exceeded')
      },
    })
    expect(() => writeDraft({ ...EMPTY_DRAFT, script: 'x' })).not.toThrow()
  })

  it('never stores a sudo password, because the draft has no field for one', () => {
    const data = installStorage()
    writeDraft({ ...EMPTY_DRAFT, script: 'id' })
    expect(data.get('diskpush:fleet-draft:v1')).not.toMatch(/password/i)
  })
})

describe('clearDraft', () => {
  it('removes it', () => {
    installStorage()
    writeDraft({ ...EMPTY_DRAFT, script: 'x' })
    clearDraft()
    expect(readDraft()).toEqual(EMPTY_DRAFT)
  })
})

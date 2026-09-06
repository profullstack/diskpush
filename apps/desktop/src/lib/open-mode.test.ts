import { describe, expect, it } from 'vitest'
import { defaultModeFor } from './open-mode.js'

describe('defaultModeFor', () => {
  /*
   * The case that prompted the feature: a series of episodes is watched in
   * order, and opening all twelve at once is never what was meant.
   */
  it('queues a set of videos', () => {
    expect(defaultModeFor('video/x-matroska', 12)).toBe('series')
    expect(defaultModeFor('video/mp4', 2)).toBe('series')
  })

  it('queues a set of audio too', () => {
    expect(defaultModeFor('audio/flac', 9)).toBe('series')
  })

  it('opens documents and images together', () => {
    expect(defaultModeFor('application/pdf', 4)).toBe('together')
    expect(defaultModeFor('image/jpeg', 30)).toBe('together')
    expect(defaultModeFor('text/markdown', 3)).toBe('together')
  })

  /*
   * One file has no meaningful mode. Answering `series` would park a queue of
   * one waiting to be advanced past its own only entry.
   */
  it('never queues a single file, whatever it is', () => {
    expect(defaultModeFor('video/x-matroska', 1)).toBe('together')
    expect(defaultModeFor('video/mp4', 0)).toBe('together')
  })

  /*
   * A mixed selection has no shared type, and each file opens in its own
   * default application. Queueing unrelated files behind each other would be a
   * worse guess than opening them.
   */
  it('opens a mixed selection together', () => {
    expect(defaultModeFor(null, 5)).toBe('together')
  })
})

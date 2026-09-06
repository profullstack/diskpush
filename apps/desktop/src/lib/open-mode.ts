/** All the files at once, or one after another. */
export type OpenMode = 'together' | 'series'

/**
 * How a selection opens unless told otherwise.
 *
 * Video and audio are the things you go through in order, so a set of them
 * defaults to one at a time: opening twelve episodes at once is not something
 * anyone means. Everything else opens together, because a handful of photos or
 * documents is a set you want in front of you at the same time.
 *
 * A mixed selection has no shared type and gets `together`, which pairs with
 * each file opening in its own default application: twelve unrelated files
 * queued behind each other would be a worse guess than just opening them.
 *
 * One file has no meaningful mode. The dialog does not offer the choice there,
 * and this answers `together` so nothing waits on a queue of one.
 */
export function defaultModeFor(contentType: string | null, count: number): OpenMode {
  if (count < 2) return 'together'
  if (!contentType) return 'together'
  return contentType.startsWith('video/') || contentType.startsWith('audio/') ? 'series' : 'together'
}

import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { defaultRsyncOptions } from '@diskpush/schemas'
import { buildRsyncArgs } from './args.js'
import { runToCompletion } from './runner.js'
import { planTransfer } from './plan.js'

const local = (path: string) => ({ type: 'local' as const, path })

describe('buildRsyncArgs with a file list', () => {
  /*
   * The bug this exists to prevent, confirmed against rsync 3.4.1:
   *
   *   rsync -a    --files-from=list src/ dst/   ->  cd+++++++++ movieA/
   *   rsync -a -r --files-from=list src/ dst/   ->  cd+++++++++ movieA/
   *                                                 >f+++++++++ movieA/a.mkv
   *
   * `--files-from` switches rsync's recursion off and `--archive` does not
   * switch it back on, so selecting a folder would copy an empty folder and
   * call it a success.
   */
  it('forces --recursive, because --archive does not imply it under --files-from', () => {
    const { args } = buildRsyncArgs({
      source: local('/src/'),
      destination: local('/dst/'),
      options: defaultRsyncOptions({ filesFrom: '/tmp/list', from0: true }),
    })

    expect(args).toContain('--archive')
    expect(args).toContain('--recursive')
    expect(args).toContain('--from0')
    expect(args).toContain('--files-from=/tmp/list')
  })

  it('does not add --recursive for an ordinary archive transfer', () => {
    const { args } = buildRsyncArgs({
      source: local('/src/'),
      destination: local('/dst/'),
      options: defaultRsyncOptions({}),
    })

    expect(args).toContain('--archive')
    expect(args).not.toContain('--recursive')
  })

  it('leaves --from0 off unless it was asked for', () => {
    const { args } = buildRsyncArgs({
      source: local('/src/'),
      destination: local('/dst/'),
      options: defaultRsyncOptions({ filesFrom: '/tmp/list' }),
    })

    expect(args).not.toContain('--from0')
    expect(args).toContain('--files-from=/tmp/list')
  })
})

/**
 * Against the real binary, because the whole point is a behaviour of rsync
 * that the flag names do not tell you about.
 */
describe('live rsync: a selected folder', () => {
  function fixture() {
    const root = mkdtempSync(join(tmpdir(), 'diskpush-files-from-'))
    for (const dir of ['src/movieA', 'src/movieB', 'src/other', 'dst']) {
      mkdirSync(join(root, dir), { recursive: true })
    }
    writeFileSync(join(root, 'src/movieA/a.mkv'), 'a')
    writeFileSync(join(root, 'src/movieB/b.mkv'), 'b')
    writeFileSync(join(root, 'src/other/o.txt'), 'o')
    writeFileSync(join(root, 'src/top.txt'), 'top')
    writeFileSync(join(root, 'list'), 'movieA\0movieB\0')
    return root
  }

  it('copies its contents, and nothing that was not selected', async () => {
    const root = fixture()
    const plan = planTransfer({
      source: local(`${join(root, 'src')}/`),
      destination: local(`${join(root, 'dst')}/`),
      options: defaultRsyncOptions({
        filesFrom: join(root, 'list'),
        from0: true,
        dryRun: true,
      }),
    })

    const result = await runToCompletion(plan)
    const paths = result.changes.map((change) => change.path)

    expect(result.ok).toBe(true)
    // The contents, not just the directory entry. This is the assertion that
    // fails if the --recursive above is ever removed.
    expect(paths).toContain('movieA/a.mkv')
    expect(paths).toContain('movieB/b.mkv')
    // Everything the user did not select stays out of it.
    expect(paths).not.toContain('other/o.txt')
    expect(paths).not.toContain('top.txt')
  })

  /*
   * Mirror plus a selection deletes only inside what was selected. Verified
   * rather than assumed, because the alternative reading of `--delete` here
   * (everything at the destination that is not in the list) would wipe the
   * folder, and that is not a thing to find out in production.
   */
  it('scopes a mirror delete to the selection', async () => {
    const root = fixture()
    mkdirSync(join(root, 'dst/movieA'), { recursive: true })
    mkdirSync(join(root, 'dst/keepme'), { recursive: true })
    writeFileSync(join(root, 'dst/movieA/stale.mkv'), 'stale')
    writeFileSync(join(root, 'dst/keepme/k.txt'), 'keep')
    writeFileSync(join(root, 'dst/untouched.txt'), 'untouched')

    const plan = planTransfer({
      source: local(`${join(root, 'src')}/`),
      destination: local(`${join(root, 'dst')}/`),
      options: defaultRsyncOptions({
        filesFrom: join(root, 'list'),
        from0: true,
        deleteMode: 'delay',
        dryRun: true,
      }),
      deletesConfirmed: true,
    })

    const result = await runToCompletion(plan)
    const deletes = result.changes.filter((c) => c.action === 'delete').map((c) => c.path)

    expect(deletes).toContain('movieA/stale.mkv')
    expect(deletes).not.toContain('keepme/k.txt')
    expect(deletes).not.toContain('untouched.txt')
  })
})

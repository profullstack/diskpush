import { describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({ shell: { openPath: async () => '' } }))

const { parseDesktopEntry, parseGioMime } = await import('./open-with.js')

describe('parseDesktopEntry', () => {
  /*
   * Taken from a real /usr/share/applications entry. The localised keys are
   * the point: a parser that matches `Name` anywhere returns "系統監視器",
   * because `Name[zh_TW]` comes later in the file than `Name`.
   */
  const BTOP = `[Desktop Entry]
Type=Application
Version=1.0
Name=btop++
GenericName=System Monitor
GenericName[it]=Monitor di sistema
Name[zh_TW]=系統監視器
Comment=Resource monitor
Icon=btop
Exec=btop
Terminal=true
Categories=System;Monitor;ConsoleOnly;
`

  it('reads the untranslated name', () => {
    expect(parseDesktopEntry(BTOP).name).toBe('btop++')
  })

  it('notices a terminal application', () => {
    expect(parseDesktopEntry(BTOP).terminal).toBe(true)
  })

  /*
   * A desktop file can carry action groups with their own Name=. Reading the
   * whole file rather than the [Desktop Entry] group names the app after
   * whichever action happens to be last.
   */
  it('ignores keys outside the [Desktop Entry] group', () => {
    const withActions = `[Desktop Entry]
Type=Application
Name=Files
Terminal=false

[Desktop Action new-window]
Name=Open a New Window
Exec=nautilus --new-window
`
    const parsed = parseDesktopEntry(withActions)
    expect(parsed.name).toBe('Files')
    expect(parsed.terminal).toBe(false)
  })

  it('reads NoDisplay and Hidden, which keep plumbing out of a menu', () => {
    const hidden = `[Desktop Entry]
Name=Session Agent
NoDisplay=true
Hidden=TRUE
`
    const parsed = parseDesktopEntry(hidden)
    expect(parsed.noDisplay).toBe(true)
    expect(parsed.hidden).toBe(true)
  })

  it('survives comments, blank lines and a missing name', () => {
    const parsed = parseDesktopEntry('# a comment\n\n[Desktop Entry]\nType=Application\n')
    expect(parsed.name).toBeNull()
    expect(parsed.terminal).toBe(false)
  })
})

describe('parseGioMime', () => {
  // gio's real output, curly quotes and leading tabs included.
  const FULL = `Default application for “text/plain”: org.gnome.gedit.desktop
Registered applications:
\torg.gnome.gedit.desktop
\tvim.desktop
\tcode.desktop
Recommended applications:
\torg.gnome.gedit.desktop
\tcode.desktop
`

  it('finds the default and every alternative', () => {
    const parsed = parseGioMime(FULL)
    expect(parsed.defaultId).toBe('org.gnome.gedit.desktop')
    expect(parsed.ids).toEqual(['org.gnome.gedit.desktop', 'vim.desktop', 'code.desktop'])
  })

  it('puts the default first and never lists it twice', () => {
    // It appears under both headings and as the default; the dialog shows one row.
    const parsed = parseGioMime(FULL)
    expect(parsed.ids.filter((id) => id === 'org.gnome.gedit.desktop')).toHaveLength(1)
    expect(parsed.ids[0]).toBe('org.gnome.gedit.desktop')
  })

  it('handles a type nothing is registered for', () => {
    const parsed = parseGioMime('No default applications for “text/markdown”\n')
    expect(parsed.defaultId).toBeNull()
    expect(parsed.ids).toEqual([])
  })

  it('handles registrations with no default', () => {
    const parsed = parseGioMime('No default applications for “text/markdown”\nRegistered applications:\n\tvim.desktop\n')
    expect(parsed.defaultId).toBeNull()
    expect(parsed.ids).toEqual(['vim.desktop'])
  })

  it('ignores anything that is not a desktop id', () => {
    const parsed = parseGioMime('Registered applications:\n\tnot-an-app\n\tvim.desktop\n')
    expect(parsed.ids).toEqual(['vim.desktop'])
  })
})

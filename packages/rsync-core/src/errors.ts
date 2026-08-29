/** rsync's documented exit codes, translated into something a person can act on. */

export type ExitInterpretation = {
  code: number
  ok: boolean
  /** Data survived on disk and rerunning the job will pick up where it stopped. */
  resumable: boolean
  message: string
}

const MESSAGES: Record<number, { message: string; resumable?: boolean; ok?: boolean }> = {
  0: { message: 'Transfer completed successfully.', ok: true },
  1: { message: 'rsync rejected the generated arguments (syntax or usage error).' },
  2: { message: 'The two rsync versions are not protocol-compatible.' },
  3: { message: 'rsync could not select the requested input or output files.' },
  4: {
    message:
      'The requested action is not supported by one side. An option may need a newer rsync, or the platform cannot preserve what was asked for.',
  },
  5: { message: 'The remote rsync could not be started.' },
  6: { message: 'rsync was asked to log to a file it could not open.' },
  10: { message: 'Connection interrupted (socket I/O error). This transfer can be resumed.', resumable: true },
  11: {
    message:
      'File I/O error. The destination filesystem may be full or read-only. Partial transfer data was preserved where possible.',
    resumable: true,
  },
  12: { message: 'The rsync data stream failed, usually because the connection dropped. This transfer can be resumed.', resumable: true },
  13: { message: 'rsync reported an error with its own diagnostics.' },
  14: { message: 'rsync failed in inter-process communication.' },
  20: { message: 'Transfer stopped by a signal. This transfer can be resumed.', resumable: true },
  21: { message: 'rsync failed waiting for a child process.' },
  22: { message: 'rsync could not allocate memory for the file list.' },
  23: {
    message: 'Partial transfer due to error. Some files could not be transferred; the rest arrived.',
    resumable: true,
  },
  24: {
    message: 'Partial transfer: some source files vanished before they could be sent. This is usually harmless.',
    ok: true,
  },
  25: { message: 'Stopped because --max-delete was reached. Nothing further was deleted.' },
  30: { message: 'Timed out sending or receiving data. This transfer can be resumed.', resumable: true },
  35: { message: 'Timed out waiting for the remote daemon to respond.', resumable: true },
}

export function interpretExit(code: number, signal: NodeJS.Signals | null = null): ExitInterpretation {
  if (signal) {
    return {
      code,
      ok: false,
      resumable: true,
      message: `Transfer stopped by signal ${signal}. Partial data was preserved and the job can be resumed.`,
    }
  }
  const known = MESSAGES[code]
  if (!known) {
    return { code, ok: false, resumable: false, message: `rsync exited with unexpected code ${code}.` }
  }
  return {
    code,
    ok: known.ok ?? false,
    resumable: known.resumable ?? false,
    message: known.message,
  }
}

/** Recognises the common stderr shapes worth rewriting before a user sees them. */
export function humanizeStderr(stderr: string): string | null {
  if (/No space left on device/i.test(stderr)) {
    return 'Transfer stopped because the destination filesystem is out of space. Partial transfer data was preserved where possible.'
  }
  if (/Permission denied|failed: Permission denied/i.test(stderr) && /rsync:/i.test(stderr)) {
    return 'The remote user does not have permission to write to the destination path.'
  }
  if (/Host key verification failed/i.test(stderr)) {
    return 'The SSH host key could not be verified. Connection blocked for safety.'
  }
  if (/REMOTE HOST IDENTIFICATION HAS CHANGED/i.test(stderr)) {
    return 'The SSH host key for this server has changed. Connection blocked for safety.'
  }
  // Shells word this several ways: `bash: rsync: command not found`,
  // `sh: 1: rsync: not found`, `rsync: No such file or directory`.
  if (/rsync:\s*(?:command\s+)?not found/i.test(stderr) || /command not found:?\s*rsync/i.test(stderr)) {
    return 'SSH connected successfully, but rsync is not installed on the remote server.'
  }
  if (/Permission denied \(publickey/i.test(stderr)) {
    return 'SSH authentication was rejected. Check the key, agent, or username for this connection.'
  }
  if (/Connection timed out|Operation timed out/i.test(stderr)) {
    return 'The SSH connection timed out before the transfer could start.'
  }
  if (/Could not resolve hostname/i.test(stderr)) {
    return 'The hostname could not be resolved from this machine.'
  }
  return null
}

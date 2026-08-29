import { EXIT } from './exit-codes.js'

/** Carriage return plus the ANSI erase-line sequence. */
const CLEAR_LINE = '\r\u001b[2K'

/**
 * The output contract, per the PRD: structured results on stdout, diagnostics
 * on stderr, so `diskpush ... --json | jq` works in a pipeline.
 */
export type OutputMode = { json: boolean; quiet: boolean; progress: boolean }

export class Output {
  constructor(private readonly mode: OutputMode) {}

  get isJson(): boolean {
    return this.mode.json
  }

  /** Progress only redraws in place on a real terminal. */
  get showProgress(): boolean {
    return this.mode.progress && !this.mode.json && !this.mode.quiet && process.stdout.isTTY === true
  }

  line(text = ''): void {
    if (this.mode.quiet || this.mode.json) return
    process.stdout.write(`${text}\n`)
  }

  /** Diagnostics and warnings. Always stderr, so they never pollute piped data. */
  warn(text: string): void {
    if (this.mode.quiet) return
    process.stderr.write(`${text}\n`)
  }

  error(text: string): void {
    process.stderr.write(`${text}\n`)
  }

  /** The machine-readable result. Printed once, at the end. */
  json(payload: unknown): void {
    process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`)
  }

  status(text: string): void {
    if (!this.showProgress) return
    process.stdout.write(`${CLEAR_LINE}${text}`)
  }

  clearStatus(): void {
    if (!this.showProgress) return
    process.stdout.write(CLEAR_LINE)
  }
}

export function failure(
  output: Output,
  message: string,
  code: number = EXIT.internal,
  extra: Record<string, unknown> = {},
): number {
  if (output.isJson) output.json({ status: 'failed', diskpushExitCode: code, message, ...extra })
  else output.error(message)
  return code
}

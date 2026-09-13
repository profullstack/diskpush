/**
 * `@profullstack/text-type-detection` ships plain JavaScript with no types.
 * The one function the viewer uses, declared here so the import checks.
 */
declare module '@profullstack/text-type-detection' {
  export type TextFormat = 'markdown' | 'plain' | 'ascii' | 'code' | 'html' | 'json' | 'xml'
  export function detectTextFormat(text: string): {
    text_format: TextFormat
    reasons: string[]
    stats: Record<string, number>
  }
}

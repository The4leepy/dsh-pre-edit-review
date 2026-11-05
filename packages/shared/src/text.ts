/**
 * Text transforms shared by the Host plugin (proposal computation) and the
 * VS Code extension (display normalisation).
 *
 * These mirror `@deepseek-ai/dsh-fs-local`'s literal-edit behaviour exactly so
 * that what the user reviews is what would have been written. Divergence is a
 * correctness bug, covered by `test/text.test.ts`.
 */

export type LineEndings = 'LF' | 'CRLF'

export function normalizeLineEndings(content: string): string {
  return content.replaceAll('\r\n', '\n')
}

/** Same heuristic as dsh-fs-local: dominant EOL in the first 4096 chars. */
export function detectLineEndings(raw: string): LineEndings {
  const sample = raw.slice(0, 4096)
  const crlfCount = sample.split('\r\n').length - 1
  const lfCount = sample.split('\n').length - 1
  return crlfCount > lfCount - crlfCount ? 'CRLF' : 'LF'
}

export function restoreLineEndings(content: string, lineEndings: LineEndings): string {
  if (lineEndings === 'LF') return content
  return normalizeLineEndings(content).split('\n').join('\r\n')
}

export function countOccurrences(content: string, needle: string): number {
  if (needle.length === 0) return 0
  let count = 0
  let index = 0
  for (;;) {
    const found = content.indexOf(needle, index)
    if (found === -1) return count
    count += 1
    index = found + needle.length
  }
}

export type LiteralEditFailure = 'empty-old' | 'not-found' | 'ambiguous'

export type LiteralEditResult =
  | { ok: true; content: string; replacements: number }
  | { ok: false; reason: LiteralEditFailure; matches: number }

/**
 * Apply one literal replacement on LF-normalised content.
 *
 * Callers must pass already-normalised `content`; `oldString` and `newString`
 * are normalised here, mirroring the provider.
 */
export function applyLiteralEdit(
  content: string,
  oldString: string,
  newString: string,
  replaceAll: boolean,
): LiteralEditResult {
  const oldNorm = normalizeLineEndings(oldString)
  if (oldNorm.length === 0) return { ok: false, reason: 'empty-old', matches: 0 }
  const newNorm = normalizeLineEndings(newString)
  const replacements = countOccurrences(content, oldNorm)
  if (replacements === 0) return { ok: false, reason: 'not-found', matches: 0 }
  if (!replaceAll && replacements > 1) return { ok: false, reason: 'ambiguous', matches: replacements }
  return { ok: true, content: content.split(oldNorm).join(newNorm), replacements }
}

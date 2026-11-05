/**
 * Turn one intercepted tool call into the full-file content the user reviews.
 *
 * Invariants:
 * - `write`, `edit` and `str_replace_editor` produce proposals; a command whose
 *   preconditions the real tool would fail on passes through so the tool emits
 *   its canonical error instead of us inventing one.
 * - When the real tool would fail on its own (missing file, ambiguous match,
 *   empty search) we return `passthrough` so the tool produces its canonical
 *   error instead of us inventing one.
 * - `proposedContent` is the exact byte sequence we intend to write;
 *   `displayContent` is the LF-normalised text shown in the diff.
 */
import { isAbsolute } from 'node:path'

import type { FileSnapshot } from '../../shared/src/index.ts'
import { applyLiteralEdit, detectLineEndings, normalizeLineEndings, restoreLineEndings } from '../../shared/src/index.ts'

export type ProposalResult =
  | {
      ok: true
      operation: 'create' | 'update'
      /** Exact content to write when the user accepts without editing. */
      proposedContent: string
      /** LF-normalised content shown to the user. */
      displayContent: string
      lineEndings: 'LF' | 'CRLF'
    }
  | { ok: false; passthrough: true; reason: string }
  | { ok: false; passthrough?: false; deny: true; reason: string }

export interface ProposalInput {
  toolName: string
  args: Record<string, unknown>
  snapshot: FileSnapshot
  maxFileBytes: number
}

function isString(value: unknown): value is string {
  return typeof value === 'string'
}

function deny(reason: string): ProposalResult {
  return { ok: false, deny: true, reason }
}

function passthrough(reason: string): ProposalResult {
  return { ok: false, passthrough: true, reason }
}

export function hasProposalBuilder(toolName: string): boolean {
  return toolName === 'write' || toolName === 'edit' || toolName === 'str_replace_editor'
}

export function buildProposal(input: ProposalInput): ProposalResult {
  const { toolName, args, snapshot, maxFileBytes } = input
  if (toolName === 'str_replace_editor') return buildEditorProposal(args, snapshot, maxFileBytes)
  if (toolName === 'write') return buildWriteProposal(args, snapshot, maxFileBytes)
  if (toolName === 'edit') return buildEditProposal(args, snapshot, maxFileBytes)
  return deny(`no proposal builder for tool "${toolName}"`)
}

function buildWriteProposal(args: Record<string, unknown>, snapshot: FileSnapshot, maxFileBytes: number): ProposalResult {
  const content = args.content
  if (!isString(content)) return passthrough('missing write content')
  const bytes = Buffer.byteLength(content, 'utf8')
  if (bytes > maxFileBytes) return deny(`proposed file is ${bytes} bytes, above the ${maxFileBytes}-byte review limit`)
  return {
    ok: true,
    operation: snapshot.exists ? 'update' : 'create',
    proposedContent: content,
    displayContent: normalizeLineEndings(content),
    lineEndings: snapshot.exists ? snapshot.lineEndings : detectLineEndings(content),
  }
}

function buildEditProposal(args: Record<string, unknown>, snapshot: FileSnapshot, maxFileBytes: number): ProposalResult {
  const oldString = args.old_string
  const newString = args.new_string
  const replaceAll = args.replace_all === true
  if (!isString(oldString) || !isString(newString)) return passthrough('missing edit strings')
  if (!snapshot.exists || snapshot.content === null) return passthrough('edit target does not exist yet')
  if (Buffer.byteLength(snapshot.content, 'utf8') > maxFileBytes) {
    return deny(`target file is above the ${maxFileBytes}-byte review limit`)
  }

  const edited = applyLiteralEdit(snapshot.content, oldString, newString, replaceAll)
  if (!edited.ok) return passthrough(`literal edit would fail: ${edited.reason}`)

  const proposedContent = restoreLineEndings(edited.content, snapshot.lineEndings)
  return {
    ok: true,
    operation: 'update',
    proposedContent,
    displayContent: edited.content,
    lineEndings: snapshot.lineEndings,
  }
}

/**
 * `str_replace_editor` (dsh-tool-str-replace-editor) clone semantics:
 * - `path` must be absolute (the tool rejects relative paths);
 * - `view` never mutates;
 * - `create` refuses an existing file;
 * - `str_replace` matches RAW content (no EOL normalisation) and requires a
 *   unique match; `new_str` omitted means the empty string, `null` is an error;
 * - `insert` inserts after line `insert_line` (0-based, 0 = before line 1) and
 *   the value may span multiple lines.
 */
function buildEditorProposal(args: Record<string, unknown>, snapshot: FileSnapshot, maxFileBytes: number): ProposalResult {
  const command = args.command
  const requestedPath = args.path
  if (typeof requestedPath !== 'string' || !isAbsolute(requestedPath)) {
    return passthrough('str_replace_editor requires an absolute path')
  }
  if (command === 'view') return passthrough('str_replace_editor view is read-only')

  if (command === 'create') {
    const fileText = args.file_text
    if (!isString(fileText)) return passthrough('missing file_text')
    if (snapshot.exists) return passthrough('the file already exists; the tool would reject `create`')
    if (Buffer.byteLength(fileText, 'utf8') > maxFileBytes) {
      return deny(`proposed file is ${Buffer.byteLength(fileText, 'utf8')} bytes, above the ${maxFileBytes}-byte review limit`)
    }
    return {
      ok: true,
      operation: 'create',
      proposedContent: fileText,
      displayContent: normalizeLineEndings(fileText),
      lineEndings: detectLineEndings(fileText),
    }
  }

  const raw = snapshot.rawContent ?? snapshot.content
  if (!snapshot.exists || raw === null) return passthrough('str_replace_editor target does not exist')
  if (Buffer.byteLength(raw, 'utf8') > maxFileBytes) {
    return deny(`target file is above the ${maxFileBytes}-byte review limit`)
  }

  if (command === 'str_replace') {
    const oldStr = args.old_str
    const newStrArg = args.new_str
    if (!isString(oldStr) || oldStr.length === 0) return passthrough('missing or empty old_str')
    if (newStrArg === null) return passthrough('new_str must be omitted or a string')
    if (newStrArg !== undefined && !isString(newStrArg)) return passthrough('new_str must be a string')
    const newStr = isString(newStrArg) ? newStrArg : ''
    const first = raw.indexOf(oldStr)
    if (first < 0) return passthrough('old_str does not appear verbatim in the file')
    if (raw.indexOf(oldStr, first + oldStr.length) >= 0) return passthrough('old_str is not unique in the file')
    const edited = raw.slice(0, first) + newStr + raw.slice(first + oldStr.length)
    return {
      ok: true,
      operation: 'update',
      proposedContent: edited,
      displayContent: normalizeLineEndings(edited),
      lineEndings: snapshot.lineEndings,
    }
  }

  if (command === 'insert') {
    const insertLine = args.insert_line
    const newStr = args.new_str
    if (typeof insertLine !== 'number' || !Number.isInteger(insertLine)) return passthrough('insert_line must be an integer')
    if (newStr === undefined || newStr === null) return passthrough('new_str is required for insert')
    if (!isString(newStr)) return passthrough('new_str must be a string')
    const lines = raw.split('\n')
    if (insertLine < 0 || insertLine > lines.length) return passthrough('insert_line is out of range')
    const edited = [...lines.slice(0, insertLine), ...newStr.split('\n'), ...lines.slice(insertLine)].join('\n')
    return {
      ok: true,
      operation: 'update',
      proposedContent: edited,
      displayContent: normalizeLineEndings(edited),
      lineEndings: snapshot.lineEndings,
    }
  }

  return passthrough(`unknown str_replace_editor command: ${String(command)}`)
}

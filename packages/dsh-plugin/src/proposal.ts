/**
 * Turn one intercepted tool call into the full-file content the user reviews.
 *
 * Invariants:
 * - Only `write` and `edit` produce a proposal in the MVP; `str_replace_editor`
 *   is explicitly denied until its line-based commands get a builder.
 * - When the real tool would fail on its own (missing file, ambiguous match,
 *   empty search) we return `passthrough` so the tool produces its canonical
 *   error instead of us inventing one.
 * - `proposedContent` is the exact byte sequence we intend to write;
 *   `displayContent` is the LF-normalised text shown in the diff.
 */
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
  return toolName === 'write' || toolName === 'edit'
}

export function buildProposal(input: ProposalInput): ProposalResult {
  const { toolName, args, snapshot, maxFileBytes } = input
  if (toolName === 'str_replace_editor') {
    return deny('str_replace_editor proposals are not supported yet (Phase 3)')
  }
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

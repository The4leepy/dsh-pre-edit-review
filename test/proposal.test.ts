import { test } from 'node:test'
import assert from 'node:assert/strict'
import { buildProposal, hasProposalBuilder } from '../packages/dsh-plugin/src/proposal.ts'
import type { FileSnapshot } from '../packages/shared/src/commit-target.ts'

const MAX = 2 * 1024 * 1024

function snapshot(overrides: Partial<FileSnapshot> = {}): FileSnapshot {
  return {
    displayPath: 'src/app.ts',
    absolutePath: '/ws/src/app.ts',
    exists: true,
    isNewFile: false,
    content: 'const a = 1\nconst b = 2\n',
    sha256: 'aaa',
    version: 'v1',
    lineEndings: 'LF',
    mode: 'tool-level',
    ...overrides,
  }
}

test('hasProposalBuilder covers write and edit only', () => {
  assert.equal(hasProposalBuilder('write'), true)
  assert.equal(hasProposalBuilder('edit'), true)
  assert.equal(hasProposalBuilder('str_replace_editor'), false)
  assert.equal(hasProposalBuilder('bash'), false)
})

test('write proposal keeps exact content and reports create/update', () => {
  const update = buildProposal({
    toolName: 'write',
    args: { file_path: 'src/app.ts', content: 'a\r\nb\r\n' },
    snapshot: snapshot(),
    maxFileBytes: MAX,
  })
  assert.equal(update.ok, true)
  if (!update.ok || !('proposedContent' in update)) throw new Error('expected proposal')
  assert.equal(update.proposedContent, 'a\r\nb\r\n')
  assert.equal(update.displayContent, 'a\nb\n')
  assert.equal(update.operation, 'update')
  assert.equal(update.lineEndings, 'LF')

  const create = buildProposal({
    toolName: 'write',
    args: { file_path: 'src/new.ts', content: 'hello\n' },
    snapshot: snapshot({ exists: false, isNewFile: true, content: null, sha256: null, version: undefined }),
    maxFileBytes: MAX,
  })
  assert.equal(create.ok, true)
  if (!create.ok || !('proposedContent' in create)) throw new Error('expected proposal')
  assert.equal(create.operation, 'create')
})

test('edit proposal mirrors literal-edit semantics and preserves CRLF', () => {
  const result = buildProposal({
    toolName: 'edit',
    args: { file_path: 'src/app.ts', old_string: 'line2', new_string: 'LINE2' },
    snapshot: snapshot({ content: 'line1\nline2\nline3\n', lineEndings: 'CRLF' }),
    maxFileBytes: MAX,
  })
  assert.equal(result.ok, true)
  if (!result.ok || !('proposedContent' in result)) throw new Error('expected proposal')
  assert.equal(result.displayContent, 'line1\nLINE2\nline3\n')
  assert.equal(result.proposedContent, 'line1\r\nLINE2\r\nline3\r\n')
})

test('edit proposal applies the replacement on LF-normalised content', () => {
  const result = buildProposal({
    toolName: 'edit',
    args: { file_path: 'src/app.ts', old_string: 'const b = 2', new_string: 'const b = 3' },
    snapshot: snapshot(),
    maxFileBytes: MAX,
  })
  assert.equal(result.ok, true)
  if (!result.ok || !('displayContent' in result)) throw new Error('expected proposal')
  assert.equal(result.displayContent, 'const a = 1\nconst b = 3\n')
})

test('ambiguous or missing matches pass through to the real tool', () => {
  const ambiguous = buildProposal({
    toolName: 'edit',
    args: { old_string: 'const', new_string: 'let' },
    snapshot: snapshot(),
    maxFileBytes: MAX,
  })
  assert.equal(ambiguous.ok, false)
  if (ambiguous.ok || !('passthrough' in ambiguous)) throw new Error('expected passthrough')
  assert.equal(ambiguous.passthrough, true)

  const missing = buildProposal({
    toolName: 'edit',
    args: { old_string: 'zzz', new_string: 'y' },
    snapshot: snapshot(),
    maxFileBytes: MAX,
  })
  assert.equal(missing.ok, false)
  if (missing.ok || !('passthrough' in missing)) throw new Error('expected passthrough')
})

test('edit on a missing file and str_replace_editor are not reviewed', () => {
  const missingFile = buildProposal({
    toolName: 'edit',
    args: { old_string: 'a', new_string: 'b' },
    snapshot: snapshot({ exists: false, content: null }),
    maxFileBytes: MAX,
  })
  assert.equal(missingFile.ok, false)
  if (missingFile.ok || !('passthrough' in missingFile)) throw new Error('expected passthrough')

  const sre = buildProposal({
    toolName: 'str_replace_editor',
    args: { command: 'create', path: 'a.ts', file_text: 'x' },
    snapshot: snapshot(),
    maxFileBytes: MAX,
  })
  assert.equal(sre.ok, false)
  if (sre.ok || !('deny' in sre)) throw new Error('expected deny')
})

test('oversized proposals are denied', () => {
  const result = buildProposal({
    toolName: 'write',
    args: { content: 'x'.repeat(64) },
    snapshot: snapshot(),
    maxFileBytes: 32,
  })
  assert.equal(result.ok, false)
  if (result.ok || !('deny' in result)) throw new Error('expected deny')
})

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { buildProposal, hasProposalBuilder } from '../packages/dsh-plugin/src/proposal.ts'
import type { FileSnapshot } from '../packages/shared/src/commit-target.ts'

const MAX = 2 * 1024 * 1024

function snapshot(overrides: Partial<FileSnapshot> = {}): FileSnapshot {
  return {
    displayPath: '/ws/src/app.ts',
    absolutePath: '/ws/src/app.ts',
    exists: true,
    isNewFile: false,
    content: 'one\ntwo\nthree\n',
    rawContent: 'one\ntwo\nthree\n',
    sha256: 'aaa',
    version: 'v1',
    lineEndings: 'LF',
    mode: 'tool-level',
    ...overrides,
  }
}

function build(args: Record<string, unknown>, snapshotValue = snapshot()) {
  return buildProposal({ toolName: 'str_replace_editor', args, snapshot: snapshotValue, maxFileBytes: MAX })
}

test('hasProposalBuilder now covers str_replace_editor', () => {
  assert.equal(hasProposalBuilder('str_replace_editor'), true)
  assert.equal(hasProposalBuilder('bash'), false)
})

test('view and relative paths pass through to the real tool', () => {
  assert.deepEqual(build({ command: 'view', path: '/ws/src/app.ts' }), {
    ok: false,
    passthrough: true,
    reason: 'str_replace_editor view is read-only',
  })
  assert.equal(build({ command: 'create', path: 'src/app.ts', file_text: 'x' }).ok, false)
})

test('create writes file_text as the proposed content', () => {
  const result = build(
    { command: 'create', path: '/ws/src/new.ts', file_text: 'hello\r\nworld\r\n' },
    snapshot({ exists: false, isNewFile: true, content: null, rawContent: null }),
  )
  assert.equal(result.ok, true)
  if (!result.ok || !('proposedContent' in result)) throw new Error('expected proposal')
  assert.equal(result.operation, 'create')
  assert.equal(result.proposedContent, 'hello\r\nworld\r\n')
  assert.equal(result.displayContent, 'hello\nworld\n')
  assert.equal(result.lineEndings, 'CRLF')
})

test('create on an existing file passes through (the tool rejects it)', () => {
  const result = build({ command: 'create', path: '/ws/src/app.ts', file_text: 'x' })
  assert.equal(result.ok, false)
  if (result.ok || !('passthrough' in result)) throw new Error('expected passthrough')
})

test('str_replace requires a unique verbatim match', () => {
  const unique = build({ command: 'str_replace', path: '/ws/src/app.ts', old_str: 'two', new_str: 'TWO' })
  assert.equal(unique.ok, true)
  if (!unique.ok || !('proposedContent' in unique)) throw new Error('expected proposal')
  assert.equal(unique.proposedContent, 'one\nTWO\nthree\n')
  assert.equal(unique.displayContent, 'one\nTWO\nthree\n')

  const missing = build({ command: 'str_replace', path: '/ws/src/app.ts', old_str: 'nope', new_str: 'x' })
  assert.equal(missing.ok, false)

  const ambiguous = build(
    { command: 'str_replace', path: '/ws/src/app.ts', old_str: 't', new_str: 'x' },
    snapshot({ content: 'tt\n', rawContent: 'tt\n' }),
  )
  assert.equal(ambiguous.ok, false)
})

test('str_replace matches raw bytes (CRLF preserved) and omitting new_str deletes', () => {
  const crlf = 'a\r\nb\r\nc\r\n'
  const result = build(
    { command: 'str_replace', path: '/ws/src/app.ts', old_str: 'b\r\n', new_str: '' },
    snapshot({ content: 'a\nb\nc\n', rawContent: crlf, lineEndings: 'CRLF' }),
  )
  assert.equal(result.ok, true)
  if (!result.ok || !('proposedContent' in result)) throw new Error('expected proposal')
  assert.equal(result.proposedContent, 'a\r\nc\r\n')
  assert.equal(result.displayContent, 'a\nc\n')

  const nullNewStr = build({ command: 'str_replace', path: '/ws/src/app.ts', old_str: 'b', new_str: null })
  assert.equal(nullNewStr.ok, false)
})

test('insert places the value after the given line', () => {
  const atStart = build({ command: 'insert', path: '/ws/src/app.ts', insert_line: 0, new_str: 'zero' })
  assert.equal(atStart.ok, true)
  if (!atStart.ok || !('proposedContent' in atStart)) throw new Error('expected proposal')
  assert.equal(atStart.proposedContent, 'zero\none\ntwo\nthree\n')

  const atEnd = build({ command: 'insert', path: '/ws/src/app.ts', insert_line: 3, new_str: 'four\nfive' })
  assert.equal(atEnd.ok, true)
  if (!atEnd.ok || !('proposedContent' in atEnd)) throw new Error('expected proposal')
  assert.equal(atEnd.proposedContent, 'one\ntwo\nthree\nfour\nfive\n')

  const outOfRange = build({ command: 'insert', path: '/ws/src/app.ts', insert_line: 99, new_str: 'x' })
  assert.equal(outOfRange.ok, false)
  const notInteger = build({ command: 'insert', path: '/ws/src/app.ts', insert_line: 1.5, new_str: 'x' })
  assert.equal(notInteger.ok, false)
})

test('oversized editor proposals are denied', () => {
  const result = buildProposal({
    toolName: 'str_replace_editor',
    args: { command: 'create', path: '/ws/src/new.ts', file_text: 'x'.repeat(64) },
    snapshot: snapshot({ exists: false, content: null, rawContent: null }),
    maxFileBytes: 16,
  })
  assert.equal(result.ok, false)
  if (result.ok || !('deny' in result)) throw new Error('expected deny')
})

import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  applyLiteralEdit,
  countOccurrences,
  detectLineEndings,
  normalizeLineEndings,
  restoreLineEndings,
} from '../packages/shared/src/text.ts'

test('normalizeLineEndings collapses CRLF only', () => {
  assert.equal(normalizeLineEndings('a\r\nb\rc\n'), 'a\nb\rc\n')
})

test('detectLineEndings uses the first 4096 bytes', () => {
  assert.equal(detectLineEndings('a\nb\nc\n'), 'LF')
  assert.equal(detectLineEndings('a\r\nb\r\nc\r\n'), 'CRLF')
  assert.equal(detectLineEndings('a\r\nb\n'), 'LF')
  // only the sample matters
  assert.equal(detectLineEndings('a\r\n' + 'x'.repeat(5000)), 'CRLF')
})

test('restoreLineEndings round-trips', () => {
  assert.equal(restoreLineEndings('a\nb\n', 'LF'), 'a\nb\n')
  assert.equal(restoreLineEndings('a\nb\n', 'CRLF'), 'a\r\nb\r\n')
})

test('countOccurrences handles overlapping-adjacent matches', () => {
  assert.equal(countOccurrences('aaaa', 'aa'), 2)
  assert.equal(countOccurrences('abc', 'x'), 0)
  assert.equal(countOccurrences('abc', ''), 0)
})

test('applyLiteralEdit replaces the unique match', () => {
  const result = applyLiteralEdit('a\nb\nc\n', 'b', 'B', false)
  assert.deepEqual(result, { ok: true, content: 'a\nB\nc\n', replacements: 1 })
})

test('applyLiteralEdit refuses ambiguous matches without replaceAll', () => {
  const result = applyLiteralEdit('x\nx\n', 'x', 'y', false)
  assert.equal(result.ok, false)
  if (!result.ok) {
    assert.equal(result.reason, 'ambiguous')
    assert.equal(result.matches, 2)
  }
})

test('applyLiteralEdit replaces all matches with replaceAll', () => {
  const result = applyLiteralEdit('x\nx\n', 'x', 'y', true)
  assert.deepEqual(result, { ok: true, content: 'y\ny\n', replacements: 2 })
})

test('applyLiteralEdit normalises CRLF in the search text', () => {
  // File content is already LF-normalised by the caller; old_string may arrive CRLF.
  const result = applyLiteralEdit('a\nb\n', 'a\r\nb', 'A\nB', false)
  assert.deepEqual(result, { ok: true, content: 'A\nB\n', replacements: 1 })
})

test('applyLiteralEdit rejects an empty search string and missing match', () => {
  assert.deepEqual(applyLiteralEdit('abc', '', 'x', false), { ok: false, reason: 'empty-old', matches: 0 })
  assert.deepEqual(applyLiteralEdit('abc', 'z', 'x', false), { ok: false, reason: 'not-found', matches: 0 })
})

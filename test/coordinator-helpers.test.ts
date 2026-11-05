import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  failureResult,
  languageHintFor,
  pathArgument,
  successValueFor,
} from '../packages/dsh-plugin/src/review-coordinator.ts'

test('pathArgument maps the known mutating tools to their path field', () => {
  assert.equal(pathArgument('write'), 'file_path')
  assert.equal(pathArgument('edit'), 'file_path')
  assert.equal(pathArgument('str_replace_editor'), 'path')
  assert.equal(pathArgument('bash'), undefined)
  assert.equal(pathArgument('read'), undefined)
})

test('successValueFor matches each tool output schema', () => {
  assert.deepEqual(successValueFor('write', '/ws/a.ts', 'update', 'a\n', 'b\n'), {
    path: '/ws/a.ts',
    operation: 'update',
    before: 'a\n',
    after: 'b\n',
  })
  assert.deepEqual(successValueFor('edit', '/ws/a.ts', 'update', 'a\n', 'b\n'), {
    path: '/ws/a.ts',
    before: 'a\n',
    after: 'b\n',
  })
  assert.equal(typeof successValueFor('str_replace_editor', '/ws/a.ts', 'update', null, 'x'), 'string')
  assert.throws(() => successValueFor('bash', '/ws/a.ts', 'update', null, 'x'))
})

test('failureResult is a fail-closed tool error', () => {
  const result = failureResult('nope')
  assert.equal(result.isError, true)
  assert.equal(result.error?.message, 'nope')
  assert.deepEqual(result.content, [{ type: 'text', text: 'Error: nope' }])
})

test('languageHintFor maps common extensions', () => {
  assert.equal(languageHintFor('src/a.ts'), 'typescript')
  assert.equal(languageHintFor('README.md'), 'markdown')
  assert.equal(languageHintFor('script.PY'), 'python')
  assert.equal(languageHintFor('Makefile'), undefined)
  assert.equal(languageHintFor('.env'), undefined)
})

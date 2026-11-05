import { test } from 'node:test'
import assert from 'node:assert/strict'
import { clampMessageDuration, DEFAULT_MESSAGE_DURATION_MS } from '../packages/vscode-extension/src/util.ts'

test('message duration defaults to 5s', () => {
  assert.equal(DEFAULT_MESSAGE_DURATION_MS, 5000)
  assert.equal(clampMessageDuration(undefined), 5000)
  assert.equal(clampMessageDuration('x'), 5000)
  assert.equal(clampMessageDuration(Number.NaN), 5000)
})

test('message duration is clamped to 1s..30s', () => {
  assert.equal(clampMessageDuration(5000), 5000)
  assert.equal(clampMessageDuration(1), 1000)
  assert.equal(clampMessageDuration(0), 1000)
  assert.equal(clampMessageDuration(-1), 1000)
  assert.equal(clampMessageDuration(60_000), 30_000)
  assert.equal(clampMessageDuration(2500.4), 2500)
})

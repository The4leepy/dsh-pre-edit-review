import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createActivationRegistry, sessionKeyOf } from '../packages/dsh-plugin/src/activation.ts'
import { isServerNotification, reviewPaused } from '../packages/shared/src/protocol.ts'

test('sessionKeyOf prefers the session id, then the agent id', () => {
  assert.equal(sessionKeyOf({ id: 'agent-1', session: { id: 'session-1' } }), 'session-1')
  assert.equal(sessionKeyOf({ id: 'agent-1', session: {} }), 'agent-1')
  assert.equal(sessionKeyOf({ id: 'agent-1' }), 'agent-1')
  assert.equal(sessionKeyOf({ id: 42 }), '42')
  assert.equal(sessionKeyOf({ id: '', session: { id: '' } }), undefined)
  assert.equal(sessionKeyOf({ id: '', session: { id: 'session-1' } }), 'session-1')
  assert.equal(sessionKeyOf({}), undefined)
  assert.equal(sessionKeyOf(undefined), undefined)
  assert.equal(sessionKeyOf(null), undefined)
})

test('default-active registry reviews every session until one is deactivated', () => {
  const activation = createActivationRegistry(true)
  assert.equal(activation.defaultActive, true)
  assert.equal(activation.isActive(undefined), true)
  assert.equal(activation.anyInactive(), false)
  assert.equal(activation.activeCount(), 0)
  assert.equal(activation.inactiveCount(), 0)

  const sessionA = { id: 'agent-a', session: { id: 'session-a' } }
  const sessionB = { id: 'agent-b', session: { id: 'session-b' } }
  assert.equal(activation.set(sessionA, false), true)
  assert.equal(activation.isActive(sessionA), false)
  assert.equal(activation.isActive(sessionB), true)
  assert.equal(activation.isActive(undefined), true)
  assert.equal(activation.anyInactive(), true)
  assert.equal(activation.inactiveCount(), 1)

  activation.set(sessionA, true)
  assert.equal(activation.isActive(sessionA), true)
  assert.equal(activation.anyInactive(), false)
  activation.set(sessionB, false)
  assert.equal(activation.anyInactive(), true)
  activation.set(sessionB, true)
  assert.equal(activation.anyInactive(), false)
})

test('default-inactive registry only reviews sessions that opted in', () => {
  const activation = createActivationRegistry(false)
  assert.equal(activation.defaultActive, false)
  assert.equal(activation.isActive(undefined), false)
  assert.equal(activation.isActive({ id: 'agent-a', session: { id: 'session-a' } }), false)
  // No session activated review yet.
  assert.equal(activation.anyInactive(), true)

  const sessionA = { id: 'agent-a', session: { id: 'session-a' } }
  const sessionB = { id: 'agent-b', session: { id: 'session-b' } }
  assert.equal(activation.set(sessionA, true), true)
  assert.equal(activation.isActive(sessionA), true)
  assert.equal(activation.isActive(sessionB), false)
  assert.equal(activation.anyInactive(), false)
  assert.equal(activation.activeCount(), 1)
  assert.equal(activation.inactiveCount(), 0)

  activation.set(sessionA, false)
  assert.equal(activation.anyInactive(), true)
  assert.equal(activation.activeCount(), 0)
  assert.equal(activation.inactiveCount(), 1)
})

test('a call without session identity follows defaultActive and cannot be pinned', () => {
  const activation = createActivationRegistry(false)
  assert.equal(activation.set(undefined, true), false)
  assert.equal(activation.set({}, true), false)
  assert.equal(activation.activeCount(), 0)
  assert.equal(activation.isActive(undefined), false)

  const pinned = createActivationRegistry(true)
  assert.equal(pinned.set(undefined, false), false)
  assert.equal(pinned.inactiveCount(), 0)
  assert.equal(pinned.isActive(undefined), true)
})

test('registries are independent (memory only, no shared state)', () => {
  const one = createActivationRegistry(false)
  const two = createActivationRegistry(false)
  const session = { id: 'agent', session: { id: 's' } }
  one.set(session, true)
  assert.equal(one.isActive(session), true)
  assert.equal(two.isActive(session), false)
})

test('review/mode accepts the paused field and the legacy bypass field', () => {
  assert.equal(isServerNotification({ jsonrpc: '2.0', method: 'review/mode', params: { paused: true } }), true)
  assert.equal(isServerNotification({ jsonrpc: '2.0', method: 'review/mode', params: { paused: false } }), true)
  assert.equal(isServerNotification({ jsonrpc: '2.0', method: 'review/mode', params: { bypass: true } }), true)
  assert.equal(isServerNotification({ jsonrpc: '2.0', method: 'review/mode', params: { paused: 'yes' } }), false)
  assert.equal(isServerNotification({ jsonrpc: '2.0', method: 'review/mode', params: {} }), false)
  assert.equal(isServerNotification({ jsonrpc: '2.0', method: 'review/request', params: {} }), false)
  assert.equal(reviewPaused({ paused: true }), true)
  assert.equal(reviewPaused({ bypass: true }), true)
  assert.equal(reviewPaused({ paused: false }), false)
  assert.equal(reviewPaused({}), false)
})

test('forget drops an explicit choice so the session follows the default again', () => {
  const activation = createActivationRegistry(false)
  const session = { id: 'agent-f', session: { id: 'session-f' } }
  assert.equal(activation.set(session, true), true)
  assert.equal(activation.isActive(session), true)
  assert.equal(activation.anyInactive(), false)
  assert.equal(activation.forget(session), true)
  assert.equal(activation.isActive(session), false)
  assert.equal(activation.anyInactive(), true)
  // Forgotten again: nothing to remove.
  assert.equal(activation.forget(session), false)
  // Anonymous turns are never registered.
  assert.equal(activation.forget(undefined), false)
})

test('forget on a default-active registry restores review for that session', () => {
  const activation = createActivationRegistry(true)
  const deactivated = { id: 'agent-d', session: { id: 'session-d' } }
  const other = { id: 'agent-o', session: { id: 'session-o' } }
  activation.set(deactivated, false)
  assert.equal(activation.anyInactive(), true)
  activation.forget(deactivated)
  assert.equal(activation.isActive(deactivated), true)
  // Another explicitly deactivated live session still keeps the aggregate OFF.
  activation.set(other, false)
  assert.equal(activation.anyInactive(), true)
})

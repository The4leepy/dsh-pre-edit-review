#!/usr/bin/env node
/**
 * E2E review client — stands in for the VS Code extension during automated
 * tests, speaking the same protocol (hello → review/request → decision).
 *
 * Usage:
 *   node scripts/e2e-client.mjs --state-dir <dir> --mode <mode> --out <file> [--count N]
 *
 * Modes:
 *   accept         accept the proposed content as-is
 *   accept-edited  accept with an extra marker appended (simulates a user edit)
 *   reject         reject with a reason
 *   conflict       modify the real file on disk first, then accept (CAS must fail)
 *   double-accept  send accept twice for the same request (idempotency)
 *   ignore         never answer (lets the host time out / fail closed)
 */
import { readFileSync, writeFileSync, existsSync } from 'node:fs'
import { connect } from 'node:net'
import { join } from 'node:path'

const args = process.argv.slice(2)
function option(name, fallback) {
  const index = args.indexOf(`--${name}`)
  return index === -1 ? fallback : args[index + 1]
}

const stateDir = option('state-dir', join(process.env.HOME ?? '', '.dsh/pre-edit-review'))
const mode = option('mode', 'accept')
const outFile = option('out', null)
const expectedCount = Number(option('count', '1'))
const socketPath = join(stateDir, 'ipc.sock')
const tokenPath = join(stateDir, 'token')

const report = { mode, connected: false, hello: null, requests: [], error: null, startedAt: new Date().toISOString() }
let nextId = 10
const pendingReplies = new Map()

function finish(code) {
  report.finishedAt = new Date().toISOString()
  if (outFile !== null) {
    try {
      writeFileSync(outFile, `${JSON.stringify(report, null, 2)}\n`, 'utf8')
    } catch (error) {
      console.error('could not write report:', error)
    }
  }
  process.exit(code)
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

async function waitForToken(deadline) {
  while (Date.now() < deadline) {
    if (existsSync(tokenPath)) return readFileSync(tokenPath, 'utf8').trim()
    await sleep(100)
  }
  throw new Error(`token not found at ${tokenPath}`)
}

async function connectSocket(deadline) {
  while (Date.now() < deadline) {
    const socket = await new Promise((resolve) => {
      const candidate = connect(socketPath)
      candidate.once('connect', () => resolve(candidate))
      candidate.once('error', () => {
        candidate.destroy()
        resolve(null)
      })
    })
    if (socket !== null) return socket
    await sleep(100)
  }
  throw new Error(`socket not reachable at ${socketPath}`)
}

function send(socket, message) {
  socket.write(`${JSON.stringify(message)}\n`)
}

function request(socket, method, params) {
  const id = nextId++
  const promise = new Promise((resolve) => pendingReplies.set(id, resolve))
  send(socket, { jsonrpc: '2.0', id, method, params })
  return promise
}

async function main() {
  const deadline = Date.now() + 30_000
  const token = await waitForToken(deadline)
  const socket = await connectSocket(deadline)
  report.connected = true

  let buffer = ''
  let handled = 0
  let timer = setTimeout(() => finish(1), 30_000)

  socket.setEncoding('utf8')
  socket.on('data', (chunk) => {
    buffer += chunk
    const parts = buffer.split('\n')
    buffer = parts.pop() ?? ''
    for (const line of parts) {
      if (line.trim().length === 0) continue
      let message
      try {
        message = JSON.parse(line)
      } catch {
        continue
      }
      if (message.id !== undefined && pendingReplies.has(message.id)) {
        const resolve = pendingReplies.get(message.id)
        pendingReplies.delete(message.id)
        resolve(message)
        continue
      }
      if (message.method === 'review/request') {
        void onReviewRequest(message.params)
      }
      // review/cancel, review/state, server/shutdown are ignored by the harness
    }
  })

  async function onReviewRequest(params) {
    const entry = {
      requestId: params.requestId,
      toolName: params.toolName,
      displayPath: params.displayPath,
      operation: params.operation,
      mode: params.mode,
      afterLength: typeof params.after === 'string' ? params.after.length : null,
      beforeIsNull: params.before === null,
      decisions: [],
    }
    report.requests.push(entry)
    handled += 1

    if (mode === 'ignore') {
      if (handled >= expectedCount) setTimeout(() => finish(0), 1_000)
      return
    }

    if (mode === 'conflict') {
      writeFileSync(params.absolutePath, 'EXTERNAL-CHANGE-WINS\n', 'utf8')
      entry.externalWrite = true
    }

    const decisionParams = (status, finalContent, reason) => ({
      requestId: params.requestId,
      nonce: params.nonce,
      status,
      ...(finalContent !== undefined ? { finalContent } : {}),
      ...(reason !== undefined ? { reason } : {}),
    })

    if (mode === 'reject') {
      const reply = await request(socket, 'decision', decisionParams('reject', undefined, 'e2e: not this change'))
      entry.decisions.push({ status: 'reject', reply: reply.result ?? reply.error })
    } else if (mode === 'accept-edited') {
      const finalContent = `${params.after}\nE2E-USER-EDIT\n`
      const reply = await request(socket, 'decision', decisionParams('accept', finalContent))
      entry.decisions.push({ status: 'accept-edited', reply: reply.result ?? reply.error })
    } else if (mode === 'double-accept') {
      const first = await request(socket, 'decision', decisionParams('accept', params.after))
      entry.decisions.push({ status: 'accept#1', reply: first.result ?? first.error })
      const second = await request(socket, 'decision', decisionParams('accept', params.after))
      entry.decisions.push({ status: 'accept#2', reply: second.result ?? second.error })
    } else {
      const reply = await request(socket, 'decision', decisionParams('accept', params.after))
      entry.decisions.push({ status: 'accept', reply: reply.result ?? reply.error })
    }

    if (handled >= expectedCount) {
      clearTimeout(timer)
      timer = setTimeout(() => finish(0), 300)
    }
  }

  const hello = await request(socket, 'hello', {
    token,
    protocolVersion: 1,
    client: { name: 'e2e-client', version: '0.0.1' },
  })
  report.hello = hello.result ?? hello.error
  if (report.hello?.ok !== true) {
    report.error = `hello failed: ${JSON.stringify(report.hello)}`
    finish(1)
  }
}

main().catch((error) => {
  report.error = error instanceof Error ? error.message : String(error)
  finish(1)
})

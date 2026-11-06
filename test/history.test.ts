import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { formatHistory, parseAuditLines, readAuditHistory } from '../packages/dsh-plugin/src/history.ts'

test('parseAuditLines keeps the newest valid entries and skips garbage', () => {
  const lines = [
    JSON.stringify({ at: '2026-11-05T10:00:00.000Z', event: 'review/committed', displayPath: 'a.ts', edited: true }),
    'not json',
    '{"event":42}',
    JSON.stringify({ at: '2026-11-05T10:05:00.000Z', event: 'review/rejected', displayPath: 'b.ts' }),
    '',
  ]
  const entries = parseAuditLines(lines, 10)
  assert.equal(entries.length, 2)
  assert.equal(entries[0].event, 'review/rejected')
  assert.equal(entries[1].event, 'review/committed')
  assert.equal(entries[1].edited, true)
  assert.equal(parseAuditLines(lines, 1).length, 1)
})

test('formatHistory renders newest first and states empty history explicitly', () => {
  assert.equal(formatHistory([]), 'No review history yet.')
  const rendered = formatHistory(
    [
      { at: '2026-11-05T10:05:00.000Z', event: 'review/conflict', displayPath: 'b.ts', code: 'FS_STALE_VERSION' },
      { at: '2026-11-05T10:00:00.000Z', event: 'review/committed', displayPath: 'a.ts', edited: true },
    ],
    10,
  )
  const lines = rendered.split('\n')
  assert.equal(lines.length, 2)
  assert.match(lines[0], /conflict/)
  assert.match(lines[0], /FS_STALE_VERSION/)
  assert.match(lines[1], /committed/)
  assert.match(lines[1], /edited/)
})

test('readAuditHistory reads newest monthly files first and respects the limit', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dpr-history-'))
  const auditDir = join(dir, 'audit')
  await mkdir(auditDir, { recursive: true })
  await writeFile(
    join(auditDir, '2026-10.jsonl'),
    `${JSON.stringify({ at: '2026-10-31T10:00:00.000Z', event: 'review/committed', displayPath: 'old.ts' })}\n`,
    'utf8',
  )
  const entries = [
    { at: '2026-11-05T10:00:00.000Z', event: 'review/committed', displayPath: 'a.ts' },
    { at: '2026-11-05T10:01:00.000Z', event: 'review/rejected', displayPath: 'b.ts' },
  ]
  await writeFile(join(auditDir, '2026-11.jsonl'), `${entries.map((entry) => JSON.stringify(entry)).join('\n')}\n`, 'utf8')

  const newest = await readAuditHistory(auditDir, 2)
  assert.deepEqual(
    newest.map((entry) => entry.displayPath),
    ['b.ts', 'a.ts'],
  )
  const more = await readAuditHistory(auditDir, 3)
  assert.equal(more.length, 3)
  assert.equal(await readAuditHistory(join(dir, 'missing'), 5).then((value) => value.length), 0)
})

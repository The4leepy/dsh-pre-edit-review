/**
 * Host-side review history, read from the append-only audit JSONL.
 *
 * The audit never stores file content: paths, event names, hashes, and
 * conflict codes only. `/review history` renders the newest entries.
 */
import { readdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'

export interface AuditHistoryEntry {
  at?: string
  event?: string
  requestId?: string
  displayPath?: string
  edited?: boolean
  code?: string
  finalSha256?: string
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** Parse the newest `limit` valid entries out of JSONL `lines` (newest first). */
export function parseAuditLines(lines: readonly string[], limit: number): AuditHistoryEntry[] {
  const entries: AuditHistoryEntry[] = []
  for (let index = lines.length - 1; index >= 0 && entries.length < limit; index -= 1) {
    const line = lines[index]?.trim()
    if (line === undefined || line.length === 0) continue
    let parsed: unknown
    try {
      parsed = JSON.parse(line)
    } catch {
      continue
    }
    if (!isRecord(parsed) || typeof parsed['event'] !== 'string') continue
    entries.push({
      ...(typeof parsed['at'] === 'string' ? { at: parsed['at'] } : {}),
      event: parsed['event'],
      ...(typeof parsed['requestId'] === 'string' ? { requestId: parsed['requestId'] } : {}),
      ...(typeof parsed['displayPath'] === 'string' ? { displayPath: parsed['displayPath'] } : {}),
      ...(typeof parsed['edited'] === 'boolean' ? { edited: parsed['edited'] } : {}),
      ...(typeof parsed['code'] === 'string' ? { code: parsed['code'] } : {}),
      ...(typeof parsed['finalSha256'] === 'string' ? { finalSha256: parsed['finalSha256'] } : {}),
    })
  }
  return entries
}

/** Read the newest `limit` audit entries across monthly files (newest first). */
export async function readAuditHistory(stateDir: string, limit: number): Promise<AuditHistoryEntry[]> {
  const auditDir = join(stateDir, 'audit')
  let files: string[]
  try {
    files = (await readdir(auditDir)).filter((name) => name.endsWith('.jsonl')).sort().reverse()
  } catch {
    return []
  }
  const entries: AuditHistoryEntry[] = []
  for (const file of files) {
    if (entries.length >= limit) break
    let lines: string[]
    try {
      lines = (await readFile(join(auditDir, file), 'utf8')).split('\n')
    } catch {
      continue
    }
    entries.push(...parseAuditLines(lines, limit - entries.length))
  }
  return entries
}

/** One-line-per-entry rendering; empty history says so explicitly. */
export function formatHistory(entries: readonly AuditHistoryEntry[], limit = 10): string {
  if (entries.length === 0) return 'No review history yet.'
  return entries
    .slice(0, limit)
    .map((entry) => {
      const when = entry.at === undefined ? '?' : entry.at.slice(5, 19).replace('T', ' ')
      const what = (entry.event ?? '?').replace(/^review\//, '')
      const path = entry.displayPath ?? ''
      const flags = [entry.edited === true ? 'edited' : '', entry.code ?? ''].filter((value) => value.length > 0)
      return `${when}  ${what.padEnd(12)} ${path}${flags.length > 0 ? `  [${flags.join(', ')}]` : ''}`
    })
    .join('\n')
}

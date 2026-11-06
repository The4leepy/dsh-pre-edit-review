/**
 * In-memory `FileSystemProvider` for the `dpr:` scheme.
 *
 * This document is the *right* side of `vscode.diff` and must be editable, so
 * the provider is registered **without** the `isReadonly` option (proved by the
 * S2 spike). Nothing here ever touches the user's working tree: `writeFile` is
 * called by VS Code when the user saves the proposal document, and the final
 * bytes are only kept in memory so that Accept can read `document.getText()`.
 *
 * URI layout (multi-Host, ADR 0002):
 *
 *   / <hostKey> / <requestId> / <basename>            editable proposal
 *   / <hostKey> / <requestId> / original / <basename> empty left side (new file)
 *
 * The host key segment makes the URIs globally unique across Hosts; the legacy
 * single-Host layout uses the fixed key `legacy`. Only `review-session.ts`
 * parses these paths (`requestIdOfPath`); everything else seeds by path.
 */

import * as vscode from 'vscode'

import { LEGACY_HOST_KEY } from './host-registry.ts'
import { basenameOf } from './util.ts'

export const DPR_SCHEME = 'dpr'

/** `/ <hostKey> / <requestId> / <basename>` — the editable proposal document. */
export function proposalPath(requestId: string, displayPath: string, hostKey: string = LEGACY_HOST_KEY): string {
  return `/${sanitizeSegment(hostKey)}/${sanitizeSegment(requestId)}/${basenameOf(displayPath)}`
}

/** `/ <hostKey> / <requestId> / original / <basename>` — an empty left side for new files. */
export function emptyOriginalPath(
  requestId: string,
  displayPath: string,
  hostKey: string = LEGACY_HOST_KEY,
): string {
  return `/${sanitizeSegment(hostKey)}/${sanitizeSegment(requestId)}/original/${basenameOf(displayPath)}`
}

export function proposalUriFor(
  requestId: string,
  displayPath: string,
  hostKey: string = LEGACY_HOST_KEY,
): vscode.Uri {
  return vscode.Uri.from({ scheme: DPR_SCHEME, path: proposalPath(requestId, displayPath, hostKey) })
}

export function emptyOriginalUriFor(
  requestId: string,
  displayPath: string,
  hostKey: string = LEGACY_HOST_KEY,
): vscode.Uri {
  return vscode.Uri.from({ scheme: DPR_SCHEME, path: emptyOriginalPath(requestId, displayPath, hostKey) })
}

/** Request id of a `dpr:` URI (second path segment, after the host key). */
export function requestIdOfPath(path: string): string | undefined {
  const segments = path.split('/').filter((segment) => segment.length > 0)
  return segments.length >= 2 ? segments[1] : undefined
}

function sanitizeSegment(value: string): string {
  return value.replace(/[\\/]/g, '_')
}

export interface DprWriteRecord {
  uri: string
  path: string
  content: string
  at: number
}

export class DprFileSystemProvider implements vscode.FileSystemProvider {
  private readonly files = new Map<string, string>()
  private readonly mtimes = new Map<string, number>()
  private readonly changeEmitter = new vscode.EventEmitter<vscode.FileChangeEvent[]>()
  private readonly writeHistory: DprWriteRecord[] = []
  private clock = Date.now()
  private disposed = false

  readonly onDidChangeFile: vscode.Event<vscode.FileChangeEvent[]> = this.changeEmitter.event

  get lastWrite(): DprWriteRecord | undefined {
    return this.writeHistory[this.writeHistory.length - 1]
  }

  /** Last `writeFile` content for a request, used by the in-process self-test. */
  lastWriteFor(requestId: string, hostKey: string = LEGACY_HOST_KEY): DprWriteRecord | undefined {
    const prefix = `/${sanitizeSegment(hostKey)}/${sanitizeSegment(requestId)}/`
    for (let index = this.writeHistory.length - 1; index >= 0; index -= 1) {
      const record = this.writeHistory[index]
      if (record !== undefined && record.path.startsWith(prefix)) return record
    }
    return undefined
  }

  seed(path: string, content: string): void {
    this.files.set(path, content)
    this.clock = Math.max(this.clock + 1, Date.now())
    this.mtimes.set(path, this.clock)
  }

  readText(uri: vscode.Uri): string | undefined {
    return this.files.get(this.key(uri))
  }

  /** Drop every in-memory document owned by one request (`/<hostKey>/<requestId>/...`). */
  release(requestId: string, hostKey: string = LEGACY_HOST_KEY): void {
    const prefix = `/${sanitizeSegment(hostKey)}/${sanitizeSegment(requestId)}/`
    for (const path of Array.from(this.files.keys())) {
      if (path.startsWith(prefix)) {
        this.files.delete(path)
        this.mtimes.delete(path)
      }
    }
    // Write history is intentionally kept (bounded to 64 records): the
    // self-test inspects it after Accept has already released the request.
  }

  dispose(): void {
    this.disposed = true
    this.files.clear()
    this.mtimes.clear()
    this.changeEmitter.dispose()
  }

  // -- vscode.FileSystemProvider ------------------------------------------

  watch(
    _uri: vscode.Uri,
    _options: { readonly recursive: boolean; readonly excludes: readonly string[] },
  ): vscode.Disposable {
    return { dispose: (): void => undefined }
  }

  stat(uri: vscode.Uri): vscode.FileStat {
    const key = this.key(uri)
    const text = this.files.get(key)
    if (text !== undefined) {
      return {
        type: vscode.FileType.File,
        ctime: this.mtimes.get(key) ?? this.clock,
        mtime: this.mtimes.get(key) ?? this.clock,
        size: Buffer.byteLength(text, 'utf8'),
      }
    }
    if (this.isDirectory(key)) {
      return { type: vscode.FileType.Directory, ctime: this.clock, mtime: this.clock, size: 0 }
    }
    throw vscode.FileSystemError.FileNotFound(uri)
  }

  readDirectory(uri: vscode.Uri): [string, vscode.FileType][] {
    const base = this.key(uri)
    const prefix = base === '/' ? '/' : `${base}/`
    const entries: [string, vscode.FileType][] = []
    for (const filePath of this.files.keys()) {
      if (!filePath.startsWith(prefix)) continue
      const remainder = filePath.slice(prefix.length)
      if (remainder.length === 0) continue
      const slash = remainder.indexOf('/')
      const name = slash === -1 ? remainder : remainder.slice(0, slash)
      const type = slash === -1 ? vscode.FileType.File : vscode.FileType.Directory
      if (!entries.some(([existing]) => existing === name)) {
        entries.push([name, type])
      }
    }
    return entries
  }

  createDirectory(_uri: vscode.Uri): void {
    // Directories are implied by file paths; nothing to persist.
  }

  readFile(uri: vscode.Uri): Uint8Array {
    const text = this.files.get(this.key(uri))
    if (text === undefined) {
      throw vscode.FileSystemError.FileNotFound(uri)
    }
    return Buffer.from(text, 'utf8')
  }

  writeFile(
    uri: vscode.Uri,
    content: Uint8Array,
    _options: { readonly create: boolean; readonly overwrite: boolean },
  ): void {
    if (this.disposed) return
    const key = this.key(uri)
    const text = Buffer.from(content).toString('utf8')
    this.files.set(key, text)
    this.clock = Math.max(this.clock + 1, Date.now())
    this.mtimes.set(key, this.clock)
    this.writeHistory.push({ uri: uri.toString(), path: key, content: text, at: Date.now() })
    if (this.writeHistory.length > 64) this.writeHistory.shift()
    // Deliberately no `onDidChangeFile` event: firing during the save round-trip
    // can make VS Code reload the document it is currently writing (S2 finding).
    console.log(`[dpr] provider.writeFile uri=${uri.toString()} bytes=${content.byteLength}`)
  }

  delete(uri: vscode.Uri, _options: { readonly recursive: boolean }): void {
    const key = this.key(uri)
    this.files.delete(key)
    this.mtimes.delete(key)
    this.changeEmitter.fire([{ type: vscode.FileChangeType.Deleted, uri }])
  }

  rename(
    oldUri: vscode.Uri,
    newUri: vscode.Uri,
    options: { readonly overwrite: boolean },
  ): void {
    const oldKey = this.key(oldUri)
    const newKey = this.key(newUri)
    const text = this.files.get(oldKey)
    if (text === undefined) {
      throw vscode.FileSystemError.FileNotFound(oldUri)
    }
    if (this.files.has(newKey) && !options.overwrite) {
      throw vscode.FileSystemError.FileExists(newUri)
    }
    this.files.delete(oldKey)
    this.mtimes.delete(oldKey)
    this.files.set(newKey, text)
    this.clock = Math.max(this.clock + 1, Date.now())
    this.mtimes.set(newKey, this.clock)
    this.changeEmitter.fire([{ type: vscode.FileChangeType.Changed, uri: newUri }])
  }

  private key(uri: vscode.Uri): string {
    return uri.path.length === 0 ? '/' : uri.path
  }

  private isDirectory(key: string): boolean {
    if (key === '/') return true
    const prefix = `${key}/`
    for (const filePath of this.files.keys()) {
      if (filePath.startsWith(prefix)) return true
    }
    return false
  }
}

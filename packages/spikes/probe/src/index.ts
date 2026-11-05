/**
 * Phase 1.5 spike probe (throwaway; uninstalled after M1).
 *
 * S1: prove `tools/execute` can short-circuit a real `write` call, perform the
 *     write itself, and hand the registry a synthetic success value that passes
 *     the write tool's output schema.
 * S3: prove the strict-mode building blocks work at this DSH version:
 *     - fs writes under an explicit `read-only` per-call policy are denied
 *     - fs writes under an explicit `workspace-write` per-call policy succeed
 *     - a stale `replaceIfVersion` token fails with FS_STALE_VERSION
 *     - `createIfAbsent` on an existing file fails with FS_NOT_OBSERVED
 *     - bash under an explicit `read-only` policy cannot write
 *     - bash under an explicit `workspace-write` policy can write
 *
 * Authored as a plain cordis plugin: no runtime imports from @deepseek-ai/*.
 */
import { appendFileSync, mkdirSync, realpathSync } from 'node:fs'
import { join, resolve as resolvePath } from 'node:path'

export const name = 'dpr-spike-probe'
export const inject = ['fs', 'tools']

interface ProbeConfig {
  workspaceRoot: string
  enableIntercept: boolean
  shortCircuitContent: string
}

function evidencePath(root: string): string {
  const dir = join(root, '.spike')
  mkdirSync(dir, { recursive: true })
  return join(dir, 'plugin-evidence.jsonl')
}

function record(root: string, event: Record<string, unknown>): void {
  appendFileSync(evidencePath(root), `${JSON.stringify({ at: new Date().toISOString(), ...event })}\n`, 'utf8')
}

function errorCode(error: unknown): string | undefined {
  if (typeof error === 'object' && error !== null && 'code' in error) {
    const code = (error as { code?: unknown }).code
    return typeof code === 'string' ? code : undefined
  }
  return undefined
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

export function apply(ctx: any, config: ProbeConfig): void {
  const root = realpathSync(resolvePath(config.workspaceRoot))
  const shortCircuitContent = config.shortCircuitContent ?? 'S1-SHORT-CIRCUIT-OK\n'

  record(root, { event: 'probe-mounted', root })

  /** Resolve the calling agent's cwd, falling back to the configured root. */
  const cwdOf = async (exec: any): Promise<string> => {
    const workingDirectory = ctx.get('workingDirectory')
    if (workingDirectory !== undefined && exec?.agent !== undefined) {
      try {
        return await workingDirectory.ensure(exec.agent, exec.signal)
      } catch {
        return root
      }
    }
    return root
  }

  // -------------------------------------------------------------------------
  // S1: short-circuit `write` for files under <root>/.spike/
  // -------------------------------------------------------------------------
  ctx.on(
    'tools/execute',
    async (exec: any, next: () => Promise<any>) => {
      if (config.enableIntercept !== true || exec?.name !== 'write') return next()
      const args = exec?.arguments
      const filePath = args?.file_path
      if (typeof filePath !== 'string' || typeof args?.content !== 'string') return next()

      const cwd = await cwdOf(exec)
      let target: any
      try {
        target = await ctx.fs.resolve(filePath, { cwd, signal: exec.signal })
      } catch (error) {
        record(root, { event: 'resolve-failed', filePath, message: errorMessage(error) })
        return next()
      }

      const probeRoot = join(root, '.spike')
      const targetKey = String(target?.targetKey ?? '')
      if (!(targetKey === probeRoot || targetKey.startsWith(`${probeRoot}/`))) return next()

      const stat = await ctx.fs.stat(target, exec.signal)
      const outcome = await ctx.fs.writeText(
        target,
        shortCircuitContent,
        stat === undefined ? { kind: 'createIfAbsent' } : { kind: 'replaceIfVersion', version: stat.version },
        exec.signal,
        { mode: 'workspace-write', workspaceRoot: root },
      )
      ctx.emit('fs/observed', target, { kind: 'present', version: outcome.version }, exec)

      const synthetic = {
        path: ctx.fs.processPath(target),
        operation: outcome.operation,
        before: outcome.before,
        after: shortCircuitContent,
      }
      record(root, {
        event: 's1-short-circuit',
        toolName: exec.name,
        callId: String(exec.callId ?? ''),
        requestedPath: filePath,
        agentContentLength: String(args.content).length,
        agentContentSha: shortHash(String(args.content)),
        synthetic,
        outcomeOperation: outcome.operation,
      })

      return { isError: false, value: synthetic }
    },
    { prepend: true },
  )

  // -------------------------------------------------------------------------
  // Probe tool: read evidence and run the S3 enforcement checks
  // -------------------------------------------------------------------------
  ctx.tools.register({
    name: 'spike_probe',
    description:
      'Phase 1.5 spike probe. action="s3-checks" runs strict-mode fs/bash enforcement checks; action="s1-report" returns the short-circuit evidence; action="shell-mode" reports the shell/fs sandbox capability facts.',
    parameters: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['s3-checks', 's1-report', 'shell-mode'] },
      },
      required: ['action'],
      additionalProperties: false,
    },
    output: {
      schema: { type: 'object' },
      render: (_args: unknown, value: unknown) => [
        { type: 'text', text: JSON.stringify(value, null, 2) },
      ],
    },
    async execute(args: any, exec: any) {
      const action = args?.action
      if (action === 'shell-mode') {
        const shell = ctx.get('shell')
        return {
          ok: true,
          shellSandboxMode: shell?.sandboxMode ?? null,
          fsSandboxMode: ctx.fs?.sandboxMode ?? null,
          hasSandboxPolicy: ctx.get('sandboxPolicy') !== undefined,
          hasShell: shell !== undefined,
          cwd: await cwdOf(exec),
        }
      }
      if (action === 's1-report') {
        const entries: unknown[] = []
        const file = evidencePath(root)
        try {
          const text = await import('node:fs/promises').then((fs) => fs.readFile(file, 'utf8'))
          for (const line of text.split('\n')) {
            if (line.trim().length > 0) entries.push(JSON.parse(line))
          }
        } catch {
          // no evidence yet
        }
        return { ok: true, evidenceFile: file, entries }
      }
      return await runStrictChecks(ctx, exec, root)
    },
  })

  record(root, { event: 'probe-ready', tools: ['spike_probe'] })
}

/** Small non-cryptographic fingerprint, only used to correlate evidence lines. */
function shortHash(value: string): string {
  let hash = 2166136261
  for (let i = 0; i < value.length; i += 1) {
    hash ^= value.charCodeAt(i)
    hash = Math.imul(hash, 16777619)
  }
  return (hash >>> 0).toString(16)
}

async function runStrictChecks(ctx: any, exec: any, root: string): Promise<unknown> {
  const dir = join(root, '.spike')
  mkdirSync(dir, { recursive: true })
  const checks: Array<Record<string, unknown>> = []

  const fsCheck = async (
    checkName: string,
    fileName: string,
    mode: 'read-only' | 'workspace-write',
    expected: { ok: boolean; code?: string },
    prepare: (target: any) => Promise<{ kind: 'createIfAbsent' } | { kind: 'replaceIfVersion'; version: unknown }>,
  ): Promise<void> => {
    const target = await ctx.fs.resolve(join(dir, fileName), { cwd: root, signal: exec.signal })
    try {
      const precondition = await prepare(target)
      const outcome = await ctx.fs.writeText(target, `probe-${checkName}\n`, precondition, exec.signal, {
        mode,
        workspaceRoot: root,
      })
      checks.push({
        name: checkName,
        expected: expected.ok ? 'allowed' : `denied:${expected.code}`,
        actual: 'allowed',
        ok: expected.ok === true,
        version: typeof outcome?.version === 'string' ? `len:${outcome.version.length}` : typeof outcome?.version,
      })
    } catch (error) {
      checks.push({
        name: checkName,
        expected: expected.ok ? 'allowed' : `denied:${expected.code}`,
        actual: `denied:${errorCode(error) ?? 'unknown'}`,
        ok: expected.ok === false && errorCode(error) === expected.code,
        message: errorMessage(error),
      })
    }
  }

  await fsCheck('fs-write-read-only-denied', 's3-readonly.txt', 'read-only', { ok: false, code: 'FS_SANDBOX_DENIED' }, async () => ({ kind: 'createIfAbsent' }))
  await fsCheck('fs-write-workspace-allowed', 's3-workspace.txt', 'workspace-write', { ok: true }, async () => ({ kind: 'createIfAbsent' }))
  await fsCheck('fs-write-stale-version-denied', 's3-workspace.txt', 'workspace-write', { ok: false, code: 'FS_STALE_VERSION' }, async () => ({ kind: 'replaceIfVersion', version: 'stale-version-token' }))
  await fsCheck('fs-write-create-if-absent-denied', 's3-workspace.txt', 'workspace-write', { ok: false, code: 'FS_NOT_OBSERVED' }, async () => ({ kind: 'createIfAbsent' }))

  // ---- shell (OS sandbox) checks -----------------------------------------
  const shell = ctx.get('shell')
  if (shell === undefined) {
    checks.push({ name: 'shell-available', expected: 'service mounted', actual: 'missing', ok: false })
  } else {
    const bashCheck = async (
      checkName: string,
      mode: 'read-only' | 'workspace-write',
      expected: { ok: boolean },
    ): Promise<void> => {
      const outFile = join(dir, `${checkName}.txt`)
      try {
        const spec = shell.resolve({
          command: `printf '%s' '${checkName}' > ${JSON.stringify(outFile)}`,
          workdir: root,
          timeoutMs: 20000,
          sandboxPolicy: { mode, workspaceRoot: root },
        })
        const handle = await shell.execute(spec)
        const result = await handle.result()
        const wrote = await import('node:fs/promises')
          .then((fs) => fs.readFile(outFile, 'utf8'))
          .then(() => true)
          .catch(() => false)
        checks.push({
          name: checkName,
          mode,
          exitCode: result?.exitCode,
          sandbox: result?.sandbox ?? null,
          wroteFile: wrote,
          ok: expected.ok === true ? wrote : wrote === false,
          outputTail: `${String(result?.stdout?.text ?? '').slice(-300)}${String(result?.stderr?.text ?? '').slice(-300)}`,
        })
      } catch (error) {
        checks.push({
          name: checkName,
          mode,
          actual: `threw:${errorCode(error) ?? 'unknown'}`,
          ok: expected.ok === false,
          message: errorMessage(error),
        })
      }
    }
    await bashCheck('bash-write-read-only-denied', 'read-only', { ok: false })
    await bashCheck('bash-write-workspace-allowed', 'workspace-write', { ok: true })
  }

  record(root, { event: 's3-checks', checks })
  return { ok: checks.every((check) => check.ok === true), root, checks }
}

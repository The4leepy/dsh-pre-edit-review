/**
 * Phase 4 probe (throwaway; uninstalled after M4).
 *
 * Lets the Lead switch the calling session's permission preset and run
 * enforcement checks without a human typing commands:
 *   status   → current resolved sandbox mode
 *   readonly → permissionPresets.set(session, 'read-only')
 *   balanced → permissionPresets.set(session, 'workspace-write')
 *   checks   → denial checks for fs/bash/python/sed/sh/symlink + explicit-policy write
 */
import { mkdirSync, symlinkSync, unlinkSync, existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'

export const name = 'dpr-sandbox-probe'
export const inject = ['fs', 'tools']

function msg(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function codeOf(error: unknown): string | undefined {
  if (typeof error === 'object' && error !== null && 'code' in error) {
    const code = (error as { code?: unknown }).code
    return typeof code === 'string' ? code : undefined
  }
  return undefined
}

export function apply(ctx: any, config: any): void {
  const root = resolve(config?.workspaceRoot ?? process.cwd())

  const sessionOf = (exec: any): any => exec?.agent?.session

  const currentMode = (session: any): string => {
    const policy = ctx.get('sandboxPolicy')
    return policy?.resolve({ ...(session !== undefined ? { session } : {}) })?.mode ?? 'unknown'
  }

  ctx.tools.register({
    name: 'sandbox_probe',
    description: 'Phase 4 probe: switch this session between read-only/workspace-write and verify sandbox enforcement (denial checks + explicit-policy write).',
    parameters: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['status', 'readonly', 'balanced', 'checks'] },
      },
      required: ['action'],
      additionalProperties: false,
    },
    output: {
      schema: { type: 'object' },
      render: (_args: unknown, value: unknown) => [{ type: 'text', text: JSON.stringify(value, null, 2) }],
    },
    async execute(args: any, exec: any) {
      const session = sessionOf(exec)
      const action = args?.action

      if (action === 'status') {
        return { ok: true, mode: currentMode(session), root }
      }

      if (action === 'readonly' || action === 'balanced') {
        const permission = ctx.get('permissionPresets')
        if (permission === undefined) return { ok: false, error: 'permissionPresets service missing' }
        if (session === undefined) return { ok: false, error: 'no agent session' }
        permission.set(session, action === 'readonly' ? 'read-only' : 'workspace-write')
        return { ok: true, previous: currentMode(session), requested: action }
      }

      if (action !== 'checks') return { ok: false, error: `unknown action ${String(action)}` }

      const dir = join(root, '.spike', 'e2e')
      mkdirSync(dir, { recursive: true })
      const checks: Array<Record<string, unknown>> = []
      const signal = exec.signal

      const shellRun = async (command: string, explicitPolicy?: { mode: string; workspaceRoot: string }) => {
        const shell = ctx.get('shell')
        if (shell === undefined) throw new Error('shell service missing')
        const spec = shell.resolve({
          command,
          workdir: root,
          timeoutMs: 20000,
          ...(explicitPolicy !== undefined ? { sandboxPolicy: explicitPolicy } : {}),
        })
        const result = await (await shell.execute(spec)).result()
        return {
          exitCode: result?.exitCode,
          sandbox: result?.sandbox ?? null,
          output: `${String(result?.stdout?.text ?? '')}${String(result?.stderr?.text ?? '')}`.slice(-400),
        }
      }

      const fsWrite = async (path: string, policy?: { mode: string; workspaceRoot: string }) => {
        const target = await ctx.fs.resolve(path, { cwd: root, signal })
        const outcome = await ctx.fs.writeText(target, 'probe', { kind: 'createIfAbsent' }, signal, policy as any)
        return { ok: true, operation: outcome.operation }
      }

      const record = async (name: string, expected: 'denied' | 'allowed', run: () => Promise<any>) => {
        try {
          const value = await run()
          checks.push({ name, expected, actual: 'allowed', ok: expected === 'allowed', value })
        } catch (error) {
          checks.push({
            name,
            expected,
            actual: `denied:${codeOf(error) ?? 'unknown'}`,
            ok: expected === 'denied',
            detail: msg(error),
          })
        }
      }

      // Standing policy = the session's mode (read-only during this probe).
      await record('fs-write-standing-readonly', 'denied', () => fsWrite(join(dir, 'strict-fs.txt')))
      await record('bash-redirect-readonly', 'denied', () =>
        shellRun(`printf 'x' > ${JSON.stringify(join(dir, 'strict-bash.txt'))}`),
      )
      await record('python-write-readonly', 'denied', () =>
        shellRun(`python3 -c "open(${JSON.stringify(join(dir, 'strict-python.txt'))},'w').write('x')"`),
      )
      await record('sed-inplace-readonly', 'denied', async () => {
        const victim = join(dir, 'strict-sed.txt')
        try {
          unlinkSync(victim)
        } catch {}
        return shellRun(`sed -i '' 's/original/changed/' ${JSON.stringify(victim)}`)
      })
      await record('sh-script-readonly', 'denied', () =>
        shellRun(`sh -c 'printf x > ${join(dir, 'strict-sh.txt')}'`),
      )

      // Explicit per-call workspace-write is how the commit service writes.
      const approvedPolicy = { mode: 'workspace-write', workspaceRoot: root }
      await record('fs-write-explicit-policy-allowed', 'allowed', () =>
        fsWrite(join(dir, 'strict-approved-fs.txt'), approvedPolicy),
      )
      await record('bash-explicit-policy-allowed', 'allowed', () =>
        shellRun(`printf 'x' > ${JSON.stringify(join(dir, 'strict-approved-bash.txt'))}`, approvedPolicy),
      )

      // Symlink escape: a link inside the workspace pointing outside must be
      // rejected by the realpath containment check even with workspace-write.
      const outside = join(homedir(), '.dsh', 'dpr-symlink-outside.txt')
      const link = join(dir, 'escape-link')
      try {
        unlinkSync(link)
      } catch {}
      try {
        symlinkSync(outside, link)
      } catch (error) {
        checks.push({ name: 'symlink-escape-denied', expected: 'denied', actual: 'setup-failed', ok: false, detail: msg(error) })
      }
      if (existsSync(link)) {
        await record('symlink-escape-denied', 'denied', () => fsWrite(link, approvedPolicy))
      }

      checks.push({ name: 'mode-during-checks', expected: currentMode(session), actual: currentMode(session), ok: true })
      return { ok: checks.every((check) => check.ok === true), mode: currentMode(session), root, checks }
    },
  })
}

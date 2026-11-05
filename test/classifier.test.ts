import { test } from 'node:test'
import assert from 'node:assert/strict'
import { classify } from '../packages/dsh-plugin/src/classifier.ts'
import { normalizeConfig } from '../packages/dsh-plugin/src/config.ts'
import type { ToolDefinitionView } from '../packages/dsh-plugin/src/host.ts'

const config = normalizeConfig({})
const builders = new Set(['write', 'edit'])

function run(toolName: string, definition?: ToolDefinitionView) {
  return classify({
    toolName,
    args: {},
    definition,
    config,
    hasBuilder: (name) => builders.has(name),
  })
}

const writeTool = {
  name: 'write',
  description: 'write',
  parameters: {},
  output: { schema: { type: 'object' }, render: () => [] },
} satisfies ToolDefinitionView

test('allow-listed reviewable tools are reviewed', () => {
  assert.deepEqual(run('write', writeTool), { action: 'review', toolName: 'write' })
  assert.deepEqual(run('edit'), { action: 'review', toolName: 'edit' })
})

test('unknown tools without mutation signals pass through', () => {
  assert.deepEqual(run('bash'), { action: 'pass' })
  assert.deepEqual(run('read', writeTool), { action: 'pass' })
})

test('a tool presenting a diff is reviewed when a builder exists, denied otherwise', () => {
  const diffTool = {
    ...writeTool,
    name: 'mcp__fs__patch_file',
    presentCall: () => ({ card: 'diff', title: 'patch', diffs: [] }),
  } satisfies ToolDefinitionView
  assert.deepEqual(run('mcp__fs__patch_file', diffTool), {
    action: 'deny',
    toolName: 'mcp__fs__patch_file',
    reason:
      'tool "mcp__fs__patch_file" presents a file diff but has no proposal builder; refusing to run it unreviewed',
  })

  const diffToolWithBuilder = { ...diffTool, name: 'edit' }
  assert.deepEqual(run('edit', diffToolWithBuilder), { action: 'review', toolName: 'edit' })
})

test('a throwing presentCall fails closed', () => {
  const throwing = {
    ...writeTool,
    name: 'mystery_tool',
    presentCall: () => {
      throw new Error('boom')
    },
  } satisfies ToolDefinitionView
  assert.equal(run('mystery_tool', throwing).action, 'deny')
})

test('mutating-looking names default to deny under the default policy', () => {
  for (const name of ['delete_file', 'rename_file', 'create_file', 'apply_patch']) {
    const result = run(name)
    assert.equal(result.action, 'deny', name)
  }
})

test('unknownToolPolicy=pass lets name heuristics through', () => {
  const passConfig = normalizeConfig({ unknownToolPolicy: 'pass' })
  const result = classify({
    toolName: 'delete_file',
    args: {},
    definition: undefined,
    config: passConfig,
    hasBuilder: () => false,
  })
  assert.equal(result.action, 'pass')
})

test('disabled plugin and off mode pass everything', () => {
  for (const raw of [{ enabled: false }, { mode: 'off' }]) {
    const disabled = normalizeConfig(raw)
    const result = classify({
      toolName: 'write',
      args: {},
      definition: writeTool,
      config: disabled,
      hasBuilder: () => true,
    })
    assert.equal(result.action, 'pass')
  }
})

test('exempt tools pass even when allow-listed', () => {
  const exempt = normalizeConfig({ exemptTools: ['write'] })
  const result = classify({
    toolName: 'write',
    args: {},
    definition: writeTool,
    config: exempt,
    hasBuilder: () => true,
  })
  assert.equal(result.action, 'pass')
})

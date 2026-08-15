import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

import { apply } from '../.dsh/.agent-presets/local-tools/computer-use/index.mjs'

const powershellScript = fileURLToPath(new URL(
  '../.dsh/.agent-presets/local-tools/computer-use/windows-computer-use.ps1',
  import.meta.url,
))

function loadPlugin() {
  const tools = []
  const listeners = new Map()
  const ctx = {
    tools: {
      register(tool) {
        tools.push(tool)
        return () => {}
      },
    },
    on(event, listener) {
      listeners.set(event, listener)
      return () => listeners.delete(event)
    },
  }
  apply(ctx)
  return { tools, listeners }
}

test('registers the observation and action tools', () => {
  const { tools } = loadPlugin()
  assert.deepEqual(tools.map((tool) => tool.name), ['computer_observe', 'computer_action'])
})

test('observation delegates through the approval pipeline', async () => {
  const { listeners } = loadPlugin()
  const preExecute = listeners.get('tools/pre-execute')
  const decision = await preExecute({ name: 'computer_observe', arguments: {} }, async () => ({ kind: 'allow' }))
  assert.deepEqual(decision, { kind: 'allow' })
})

test('every desktop action asks for approval', async () => {
  const { listeners } = loadPlugin()
  const preExecute = listeners.get('tools/pre-execute')
  const decision = await preExecute(
    { name: 'computer_action', arguments: { action: 'click', ref: 'e1' } },
    async () => ({ kind: 'allow' }),
  )
  assert.equal(decision.kind, 'ask')
  assert.match(decision.reason, /click/)
})

test('an action cannot run without a prior observation', async () => {
  const { tools } = loadPlugin()
  const action = tools.find((tool) => tool.name === 'computer_action')
  await assert.rejects(
    action.execute(
      { action: 'click', x: 20, y: 30 },
      {
        signal: new AbortController().signal,
        agent: { session: { id: 'test-session-without-snapshot' } },
      },
    ),
    /computer_observe/,
  )
})

test('PowerShell 5.1 observation converts the generic element list explicitly', async () => {
  const source = await readFile(powershellScript, 'utf8')
  assert.match(source, /elements\s*=\s*\$elements\.ToArray\(\)/)
  assert.doesNotMatch(source, /elements\s*=\s*@\(\$elements\)/)
})

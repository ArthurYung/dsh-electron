import assert from 'node:assert/strict'
import { copyFileSync, mkdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import test from 'node:test'

const root = new URL('..', import.meta.url).pathname.replace(/^\/(?:([A-Za-z]:))/, '$1')
const presetSource = join(
  root,
  '.dsh',
  '.agent-presets',
  'local-tools',
  'computer-use',
  'index.mjs',
)

test('packaged computer-use preset resolves Harness tools from the desktop app', async (t) => {
  const scratch = join(tmpdir(), `dsh-packaged-preset-${process.pid}-${Date.now()}`)
  const presetDirectory = join(scratch, '.agent-presets', 'local-tools', 'computer-use')
  mkdirSync(presetDirectory, { recursive: true })
  copyFileSync(presetSource, join(presetDirectory, 'index.mjs'))
  t.after(() => rmSync(scratch, { recursive: true, force: true }))

  const previousRoot = process.env.DSH_DESKTOP_APP_ROOT
  process.env.DSH_DESKTOP_APP_ROOT = root
  t.after(() => {
    if (previousRoot === undefined) delete process.env.DSH_DESKTOP_APP_ROOT
    else process.env.DSH_DESKTOP_APP_ROOT = previousRoot
  })

  const isolatedPreset = await import(pathToFileURL(join(presetDirectory, 'index.mjs')).href)
  assert.equal(isolatedPreset.name, 'tool-computer-use-windows')
  assert.equal(typeof isolatedPreset.apply, 'function')
})

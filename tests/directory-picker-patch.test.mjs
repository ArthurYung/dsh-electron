import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')

test('Electron profile pins the in-app workspace directory browser', () => {
  const result = spawnSync(
    process.execPath,
    [
      join(root, 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js'),
      '--profile',
      'web',
      '--patch',
      join(root, 'electron', 'directory-picker.patch.yml'),
      '--dump-config',
    ],
    {
      cwd: root,
      encoding: 'utf8',
      env: {
        ...process.env,
        DSH_HOME: join(root, '.dsh'),
        DSH_CWD: root,
      },
      windowsHide: true,
    },
  )

  assert.equal(result.status, 0, result.stderr)
  assert.match(
    result.stdout,
    /id:\s*directory-picker\s*\r?\n\s*name:\s*'@deepseek-ai\/dsh-host-directory-picker-auto'\s*\r?\n\s*disabled:\s*true/,
  )
  assert.match(result.stdout, /name:\s*'@deepseek-ai\/dsh-host-directory-picker-browse'/)
  assert.match(result.stdout, /name:\s*'@deepseek-ai\/dsh-client-ui-directory-picker-browse'/)
})

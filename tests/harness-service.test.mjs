import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import test from 'node:test'

import { HarnessService, isHarnessHtml } from '../electron/harness-service.mjs'

const root = new URL('..', import.meta.url).pathname.replace(/^\/(?:([A-Za-z]:))/, '$1')

function response(body, ok = true) {
  return { ok, text: async () => body }
}

test('recognizes only a DeepSeek Harness boot page', () => {
  assert.equal(isHarnessHtml('<script>window.__DSH_BOOT__ = {}</script>'), true)
  assert.equal(isHarnessHtml('<h1>another localhost service</h1>'), false)
})

test('reuses an existing Harness without taking ownership', async () => {
  let spawned = false
  const service = new HarnessService({
    appPath: root,
    nodePath: 'node.exe',
    patchPath: `${root}/electron/directory-picker.patch.yml`,
    harnessHome: `${root}/.dsh`,
    workingDirectory: root,
    fetchImpl: async () => response('window.__DSH_BOOT__ = {}'),
    spawnProcess: () => {
      spawned = true
    },
  })
  const result = await service.start()
  assert.equal(result.owned, false)
  assert.equal(spawned, false)
})

test('starts Harness with the bundled Node runtime and stops its tree', async () => {
  const child = new EventEmitter()
  child.pid = 43210
  child.exitCode = null
  child.stdout = new PassThrough()
  child.stderr = new PassThrough()
  let fetchCount = 0
  let spawnCall
  let killedPid
  const service = new HarnessService({
    appPath: root,
    nodePath: 'node.exe',
    patchPath: `${root}/electron/directory-picker.patch.yml`,
    harnessHome: `${root}/.dsh`,
    workingDirectory: root,
    logsDirectory: `${root}/.dsh/logs`,
    fetchImpl: async () => response(fetchCount++ === 0 ? 'not ready' : 'window.__DSH_BOOT__ = {}'),
    spawnProcess: (...args) => {
      spawnCall = args
      return child
    },
    killTree: (pid) => {
      killedPid = pid
    },
    pollIntervalMs: 1,
  })

  const result = await service.start()
  assert.equal(result.owned, true)
  assert.equal(spawnCall[0], 'node.exe')
  assert.match(spawnCall[1][0], /@deepseek-ai[\\/]dsh[\\/]lib[\\/]bin\.js$/)
  assert.deepEqual(spawnCall[1].slice(1), [
    '--profile',
    'web',
    '--patch',
    `${root}/electron/directory-picker.patch.yml`,
  ])
  assert.equal(spawnCall[2].env.DSH_HOME, `${root}/.dsh`)
  assert.equal(spawnCall[2].env.DSH_DESKTOP_APP_ROOT, root)

  service.stop()
  assert.equal(killedPid, 43210)
})

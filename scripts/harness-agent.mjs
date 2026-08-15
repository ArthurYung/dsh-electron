import { spawn, spawnSync } from 'node:child_process'
import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { delimiter, dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const logDir = join(root, '.dsh', 'logs')
const processFile = join(logDir, 'agent-processes.json')
const dsh = join(root, 'node_modules', '.bin', 'dsh.cmd')
const webUrl = 'http://127.0.0.1:3080'

function cleanEnvironment(overrides = {}) {
  const env = {}
  const pathParts = []
  for (const [key, value] of Object.entries(process.env)) {
    if (key.toLowerCase() === 'path') {
      if (value) pathParts.push(...value.split(delimiter))
      continue
    }
    if (value !== undefined) env[key] = value
  }
  env[process.platform === 'win32' ? 'Path' : 'PATH'] = [...new Set(pathParts)].join(delimiter)
  return { ...env, ...overrides }
}

function stopTree(pid) {
  if (!Number.isInteger(pid) || pid <= 0 || pid === process.pid) return
  if (process.platform === 'win32') {
    const taskkill = join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'taskkill.exe')
    const result = spawnSync(taskkill, ['/PID', String(pid), '/T', '/F'], {
      env: cleanEnvironment(),
      stdio: 'ignore',
      windowsHide: true,
    })
    if (result.error) throw result.error
    if (result.status !== 0 && processExists(pid)) {
      throw new Error(`无法结束进程 ${pid}，请以当前 Windows 用户重新运行 stop-agent.cmd。`)
    }
    return
  }
  try {
    process.kill(pid, 'SIGTERM')
  } catch (error) {
    if (error?.code !== 'ESRCH') throw error
  }
}

function processExists(pid) {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    if (error?.code === 'ESRCH') return false
    return true
  }
}

function stopSavedProcesses() {
  if (!existsSync(processFile)) {
    console.log('没有发现由一键启动器管理的 Harness 进程。')
    return
  }

  let record
  try {
    record = JSON.parse(readFileSync(processFile, 'utf8'))
  } catch (error) {
    throw new Error(`无法读取进程记录：${error.message}`)
  }

  for (const name of ['web', 'api', 'launcher']) stopTree(record[name])
  rmSync(processFile, { force: true })
  console.log('DeepSeek Harness 已关闭。')
}

async function isHealthy() {
  try {
    const response = await fetch(webUrl, { signal: AbortSignal.timeout(1000) })
    return response.ok
  } catch {
    return false
  }
}

async function waitHealthy(seconds) {
  const deadline = Date.now() + seconds * 1000
  while (Date.now() < deadline) {
    if (await isHealthy()) return true
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 250))
  }
  return false
}

async function main() {
  if (process.argv.includes('--stop')) {
    stopSavedProcesses()
    return
  }

  if (process.argv.includes('--background')) {
    if (await isHealthy()) {
      throw new Error('端口 3080 已被占用。请先运行 stop-agent.cmd。')
    }
    mkdirSync(logDir, { recursive: true })
    const stdout = openSync(join(logDir, 'harness-api.out.log'), 'a')
    const stderr = openSync(join(logDir, 'harness-api.err.log'), 'a')
    try {
      const child = spawn(process.execPath, [fileURLToPath(import.meta.url)], {
        cwd: root,
        detached: true,
        env: cleanEnvironment(),
        windowsHide: true,
        stdio: ['ignore', stdout, stderr],
      })
      child.unref()
      console.log(`DeepSeek Harness 后台启动中（PID ${child.pid}）。`)
    } finally {
      closeSync(stdout)
      closeSync(stderr)
    }
    return
  }

  if (!existsSync(dsh)) {
    throw new Error('找不到 DeepSeek Harness。请先在项目目录运行 npm install。')
  }
  if (await isHealthy()) {
    throw new Error('端口 3080 已被占用。请先运行 stop-agent.cmd。')
  }

  mkdirSync(logDir, { recursive: true })
  const env = cleanEnvironment({
    DSH_HOME: join(root, '.dsh'),
    DSH_CWD: root,
  })
  const command = process.env.ComSpec ?? 'cmd.exe'
  const web = spawn(command, ['/d', '/c', dsh, 'web'], {
    cwd: root,
    env,
    stdio: 'inherit',
  })

  writeFileSync(
    processFile,
    JSON.stringify({ launcher: process.pid, api: null, web: web.pid }),
    'utf8',
  )

  let stopping = false
  const shutdown = () => {
    if (stopping) return
    stopping = true
    stopTree(web.pid)
    rmSync(processFile, { force: true })
  }
  process.once('SIGINT', shutdown)
  process.once('SIGTERM', shutdown)
  process.once('exit', () => rmSync(processFile, { force: true }))

  if (!(await waitHealthy(20))) {
    shutdown()
    throw new Error('Harness Web 启动失败，请查看当前终端或 .dsh/logs/harness-api.err.log。')
  }

  console.log(`\nDeepSeek Harness 已启动：${webUrl}`)
  console.log('默认模型：deepseek-official / deepseek-v4-flash')
  console.log('请在网页的 设置 -> 模型 中保存 DEEPSEEK_API_KEY；无需重启。')
  console.log('按 Ctrl+C 可关闭本次启动的 Harness。\n')

  const exitCode = await new Promise((resolvePromise) => {
    web.once('exit', (code) => resolvePromise(code ?? 1))
  })
  rmSync(processFile, { force: true })
  process.exitCode = stopping ? 0 : exitCode
}

main().catch((error) => {
  console.error(error.message)
  process.exitCode = 1
})

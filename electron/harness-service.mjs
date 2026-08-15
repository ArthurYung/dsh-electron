import { spawn, spawnSync } from 'node:child_process'
import { createWriteStream, existsSync, mkdirSync, readFileSync } from 'node:fs'
import { delimiter, join } from 'node:path'

export const HARNESS_URL = 'http://127.0.0.1:3080/'

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

function defaultKillTree(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return
  if (process.platform === 'win32') {
    const taskkill = join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'taskkill.exe')
    spawnSync(taskkill, ['/PID', String(pid), '/T', '/F'], {
      env: cleanEnvironment(),
      stdio: 'ignore',
      windowsHide: true,
    })
    return
  }
  try {
    process.kill(pid, 'SIGTERM')
  } catch (error) {
    if (error?.code !== 'ESRCH') throw error
  }
}

function delay(milliseconds) {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, milliseconds))
}

export function isHarnessHtml(text) {
  return typeof text === 'string' && text.includes('window.__DSH_BOOT__')
}

export class HarnessService {
  constructor({
    appPath,
    nodePath,
    patchPath,
    harnessHome,
    workingDirectory,
    logsDirectory = join(harnessHome, 'logs'),
    fetchImpl = globalThis.fetch,
    spawnProcess = spawn,
    killTree = defaultKillTree,
    startupTimeoutMs = 30_000,
    pollIntervalMs = 250,
  }) {
    this.appPath = appPath
    this.nodePath = nodePath
    this.patchPath = patchPath
    this.harnessHome = harnessHome
    this.workingDirectory = workingDirectory
    this.logsDirectory = logsDirectory
    this.fetchImpl = fetchImpl
    this.spawnProcess = spawnProcess
    this.killTree = killTree
    this.startupTimeoutMs = startupTimeoutMs
    this.pollIntervalMs = pollIntervalMs
    this.child = null
    this.owned = false
    this.launchError = null
    this.stdoutLog = null
    this.stderrLog = null
  }

  async isHealthy() {
    try {
      const response = await this.fetchImpl(HARNESS_URL, {
        cache: 'no-store',
        signal: AbortSignal.timeout(1_500),
      })
      if (!response.ok) return false
      return isHarnessHtml(await response.text())
    } catch {
      return false
    }
  }

  async start() {
    if (await this.isHealthy()) return { owned: false, url: HARNESS_URL }

    const cliPath = join(this.appPath, 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js')
    if (!existsSync(cliPath)) {
      throw new Error(`找不到 DeepSeek Harness CLI：${cliPath}`)
    }
    if (this.patchPath && !existsSync(this.patchPath)) {
      throw new Error(`找不到 Electron Harness 配置覆盖：${this.patchPath}`)
    }

    mkdirSync(this.harnessHome, { recursive: true })
    mkdirSync(this.workingDirectory, { recursive: true })
    mkdirSync(this.logsDirectory, { recursive: true })

    this.stdoutLog = createWriteStream(join(this.logsDirectory, 'electron-harness.out.log'), { flags: 'a' })
    this.stderrLog = createWriteStream(join(this.logsDirectory, 'electron-harness.err.log'), { flags: 'a' })

    const env = cleanEnvironment({
      DSH_HOME: this.harnessHome,
      DSH_CWD: this.workingDirectory,
      DSH_DESKTOP_APP_ROOT: this.appPath,
    })
    const cliArguments = [cliPath, '--profile', 'web']
    if (this.patchPath) cliArguments.push('--patch', this.patchPath)
    const child = this.spawnProcess(this.nodePath, cliArguments, {
      cwd: this.workingDirectory,
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    })
    this.child = child
    this.owned = true
    child.stdout?.pipe(this.stdoutLog)
    child.stderr?.pipe(this.stderrLog)
    child.once('error', (error) => {
      this.launchError = error
    })
    child.once('exit', () => {
      this.stdoutLog?.end()
      this.stderrLog?.end()
    })

    const deadline = Date.now() + this.startupTimeoutMs
    while (Date.now() < deadline) {
      if (this.launchError) break
      if (child.exitCode !== null) break
      if (await this.isHealthy()) return { owned: true, url: HARNESS_URL }
      await delay(this.pollIntervalMs)
    }

    this.stop()
    const detail = this.launchError?.message ?? this.readErrorTail()
    throw new Error(`Harness Web 启动失败。${detail ? `\n${detail}` : ''}`)
  }

  stop() {
    const child = this.child
    const shouldKill = this.owned && child && child.exitCode === null
    this.owned = false
    this.child = null
    if (shouldKill) this.killTree(child.pid)
    this.stdoutLog?.end()
    this.stderrLog?.end()
    this.stdoutLog = null
    this.stderrLog = null
  }

  readErrorTail() {
    const errorPath = join(this.logsDirectory, 'electron-harness.err.log')
    if (!existsSync(errorPath)) return ''
    try {
      const text = readFileSync(errorPath, 'utf8')
      return text.slice(-2_000).trim()
    } catch {
      return ''
    }
  }
}

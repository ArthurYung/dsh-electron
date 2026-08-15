import { spawn } from 'node:child_process'
import { mkdir } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

// Packaged presets live under the user's DSH_HOME, outside Electron's app tree.
// Resolve the Harness tool API from the packaged app root in that case; local
// development and direct tests can continue to use normal package resolution.
const desktopAppRoot = process.env.DSH_DESKTOP_APP_ROOT
const toolsModule = desktopAppRoot
  ? await import(pathToFileURL(join(
      desktopAppRoot,
      'node_modules',
      '@deepseek-ai',
      'dsh-tools',
      'lib',
      'index.js',
    )).href)
  : await import('@deepseek-ai/dsh-tools')
const { defineTool } = toolsModule

export const name = 'tool-computer-use-windows'
export const inject = ['tools']

const scriptPath = fileURLToPath(new URL('./windows-computer-use.ps1', import.meta.url))
const snapshots = new Map()
const MAX_OUTPUT_BYTES = 2 * 1024 * 1024

function cleanEnvironment() {
  const env = {}
  const paths = []
  for (const [key, value] of Object.entries(process.env)) {
    if (key.toLowerCase() === 'path') {
      if (value) paths.push(...value.split(';'))
      continue
    }
    if (value !== undefined) env[key] = value
  }
  env.Path = [...new Set(paths)].join(';')
  return env
}

function powershellPath() {
  return join(
    process.env.SystemRoot ?? 'C:\\Windows',
    'System32',
    'WindowsPowerShell',
    'v1.0',
    'powershell.exe',
  )
}

function sessionKey(exec) {
  const id = exec.agent?.session?.id
  if (typeof id !== 'string' || id.length === 0) {
    throw new Error('Computer Use 必须在一个有效的 Agent 会话中运行。')
  }
  return id
}

async function runPowerShell(operation, payload, signal) {
  const encoded = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64')
  const child = spawn(
    powershellPath(),
    [
      '-NoLogo',
      '-NoProfile',
      '-NonInteractive',
      '-STA',
      '-ExecutionPolicy',
      'Bypass',
      '-File',
      scriptPath,
      '-Operation',
      operation,
      '-PayloadBase64',
      encoded,
    ],
    {
      cwd: dirname(scriptPath),
      env: cleanEnvironment(),
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    },
  )

  let stdout = Buffer.alloc(0)
  let stderr = Buffer.alloc(0)
  let outputTooLarge = false
  const append = (current, chunk) => {
    if (current.length + chunk.length > MAX_OUTPUT_BYTES) {
      outputTooLarge = true
      child.kill()
      return current
    }
    return Buffer.concat([current, chunk])
  }
  child.stdout.on('data', (chunk) => {
    stdout = append(stdout, chunk)
  })
  child.stderr.on('data', (chunk) => {
    stderr = append(stderr, chunk)
  })

  const abort = () => child.kill()
  if (signal.aborted) abort()
  else signal.addEventListener('abort', abort, { once: true })

  const result = await new Promise((resolvePromise, rejectPromise) => {
    child.once('error', rejectPromise)
    child.once('close', (code) => resolvePromise({ code }))
  }).finally(() => signal.removeEventListener('abort', abort))

  if (signal.aborted) throw new Error('Computer Use 操作已取消。')
  if (outputTooLarge) throw new Error('Computer Use 返回内容超过 2 MiB 安全上限。')
  if (result.code !== 0) {
    const message = stderr.toString('utf8').trim() || `PowerShell 退出码 ${result.code}`
    throw new Error(`Computer Use 执行失败：${message}`)
  }

  const text = stdout.toString('utf8').replace(/^\uFEFF/, '').trim()
  try {
    return JSON.parse(text)
  } catch {
    throw new Error(`Computer Use 返回了无效 JSON：${text.slice(0, 500)}`)
  }
}

function renderObservation(value) {
  const lines = [
    `Window: ${value.window.title || '(untitled)'}`,
    `Process: ${value.window.processName || '(unknown)'}; Handle: ${value.window.handle}; PID: ${value.window.processId}`,
    `Bounds: x=${value.window.bounds.x}, y=${value.window.bounds.y}, width=${value.window.bounds.width}, height=${value.window.bounds.height}`,
  ]
  if (value.screenshotPath) lines.push(`Screenshot (local only): ${value.screenshotPath}`)
  lines.push(`UI elements (${value.elements.length}):`)
  for (const element of value.elements) {
    const label = element.name ? ` name=${JSON.stringify(element.name)}` : ''
    const automationId = element.automationId
      ? ` automationId=${JSON.stringify(element.automationId)}`
      : ''
    const box = ` (${element.bounds.x},${element.bounds.y},${element.bounds.width},${element.bounds.height})`
    const flags = [
      element.enabled ? 'enabled' : 'disabled',
      element.focused ? 'focused' : '',
      element.interactive ? 'interactive' : '',
    ].filter(Boolean).join(',')
    lines.push(`[${element.ref}] ${element.controlType}${label}${automationId}${box} ${flags}`)
  }
  lines.push('Refs are valid only for the latest observation in this session.')
  return lines.join('\n')
}

function assertSafeTarget(snapshot, args) {
  if (!snapshot) throw new Error('没有可用的界面快照，请先调用 computer_observe。')
  const processName = String(snapshot.window.processName ?? '').toLowerCase()
  const title = String(snapshot.window.title ?? '').toLowerCase()
  const className = String(snapshot.window.className ?? '').toLowerCase()
  const blockedProcesses = new Set([
    'windowsterminal', 'openconsole', 'cmd', 'powershell', 'pwsh',
    'lockapp', 'credentialuibroker', 'logonui', 'sechealthui', 'msmpeng',
    '1password', 'bitwarden', 'keepass', 'lastpass', 'dashlane',
  ])
  if (blockedProcesses.has(processName)) {
    throw new Error(`安全策略禁止通过 Computer Use 控制进程 ${snapshot.window.processName}。`)
  }
  const blockedTitle = /(windows security|windows 安全|captcha|验证码|authentication|身份验证|sign in|登录|password|密码)/i
  if (blockedTitle.test(title)) {
    throw new Error(`安全策略禁止通过 Computer Use 控制登录、验证或安全窗口：${snapshot.window.title}。`)
  }
  if (className === '#32770' && /(^|\b)(run|运行)(\b|$)/i.test(title)) {
    throw new Error('安全策略禁止通过 Computer Use 控制 Windows Run 对话框。')
  }
  if (args.action === 'keypress' && /(^|\+)(win|windows|meta|cmd|command|super|os)(\+|$)/i.test(args.keys ?? '')) {
    throw new Error('安全策略禁止 Windows/Meta/Command 键组合。')
  }
}

function resolveTarget(args, snapshot) {
  if (args.ref !== undefined) {
    if (!snapshot) throw new Error('没有可用的界面快照，请先调用 computer_observe。')
    const element = snapshot.elements.find((item) => item.ref === args.ref)
    if (!element) throw new Error(`快照中不存在元素引用 ${JSON.stringify(args.ref)}，请重新观察界面。`)
    if (element.bounds.width <= 0 || element.bounds.height <= 0) {
      throw new Error(`元素 ${args.ref} 没有可点击区域，请重新观察或使用明确坐标。`)
    }
    return {
      x: Math.round(element.bounds.x + element.bounds.width / 2),
      y: Math.round(element.bounds.y + element.bounds.height / 2),
      target: `${args.ref} (${element.controlType}${element.name ? `: ${element.name}` : ''})`,
    }
  }
  if (args.x !== undefined && args.y !== undefined) {
    return { x: Math.round(args.x), y: Math.round(args.y), target: `(${args.x}, ${args.y})` }
  }
  return { target: 'current focus' }
}

export function apply(ctx) {
  ctx.on('tools/pre-execute', (exec, next) => {
    if (exec.name !== 'computer_action') return next()
    const action = typeof exec.arguments?.action === 'string' ? exec.arguments.action : 'unknown'
    return Promise.resolve({
      kind: 'ask',
      reason: `Computer Use 将在 Windows 桌面执行 ${action} 操作。`,
    })
  })

  ctx.tools.register(defineTool({
    name: 'computer_observe',
    description: 'Observe the Windows foreground window or a window whose title contains the supplied text. Returns a compact UI Automation tree with short refs. Optionally saves a local screenshot; the screenshot is not uploaded to the text-only model. Call this before every action and again after the UI changes.',
    parameters: {
      window_title: {
        type: 'string',
        description: 'Optional case-insensitive substring of a top-level window title. Omit to inspect the foreground window.',
      },
      max_depth: {
        type: 'integer',
        description: 'Maximum UI Automation tree depth, 1-8. Default: 5.',
      },
      max_elements: {
        type: 'integer',
        description: 'Maximum returned elements, 10-300. Default: 120.',
      },
      include_screenshot: {
        type: 'boolean',
        description: 'Save a PNG under .dsh/computer-use/screenshots and return its local path. Default: false.',
      },
      delay_ms: {
        type: 'integer',
        description: 'Wait 0-10000 ms before observing, useful after an action. Default: 0.',
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          window: {
            type: 'object',
            required: true,
            additionalProperties: false,
            properties: {
              handle: { type: 'integer', required: true },
              title: { type: 'string', required: true },
              processId: { type: 'integer', required: true },
              processName: { type: 'string', required: true },
              className: { type: 'string', required: true },
              bounds: {
                type: 'object',
                required: true,
                additionalProperties: false,
                properties: {
                  x: { type: 'integer', required: true },
                  y: { type: 'integer', required: true },
                  width: { type: 'integer', required: true },
                  height: { type: 'integer', required: true },
                },
              },
            },
          },
          screenshotPath: { type: 'string' },
          elements: {
            type: 'array',
            required: true,
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                ref: { type: 'string', required: true },
                depth: { type: 'integer', required: true },
                name: { type: 'string', required: true },
                automationId: { type: 'string', required: true },
                className: { type: 'string', required: true },
                controlType: { type: 'string', required: true },
                enabled: { type: 'boolean', required: true },
                focused: { type: 'boolean', required: true },
                interactive: { type: 'boolean', required: true },
                bounds: {
                  type: 'object',
                  required: true,
                  additionalProperties: false,
                  properties: {
                    x: { type: 'integer', required: true },
                    y: { type: 'integer', required: true },
                    width: { type: 'integer', required: true },
                    height: { type: 'integer', required: true },
                  },
                },
              },
            },
          },
        },
      },
      render: (_args, value) => [{ type: 'text', text: renderObservation(value) }],
    },
    async execute(args, exec) {
      const dshHome = process.env.DSH_HOME ?? join(process.cwd(), '.dsh')
      const screenshotDir = join(dshHome, 'computer-use', 'screenshots')
      await mkdir(screenshotDir, { recursive: true })
      const screenshotPath = join(
        screenshotDir,
        `screen-${new Date().toISOString().replace(/[:.]/g, '-')}.png`,
      )
      const result = await runPowerShell('observe', {
        windowTitle: args.window_title,
        maxDepth: Math.min(8, Math.max(1, args.max_depth ?? 5)),
        maxElements: Math.min(300, Math.max(10, args.max_elements ?? 120)),
        includeScreenshot: args.include_screenshot ?? false,
        screenshotPath,
        delayMs: Math.min(10000, Math.max(0, args.delay_ms ?? 0)),
      }, exec.signal)
      snapshots.set(sessionKey(exec), result)
      return result
    },
    isConcurrencySafe: () => true,
    presentCall: (args) => ({
      card: 'generic',
      title: args.window_title ? `Observe window: ${args.window_title}` : 'Observe foreground window',
      kind: 'search',
      rawInput: args,
    }),
  }))

  ctx.tools.register(defineTool({
    name: 'computer_action',
    description: 'Perform one Windows desktop input action. Always call computer_observe first and prefer a ref from the latest observation over raw coordinates. This tool always requires user approval. After it succeeds, call computer_observe again to verify the resulting UI state.',
    parameters: {
      action: {
        type: 'string',
        required: true,
        enum: ['click', 'double_click', 'move', 'type', 'keypress', 'scroll'],
        description: 'Desktop input action to perform.',
      },
      ref: {
        type: 'string',
        description: 'Element ref from the latest computer_observe result, such as e12.',
      },
      x: { type: 'number', description: 'Absolute screen x coordinate when ref is omitted.' },
      y: { type: 'number', description: 'Absolute screen y coordinate when ref is omitted.' },
      button: {
        type: 'string',
        enum: ['left', 'right'],
        description: 'Mouse button for click actions. Default: left.',
      },
      text: { type: 'string', description: 'Unicode text for the type action.' },
      replace: {
        type: 'boolean',
        description: 'For type: send Ctrl+A before typing. Default: false.',
      },
      keys: {
        type: 'string',
        description: 'One key chord for keypress, such as CTRL+L, ALT+F4, ENTER, TAB, or CTRL+SHIFT+S.',
      },
      scroll_delta: {
        type: 'integer',
        description: 'Mouse-wheel delta. Positive scrolls up, negative scrolls down. Default: -600.',
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          success: { type: 'boolean', required: true },
          action: { type: 'string', required: true },
          target: { type: 'string', required: true },
          message: { type: 'string', required: true },
        },
      },
      render: (_args, value) => [{ type: 'text', text: value.message }],
    },
    async execute(args, exec) {
      const snapshot = snapshots.get(sessionKey(exec))
      assertSafeTarget(snapshot, args)
      const target = resolveTarget(args, snapshot)
      if (['click', 'double_click', 'move'].includes(args.action) && target.x === undefined) {
        throw new Error(`${args.action} 需要 ref 或完整的 x/y 坐标。`)
      }
      if (args.action === 'type' && typeof args.text !== 'string') {
        throw new Error('type 操作需要 text。')
      }
      if (args.action === 'keypress' && (!args.keys || typeof args.keys !== 'string')) {
        throw new Error('keypress 操作需要 keys。')
      }

      const result = await runPowerShell('action', {
        action: args.action,
        windowHandle: snapshot?.window?.handle,
        x: target.x,
        y: target.y,
        button: args.button ?? 'left',
        text: args.text,
        replace: args.replace ?? false,
        keys: args.keys,
        scrollDelta: args.scroll_delta ?? -600,
        target: target.target,
      }, exec.signal)
      return result
    },
    presentCall: (args) => ({
      card: 'generic',
      title: `Computer: ${args.action}`,
      kind: 'other',
      rawInput: args,
    }),
  }))
}

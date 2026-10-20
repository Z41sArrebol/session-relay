import { execFile, spawn } from 'node:child_process'
import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { promisify } from 'node:util'
import type {
  ConnectorInfo,
  ConnectorVerification,
  PackRequest,
  SendRequest,
  SendResult
} from '../../shared/types'
import type { Logger } from './log'
import { relayInstruction } from './handoff'
import type { RelayStore } from './state'

const execFileAsync = promisify(execFile)
const VERIFY_KEY = 'connector.claude.verification.v1'
const VERIFY_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000
const MAX_STDOUT = 6 * 1024 * 1024

interface StoredVerification {
  verifiedAt: number
  latencyMs: number
  cliPath: string
  version: string | null
  responseExcerpt: string
}

interface ClaudeRun {
  ok: boolean
  code: number | null
  stdout: string
  stderr: string
  durationMs: number
  timedOut: boolean
}

function quoteWindowsArg(value: string): string {
  return `"${value.replace(/"/g, '""')}"`
}

function parseClaudeJson(stdout: string): Record<string, unknown> | null {
  const trimmed = stdout.trim()
  if (!trimmed) return null
  const candidates: string[] = []
  candidates.push(trimmed)
  const lines = trimmed.split(/\r?\n/).filter((l) => l.trim().startsWith('{'))
  candidates.push(...lines.reverse())
  const first = trimmed.indexOf('{')
  const last = trimmed.lastIndexOf('}')
  if (first >= 0 && last > first) candidates.push(trimmed.slice(first, last + 1))
  for (const candidate of candidates) {
    try {
      const parsed = JSON.parse(candidate) as Record<string, unknown>
      if (parsed && typeof parsed === 'object') return parsed
    } catch {
      // try next candidate
    }
  }
  return null
}

export class ConnectorService {
  private store: RelayStore
  private logger: Logger
  private userDataDir: string
  private claudeCache: { checkedAt: number; path: string | null; version: string | null } = {
    checkedAt: 0,
    path: null,
    version: null
  }

  constructor(opts: { store: RelayStore; logger: Logger; userDataDir: string }) {
    this.store = opts.store
    this.logger = opts.logger
    this.userDataDir = opts.userDataDir
  }

  private async findClaude(force = false): Promise<{ path: string | null; version: string | null }> {
    const override = process.env.SESSION_RELAY_CLAUDE_PATH
    if (override && override.trim() && existsSync(override.trim())) {
      const run = await this.runClaude(override.trim(), ['--version'], null, this.userDataDir, 20_000)
      return { path: override.trim(), version: run.ok ? run.stdout.trim().split(/\r?\n/)[0] || null : null }
    }
    if (!force && Date.now() - this.claudeCache.checkedAt < 60_000) {
      return { path: this.claudeCache.path, version: this.claudeCache.version }
    }
    let found: string | null = null
    try {
      const { stdout } = await execFileAsync('where.exe', ['claude'], {
        encoding: 'utf8',
        windowsHide: true,
        timeout: 10_000
      })
      const lines = stdout
        .split(/\r?\n/)
        .map((l) => l.trim())
        .filter(Boolean)
      found = lines.find((l) => /\.cmd$/i.test(l)) || lines[0] || null
    } catch {
      found = null
    }
    let version: string | null = null
    if (found) {
      const run = await this.runClaude(found, ['--version'], null, this.userDataDir, 20_000)
      version = run.ok ? run.stdout.trim().split(/\r?\n/)[0] || null : null
    }
    this.claudeCache = { checkedAt: Date.now(), path: found, version }
    return { path: found, version }
  }

  private runClaude(
    cliPath: string,
    args: string[],
    prompt: string | null,
    cwd: string,
    timeoutMs: number
  ): Promise<ClaudeRun> {
    return new Promise((resolve) => {
      const started = Date.now()
      const isCmd = /\.(cmd|bat)$/i.test(cliPath)
      let child
      try {
        // Windows .cmd/.bat shims cannot be spawned without a shell. The
        // arguments are program-controlled constants and a verified path; the
        // user prompt goes over stdin, never into the command line.
        child = spawn(cliPath, args, {
          cwd,
          windowsHide: true,
          env: { ...process.env, NO_COLOR: '1' },
          stdio: ['pipe', 'pipe', 'pipe'],
          shell: isCmd
        })
      } catch (error) {
        resolve({
          ok: false,
          code: null,
          stdout: '',
          stderr: error instanceof Error ? error.message : String(error),
          durationMs: Date.now() - started,
          timedOut: false
        })
        return
      }

      let stdout = ''
      let stderr = ''
      let timedOut = false
      let settled = false
      const finish = (code: number | null) => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        resolve({
          ok: code === 0,
          code,
          stdout,
          stderr,
          durationMs: Date.now() - started,
          timedOut
        })
      }
      const timer = setTimeout(() => {
        timedOut = true
        if (child.pid) {
          try {
            spawn('taskkill', ['/pid', String(child.pid), '/t', '/f'], { windowsHide: true })
          } catch {
            // fall through to child.kill
          }
        }
        try {
          child.kill()
        } catch {
          // ignore
        }
        setTimeout(() => finish(null), 3000)
      }, timeoutMs)

      child.stdout?.on('data', (buf: Buffer) => {
        if (stdout.length < MAX_STDOUT) stdout += buf.toString('utf8')
      })
      child.stderr?.on('data', (buf: Buffer) => {
        if (stderr.length < MAX_STDOUT) stderr += buf.toString('utf8')
      })
      child.on('error', (err) => {
        stderr += `\n${err.message}`
        finish(null)
      })
      child.on('close', (code) => finish(code))
      try {
        if (prompt !== null) child.stdin?.write(prompt)
        child.stdin?.end()
      } catch {
        // stdin closed early; close handler will report
      }
    })
  }

  private readVerification(): StoredVerification | null {
    const raw = this.store.getKv(VERIFY_KEY)
    if (!raw) return null
    try {
      const parsed = JSON.parse(raw) as StoredVerification
      if (!parsed.verifiedAt || typeof parsed.verifiedAt !== 'number') return null
      return parsed
    } catch {
      return null
    }
  }

  private verificationFresh(v: StoredVerification | null): boolean {
    return Boolean(v && Date.now() - v.verifiedAt <= VERIFY_MAX_AGE_MS)
  }

  async list(): Promise<ConnectorInfo[]> {
    const claude = await this.findClaude()
    const stored = this.readVerification()
    const fresh = this.verificationFresh(stored)
    return [
      {
        id: 'export',
        label: '导出交接包',
        kind: 'export',
        available: true,
        verified: true,
        verificationState: 'verified',
        verifiedAt: null,
        reason: null,
        detail: '生成文件夹或 ZIP；同时可复制接力指令，粘贴到另一个 Z-Code 会话。',
        primary: true
      },
      {
        id: 'claude-cli',
        label: 'Claude Code CLI（候选发送目标）',
        kind: 'cli',
        available: Boolean(claude.path),
        verified: Boolean(fresh),
        verificationState: fresh ? 'verified' : 'candidate',
        verifiedAt: fresh ? stored!.verifiedAt : null,
        reason: !claude.path
          ? '本机未找到 claude 命令'
          : fresh
            ? null
            : stored
              ? '上次验证已超过 30 天，需要重新自检'
              : '尚未完成一次经确认的任务往返；不能称为已验证连接器',
        detail: claude.path
          ? `找到 ${claude.path}${claude.version ? `（${claude.version}）` : ''}。它不一定沿用 Z-Code 的模型额度。`
          : '未安装或不在 PATH 中。',
        primary: false
      },
      {
        id: 'zcode-session',
        label: '另一个 Z-Code 会话',
        kind: 'unsupported',
        available: false,
        verified: false,
        verificationState: 'unsupported',
        verifiedAt: null,
        reason: 'Z-Code 没有公开的外部启动/发送入口；不写内部队列表，也不模拟 UI。',
        detail: '仅支持导出交接包后，在该会话里手动粘贴接力指令。',
        primary: false
      }
    ]
  }

  async verify(connectorId: string, confirmed: boolean): Promise<ConnectorVerification> {
    if (connectorId !== 'claude-cli') {
      throw new Error('该目标不支持发送验证')
    }
    if (!confirmed) throw new Error('需要用户明确确认后才能发送自检任务')
    const claude = await this.findClaude(true)
    if (!claude.path) {
      return {
        connectorId,
        verified: false,
        verifiedAt: null,
        latencyMs: null,
        detail: '本机未找到 claude 命令',
        responseExcerpt: null,
        error: '未安装 Claude Code CLI'
      }
    }
    const prompt =
      '这是一次连接器自检，不要读取任何文件，不要修改任何内容。只回复这一行，不要添加其他文字：RELAY_CONNECTOR_OK'
    const run = await this.runClaude(
      claude.path,
      ['-p', '--output-format', 'json', '--permission-mode', 'plan'],
      prompt,
      this.userDataDir,
      180_000
    )
    const parsed = parseClaudeJson(run.stdout)
    const resultText = parsed && typeof parsed.result === 'string' ? parsed.result : ''
    const confirmedOk =
      run.code === 0 &&
      parsed !== null &&
      parsed.is_error !== true &&
      resultText.includes('RELAY_CONNECTOR_OK')
    if (!confirmedOk) {
      this.store.setKv(VERIFY_KEY, '')
      this.logger.warn(`connector-verify-failed claude code=${run.code} timedOut=${run.timedOut}`)
      return {
        connectorId,
        verified: false,
        verifiedAt: null,
        latencyMs: run.durationMs,
        detail: '自检未收到预期确认标记，连接器仍是候选状态',
        responseExcerpt: (resultText || run.stderr || run.stdout).slice(0, 1000) || null,
        error: run.timedOut ? '自检超时' : `退出码 ${run.code ?? 'null'}，或返回内容不含 RELAY_CONNECTOR_OK`
      }
    }
    const stored: StoredVerification = {
      verifiedAt: Date.now(),
      latencyMs: run.durationMs,
      cliPath: claude.path,
      version: claude.version,
      responseExcerpt: resultText.slice(0, 500)
    }
    this.store.setKv(VERIFY_KEY, JSON.stringify(stored))
    this.logger.info(`connector-verified claude ms=${run.durationMs}`)
    return {
      connectorId,
      verified: true,
      verifiedAt: stored.verifiedAt,
      latencyMs: run.durationMs,
      detail: `已完成一次真实往返（${run.durationMs} ms），收到 RELAY_CONNECTOR_OK`,
      responseExcerpt: stored.responseExcerpt,
      error: null
    }
  }

  async send(request: SendRequest, packDir: string, projectRoot: string): Promise<SendResult> {
    const base: SendResult = {
      sent: false,
      connectorId: request.connectorId,
      verified: false,
      reason: null,
      message: '',
      output: null,
      exitCode: null,
      durationMs: null,
      packDirectory: packDir
    }
    if (!request.confirmed) {
      return { ...base, reason: 'not-confirmed', message: '发送前必须由用户确认接收目标和内容。' }
    }
    if (request.connectorId === 'zcode-session') {
      return {
        ...base,
        reason: 'unsupported',
        message: 'Z-Code 没有公开的外部发送入口。请使用“导出交接包”，再到目标会话手动粘贴接力指令。'
      }
    }
    if (request.connectorId !== 'claude-cli') {
      return { ...base, reason: 'unsupported', message: '该目标不是可发送的连接器。' }
    }
    const stored = this.readVerification()
    if (!this.verificationFresh(stored)) {
      return {
        ...base,
        reason: 'not-verified',
        message: 'Claude Code CLI 还没有完成连接器自检，或自检已过期。请先验证，再发送。'
      }
    }
    const claude = await this.findClaude()
    if (!claude.path) {
      return { ...base, reason: 'unavailable', message: '本机未找到 claude 命令。' }
    }
    if (!existsSync(path.join(packDir, 'HANDOFF.md'))) {
      return { ...base, reason: 'pack-missing', message: '交接包目录里没有 HANDOFF.md。' }
    }
    const modeArgs = request.mode === 'review' ? ['--permission-mode', 'plan'] : ['--permission-mode', 'acceptEdits']
    const prompt = [
      relayInstruction(request.mode),
      '',
      `交接包目录：${packDir}`,
      `项目目录：${projectRoot}`,
      '',
      `请先读取 ${path.join(packDir, 'HANDOFF.md')}，再按其中的接力指令执行。`
    ].join('\n')
    const run = await this.runClaude(
      claude.path,
      ['-p', '--output-format', 'json', ...modeArgs, '--add-dir', packDir, '--add-dir', projectRoot],
      prompt,
      projectRoot,
      15 * 60 * 1000
    )
    const parsed = parseClaudeJson(run.stdout)
    const resultText = parsed && typeof parsed.result === 'string' ? parsed.result : ''
    const success = run.code === 0 && parsed !== null && parsed.is_error !== true
    this.writeSendLog({
      at: Date.now(),
      sessionId: request.sessionId,
      connectorId: request.connectorId,
      mode: request.mode,
      packDir,
      projectRoot,
      success,
      code: run.code,
      durationMs: run.durationMs,
      resultExcerpt: resultText.slice(0, 4000),
      stderrExcerpt: run.stderr.slice(0, 2000)
    })
    if (!success) {
      this.logger.warn(`send-failed session=${request.sessionId} code=${run.code} timedOut=${run.timedOut}`)
      return {
        ...base,
        reason: run.timedOut ? 'timeout' : 'target-error',
        message: run.timedOut
          ? '目标 Agent 超时未返回，未确认接收。'
          : '目标 Agent 没有返回成功确认，不能显示为已发送。',
        output: (resultText || run.stderr || run.stdout).slice(0, 4000) || null,
        exitCode: run.code,
        durationMs: run.durationMs,
        verified: true
      }
    }
    this.logger.info(`send-ok session=${request.sessionId} ms=${run.durationMs}`)
    return {
      sent: true,
      connectorId: request.connectorId,
      verified: true,
      reason: null,
      message: '目标 Agent 已返回成功确认。',
      output: resultText.slice(0, 8000) || null,
      exitCode: run.code,
      durationMs: run.durationMs,
      packDirectory: packDir
    }
  }

  private writeSendLog(entry: Record<string, unknown>): void {
    try {
      const dir = path.join(this.userDataDir, 'sends')
      mkdirSync(dir, { recursive: true })
      const name = `${new Date().toISOString().replace(/[:.]/g, '-')}-${String(entry.sessionId).slice(-8)}.json`
      writeFileSync(path.join(dir, name), JSON.stringify(entry, null, 2), 'utf8')
    } catch {
      // metadata logging must never break sending
    }
  }
}

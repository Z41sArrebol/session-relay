import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { spawn, spawnSync } from 'node:child_process'
import path from 'node:path'
import { RelayStore } from '../../src/main/core/state'
import { ZcodeReader } from '../../src/main/core/zcode/reader'
import { Observer } from '../../src/main/core/observer'
import { getGitEvidence } from '../../src/main/core/git'
import { preparePack, writePack, relayInstruction } from '../../src/main/core/handoff'
import { buildRecoveryBrief } from '../../src/main/core/recovery'
import { ConnectorService } from '../../src/main/core/connectors'
import type { Logger } from '../../src/main/core/log'

const logger = { info: () => undefined, warn: () => undefined, error: () => undefined } as unknown as Logger

interface RunResult {
  ok: boolean
  durationMs: number
  result: string
  stderr: string
}

function runClaude(cliPath: string, args: string[], prompt: string, cwd: string, timeoutMs: number): Promise<RunResult> {
  return new Promise((resolve) => {
    const started = Date.now()
    const isCmd = /\.(cmd|bat)$/i.test(cliPath)
    const child = spawn(cliPath, args, {
      cwd,
      windowsHide: true,
      env: { ...process.env, NO_COLOR: '1' },
      stdio: ['pipe', 'pipe', 'pipe'],
      shell: isCmd
    })
    let out = ''
    let err = ''
    const timer = setTimeout(() => {
      try {
        if (child.pid) spawn('taskkill', ['/pid', String(child.pid), '/t', '/f'], { windowsHide: true })
      } catch {
        // ignore
      }
      child.kill()
    }, timeoutMs)
    child.stdout?.on('data', (b: Buffer) => (out += b.toString('utf8')))
    child.stderr?.on('data', (b: Buffer) => (err += b.toString('utf8')))
    child.on('close', (code) => {
      clearTimeout(timer)
      resolve({ ok: code === 0, durationMs: Date.now() - started, result: out, stderr: err })
    })
    child.stdin?.write(prompt)
    child.stdin?.end()
  })
}

const ACCEPTANCE_TEST = `import { describe, expect, it } from 'vitest'
import { rankingMetric, windowSourceLabel } from './lib'
import type { Entry } from './types'

const entry: Entry = {
  id: 'acme/voice',
  repo: 'acme/voice',
  name: 'Voice',
  description: 'voice tool',
  category: '趋势项目',
  tags: [],
  reason: '',
  kind: 'project',
  featured: false,
  url: '',
  stars: 1000,
  growth: 50
}

describe('P0-2 acceptance: ranking metric and source', () => {
  it('rate mode uses percentage as the main value', () => {
    const metric = rankingMetric(entry, 'rate', 'daily')
    expect(metric.value).toContain('%')
    expect(metric.value).toContain('5')
    expect(metric.detail).toContain('新增')
    expect(metric.detail).toContain('基数')
  })

  it('stars mode uses window growth and shows total stars', () => {
    const metric = rankingMetric(entry, 'stars', 'weekly')
    expect(metric.value).toContain('50')
    expect(metric.detail).toContain('总 Star')
    expect(metric.label).toContain('新增')
  })

  it('new mode explains first-seen or creation date', () => {
    const metric = rankingMetric(entry, 'new', 'monthly')
    expect(metric.value).toContain('50')
    expect(metric.detail).toMatch(/首次收录|创建/)
  })

  it('labels GitHub fallback per window', () => {
    expect(windowSourceLabel(entry, 'daily')).toBe('GitHub 当日')
    expect(windowSourceLabel(entry, 'weekly')).toBe('GitHub 周榜补充')
    expect(windowSourceLabel(entry, 'monthly')).toBe('GitHub 月榜补充')
  })
})
`

async function main(): Promise<void> {
  const sessionId = process.env.SESSION_RELAY_REAL_SESSION
  const projectRoot = process.env.SESSION_RELAY_PROJECT_ROOT
  if (!sessionId || !projectRoot) throw new Error('需要 SESSION_RELAY_REAL_SESSION 与 SESSION_RELAY_PROJECT_ROOT')
  const workDir = path.join(process.cwd(), 'docs', 'demo', 'real-handoff-p02')
  rmSync(workDir, { recursive: true, force: true })
  mkdirSync(workDir, { recursive: true })
  const evidence: Array<Record<string, unknown>> = []

  const reader = new ZcodeReader(process.env.SESSION_RELAY_ZCODE_DB || require('../../src/main/core/paths').defaultZcodeDbPath())
  const store = new RelayStore(path.join(workDir, 'relay.sqlite'))
  const observer = new Observer({ store, reader, logger, emit: () => undefined })
  await observer.attach(sessionId, projectRoot)
  const row = observer.getRow(sessionId)
  const timeline = observer.getTimeline(sessionId)
  const git = await getGitEvidence({ sessionId, projectRoot, baseline: row.baseline, live: row.live })
  const ctx = {
    row,
    git,
    timeline: timeline.items,
    tokens: timeline.tokens,
    summary: null,
    todos: store.getTodos(sessionId),
    turns: store.getTurns(sessionId),
    modelErrorCount: store.countModelErrors(sessionId)
  }
  const brief = buildRecoveryBrief(ctx)
  const plan = await preparePack(ctx, {
    sessionId,
    mode: 'review',
    filePaths: [],
    includeFullFiles: false,
    extraNotes:
      '接手实验：这是真实中断会话的 P0-2。基线是会话开始时的 HEAD，工作区干净；需要真正实现榜单指标与来源标注。'
  })
  const packDir = path.join(workDir, 'pack')
  writePack(plan, packDir)
  evidence.push({ step: 'build', sessionId, confidence: brief.confidence, score: brief.confidenceScore, signals: brief.signals.map((s) => s.id), todoCount: brief.incompleteTodos.length })

  const connectors = new ConnectorService({ store, logger, userDataDir: workDir })
  const verification = await connectors.verify('claude-cli', true)
  evidence.push({ step: 'verify-connector', verified: verification.verified, detail: verification.detail })
  if (!verification.verified) {
    writeFileSync(path.join(workDir, 'result.json'), JSON.stringify({ ok: false, reason: 'connector-not-verified', evidence }, null, 2), 'utf8')
    console.log(JSON.stringify({ ok: false, reason: 'connector-not-verified' }, null, 2))
    reader.close()
    store.close()
    return
  }
  const claude = await connectors.list().then((list) => list.find((c) => c.id === 'claude-cli'))
  const cliPath = process.env.SESSION_RELAY_CLAUDE_PATH || claude?.detail.match(/找到 (.+?)(?:（|$)/)?.[1]
  if (!cliPath) throw new Error('claude CLI not found')

  const reviewPrompt = [
    relayInstruction('review'),
    '',
    `交接包目录：${packDir}`,
    `项目目录：${projectRoot}`,
    '',
    `请先读取 ${path.join(packDir, 'HANDOFF.md')}。`,
    '这次要验收的是 P0-2：榜单指标与来源标注是否实现。当前项目是会话开始时的 HEAD，工作区干净。',
    '只回复 PASS 或 BLOCKER，并列出最多 3 条问题，每条附证据路径。最后一行输出 ACCEPTANCE_REVIEW_DONE。'
  ].join('\n')
  const review = await runClaude(cliPath, ['-p', '--output-format', 'json', '--permission-mode', 'plan', '--add-dir', packDir, '--add-dir', projectRoot], reviewPrompt, projectRoot, 10 * 60 * 1000)
  writeFileSync(path.join(workDir, 'review.json'), review.result, 'utf8')
  evidence.push({ step: 'review', ok: review.ok, durationMs: review.durationMs })

  const implPrompt = [
    relayInstruction('implement'),
    '',
    `交接包目录：${packDir}`,
    `项目目录：${projectRoot}`,
    '',
    `请先读取 ${path.join(packDir, 'HANDOFF.md')}。`,
    '继续完成 P0-2：榜单指标与来源标注。允许修改 src/lib.ts、src/types.ts、src/App.tsx、src/lib.test.ts，不要动其他文件。',
    '必须导出以下两个函数（名称与签名固定，供验收脚本调用）：',
    '- `export type RankMode = "stars" | "rate" | "new"`',
    '- `export function rankingMetric(entry: Entry, mode: RankMode, period: Period): { value: string; label: string; detail: string }`',
    '- `export function windowSourceLabel(entry: Entry, period: Period): string | null`',
    '行为要求：',
    '- rate 模式：主值是窗口增长百分比，detail 含新增 Star 与计算基数。',
    '- stars 模式：主值是窗口新增 Star，detail 含当前总 Star。',
    '- new 模式：主值是窗口新增 Star，detail 含首次收录或创建日期（数据缺失时写未知）。',
    '- baseline 数据只有 GitHub 趋势快照，没有本站历史：windowSourceLabel 对 daily/weekly/monthly 分别返回“GitHub 当日”“GitHub 周榜补充”“GitHub 月榜补充”，不要冒充本站趋势。',
    '- 榜单卡片必须调用 rankingMetric，不能保留卡片内另一套指标逻辑。',
    '- 在 src/lib.test.ts 增加对应单元测试。',
    '不要提交，不要改 README/验收文档/node_modules。最后一行输出 ACCEPTANCE_IMPL_DONE。'
  ].join('\n')
  const impl = await runClaude(cliPath, ['-p', '--output-format', 'json', '--permission-mode', 'acceptEdits', '--add-dir', packDir, '--add-dir', projectRoot], implPrompt, projectRoot, 15 * 60 * 1000)
  writeFileSync(path.join(workDir, 'impl.json'), impl.result, 'utf8')
  evidence.push({ step: 'implement', ok: impl.ok, durationMs: impl.durationMs })

  // Independent acceptance test, written by us, not by the receiver.
  writeFileSync(path.join(projectRoot, 'src', '__acceptance_p02.test.ts'), ACCEPTANCE_TEST, 'utf8')

  const electronBin = path.join(process.cwd(), 'node_modules', 'electron', 'dist', 'electron.exe')
  const vitestBin = path.join(process.cwd(), 'node_modules', 'vitest', 'vitest.mjs')
  const vitestRun = spawnSync(
    electronBin,
    [vitestBin, 'run', '--root', projectRoot, 'src/__acceptance_p02.test.ts', 'src/lib.test.ts', '--reporter=dot'],
    { cwd: projectRoot, windowsHide: true, encoding: 'utf8', env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }, timeout: 180_000 }
  )
  const testOut = `${vitestRun.stdout || ''}\n${vitestRun.stderr || ''}`
  const testPassed = vitestRun.status === 0

  const status = spawnSync('git', ['-C', projectRoot, 'status', '--porcelain'], { encoding: 'utf8', windowsHide: true })
  const changed = (status.stdout || '').split('\n').filter(Boolean)
  const changedFiles = changed.map((l) => l.slice(3).trim())
  const libChanged = changedFiles.some((f) => f === 'src/lib.ts')
  const uiChanged = changedFiles.some((f) => f === 'src/App.tsx')
  const testChanged = changedFiles.some((f) => f === 'src/lib.test.ts')

  const final = {
    ok: review.ok && impl.ok && testPassed && libChanged && uiChanged && testChanged,
    evidence,
    evaluation: {
      reviewOk: review.ok,
      implOk: impl.ok,
      independentTestPassed: testPassed,
      independentTestExitCode: vitestRun.status,
      independentTestTail: testOut.slice(-1500),
      libChanged,
      uiChanged,
      testChanged,
      changedFiles,
      packDir
    }
  }
  writeFileSync(path.join(workDir, 'result.json'), JSON.stringify(final, null, 2), 'utf8')
  console.log(JSON.stringify(final, null, 2))
  reader.close()
  store.close()
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})

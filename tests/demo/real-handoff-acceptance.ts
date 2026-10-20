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

async function main(): Promise<void> {
  const sessionId = process.env.SESSION_RELAY_REAL_SESSION
  const projectRoot = process.env.SESSION_RELAY_PROJECT_ROOT
  if (!sessionId || !projectRoot) {
    throw new Error('需要 SESSION_RELAY_REAL_SESSION 与 SESSION_RELAY_PROJECT_ROOT')
  }
  const dbPath = process.env.SESSION_RELAY_ZCODE_DB || undefined
  const workDir = path.join(process.cwd(), 'docs', 'demo', 'real-handoff-acceptance')
  rmSync(workDir, { recursive: true, force: true })
  mkdirSync(workDir, { recursive: true })
  const evidence: Array<Record<string, unknown>> = []

  const reader = new ZcodeReader(dbPath || require('../../src/main/core/paths').defaultZcodeDbPath())
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
    extraNotes: '接手实验：这是真实中断的工作会话，不是演示数据。'
  })
  const packDir = path.join(workDir, 'pack')
  writePack(plan, packDir)
  evidence.push({
    step: 'build',
    sessionId,
    confidence: brief.confidence,
    confidenceScore: brief.confidenceScore,
    signals: brief.signals.map((s) => s.id),
    latestGoalLength: brief.latestGoal.length
  })

  const connectors = new ConnectorService({ store, logger, userDataDir: workDir })
  const verification = await connectors.verify('claude-cli', true)
  evidence.push({ step: 'verify-connector', verified: verification.verified, detail: verification.detail, latencyMs: verification.latencyMs, error: verification.error })
  if (!verification.verified) {
    writeFileSync(path.join(workDir, 'result.json'), JSON.stringify({ ok: false, reason: 'connector-not-verified', evidence }, null, 2), 'utf8')
    console.log(JSON.stringify({ ok: false, reason: 'connector-not-verified' }, null, 2))
    reader.close()
    store.close()
    return
  }
  const claude = await connectors.list().then((list) => list.find((c) => c.id === 'claude-cli'))
  const cliPath = process.env.SESSION_RELAY_CLAUDE_PATH || claude?.detail.match(/找到 (.+?)(?:（|$)/)?.[1]
  if (!cliPath) {
    writeFileSync(path.join(workDir, 'result.json'), JSON.stringify({ ok: false, reason: 'cli-not-found', evidence }, null, 2), 'utf8')
    console.log(JSON.stringify({ ok: false, reason: 'cli-not-found' }, null, 2))
    reader.close()
    store.close()
    return
  }

  // --- Phase 1: independent review ---
  const reviewPrompt = [
    relayInstruction('review'),
    '',
    `交接包目录：${packDir}`,
    `项目目录：${projectRoot}`,
    '',
    `请先读取 ${path.join(packDir, 'HANDOFF.md')}，再按其中的接力指令执行。`,
    '验收目标：判断这个中断会话恢复出来的材料是否足够让另一个 Agent 接手。不要修改任何文件。',
    '只回复验收结论：PASS 或 BLOCKER，并列出最多 3 条问题（如果有），每条附证据路径。',
    '最后单独一行输出：ACCEPTANCE_REVIEW_DONE'
  ].join('\n')
  const review = await runClaude(
    cliPath,
    ['-p', '--output-format', 'json', '--permission-mode', 'plan', '--add-dir', packDir, '--add-dir', projectRoot],
    reviewPrompt,
    projectRoot,
    10 * 60 * 1000
  )
  writeFileSync(path.join(workDir, 'review.json'), review.result, 'utf8')
  evidence.push({ step: 'review', ok: review.ok, durationMs: review.durationMs })

  // --- Phase 2: continue implementation ---
  // The user wants the agent to continue the stalled work. We allow edits
  // only within the project directory and ask for the original P0-1 task.
  const implPrompt = [
    relayInstruction('implement'),
    '',
    `交接包目录：${packDir}`,
    `项目目录：${projectRoot}`,
    '',
    `请先读取 ${path.join(packDir, 'HANDOFF.md')}，再按其中的接力指令执行。`,
    '继续完成会话里 P0-1 的任务：让“语音克隆”“配音”这类中文关键词能在搜索里命中对应项目。',
    '允许修改的范围：项目目录内的源码文件。不要提交，不要改 README/验收文档，不要动 node_modules。',
    '完成标准：给出你修改的文件、你运行的验证命令与退出码。',
    '如果 `npm test` 被权限拦截，明确写“权限拦截，未实际运行”，不要声称已验证。',
    '最后单独一行输出：ACCEPTANCE_IMPL_DONE'
  ].join('\n')
  const impl = await runClaude(
    cliPath,
    ['-p', '--output-format', 'json', '--permission-mode', 'acceptEdits', '--add-dir', packDir, '--add-dir', projectRoot],
    implPrompt,
    projectRoot,
    10 * 60 * 1000
  )
  writeFileSync(path.join(workDir, 'impl.json'), impl.result, 'utf8')
  evidence.push({ step: 'implement', ok: impl.ok, durationMs: impl.durationMs })

  // --- Evaluation: what actually changed in the project ---
  const status = await new Promise<{ code: number | null; out: string }>((resolve) => {
    const child = spawn('git', ['-C', projectRoot, 'status', '--porcelain=v1'], { windowsHide: true })
    let out = ''
    child.stdout?.on('data', (b: Buffer) => (out += b.toString('utf8')))
    child.on('close', (code) => resolve({ code, out }))
  })
  const diff = await new Promise<{ code: number | null; out: string }>((resolve) => {
    const child = spawn('git', ['-C', projectRoot, 'diff', '--stat'], { windowsHide: true })
    let out = ''
    child.stdout?.on('data', (b: Buffer) => (out += b.toString('utf8')))
    child.on('close', (code) => resolve({ code, out }))
  })

  // Parse the agent's own claims from its result text
  let implJson: Record<string, unknown> = {}
  try {
    implJson = JSON.parse(impl.result)
  } catch {
    implJson = { result: impl.result }
  }
  const implText = String(implJson.result || '')
  const claimsTest = /npm\s+test/.test(implText) && /通过|pass|退出码\s*0/i.test(implText)
  const claimsNotRun = /权限拦截|未实际运行|requires approval/i.test(implText)

  // Independently verify the target behavior, not the agent's claim.
  // Use Electron's Node 24 for vitest so the system Node version doesn't matter.
  const electronBin = path.join(process.cwd(), 'node_modules', 'electron', 'dist', 'electron.exe')
  const vitestBin = path.join(process.cwd(), 'node_modules', 'vitest', 'vitest.mjs')
  const vitestRun = spawnSync(
    electronBin,
    [vitestBin, 'run', '--root', projectRoot, 'src/lib.test.ts', '--reporter=dot'],
    {
      cwd: projectRoot,
      windowsHide: true,
      encoding: 'utf8',
      env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
      timeout: 180_000
    }
  )
  const vitestOut = `${vitestRun.stdout || ''}\n${vitestRun.stderr || ''}`
  const targetTestPassed = vitestRun.status === 0

  const evaluation = {
    reviewOk: review.ok,
    implOk: impl.ok,
    implClaimsTestPassed: claimsTest,
    implAdmitsNotRun: claimsNotRun,
    gitChangedFiles: diff.out.split('\n').filter(Boolean).length - 1,
    gitStatusChanged: status.out.split('\n').filter(Boolean).length,
    independentVitestExitCode: vitestRun.status,
    independentVitestPassed: targetTestPassed,
    independentVitestTail: vitestOut.slice(-1500),
    packDir,
    reviewFile: path.join(workDir, 'review.json'),
    implFile: path.join(workDir, 'impl.json')
  }
  // Success requires an independent, passing test run of the target behavior.
  // The receiving agent's own claim is recorded but never sufficient.
  const final = {
    ok: review.ok && impl.ok && targetTestPassed,
    evidence,
    evaluation
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

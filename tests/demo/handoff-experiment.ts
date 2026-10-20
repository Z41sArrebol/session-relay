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
import { createHandoffExperiment } from './handoff-experiment-fixture'
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
  const fixture = createHandoffExperiment()
  const workDir = path.join(process.cwd(), 'docs', 'demo', 'handoff-experiment')
  rmSync(workDir, { recursive: true, force: true })
  mkdirSync(workDir, { recursive: true })
  const evidence = { steps: [] as Array<Record<string, unknown>> }

  const reader = new ZcodeReader(fixture.dbPath)
  const store = new RelayStore(fixture.storePath)
  const observer = new Observer({ store, reader, logger, emit: () => undefined })
  await observer.attach(fixture.sessionId, fixture.projectRoot)
  const row = observer.getRow(fixture.sessionId)
  const timeline = observer.getTimeline(fixture.sessionId)
  const git = await getGitEvidence({ sessionId: fixture.sessionId, projectRoot: fixture.projectRoot, baseline: row.baseline, live: row.live })
  const ctx = {
    row,
    git,
    timeline: timeline.items,
    tokens: timeline.tokens,
    summary: null,
    todos: store.getTodos(fixture.sessionId),
    turns: store.getTurns(fixture.sessionId),
    modelErrorCount: store.countModelErrors(fixture.sessionId)
  }
  const brief = buildRecoveryBrief(ctx)
  const plan = await preparePack(ctx, {
    sessionId: fixture.sessionId,
    mode: 'review',
    filePaths: [],
    includeFullFiles: false,
    extraNotes: '接手实验：login() 未完成，测试已写好。'
  })
  const packDir = path.join(workDir, 'pack')
  writePack(plan, packDir)
  evidence.steps.push({ step: 'build', confidence: brief.confidence, confidenceScore: brief.confidenceScore, signals: brief.signals.map((s) => s.id) })

  // --- Connector self-test (harmless, user-visible precondition) ---
  const connectors = new ConnectorService({ store, logger, userDataDir: fixture.root })
  const verification = await connectors.verify('claude-cli', true)
  evidence.steps.push({ step: 'verify-connector', verified: verification.verified, detail: verification.detail, latencyMs: verification.latencyMs, error: verification.error })
  if (!verification.verified) {
    writeFileSync(path.join(workDir, 'result.json'), JSON.stringify({ ok: false, reason: 'connector-not-verified', evidence }, null, 2), 'utf8')
    console.log(JSON.stringify({ ok: false, reason: 'connector-not-verified', evidence }, null, 2))
    reader.close()
    store.close()
    return
  }
  const claude = await connectors.list().then((list) => list.find((c) => c.id === 'claude-cli'))
  const cliPath = claude?.detail.match(/找到 (.+?)(?:（|$)/)?.[1]
  if (!cliPath) {
    writeFileSync(path.join(workDir, 'result.json'), JSON.stringify({ ok: false, reason: 'cli-not-found', evidence }, null, 2), 'utf8')
    console.log(JSON.stringify({ ok: false, reason: 'cli-not-found', evidence }, null, 2))
    reader.close()
    store.close()
    return
  }

  // --- Phase 1: independent review (read-only, plan mode) ---
  const reviewPrompt = [
    relayInstruction('review'),
    '',
    `交接包目录：${packDir}`,
    `项目目录：${fixture.projectRoot}`,
    '',
    `请先读取 ${path.join(packDir, 'HANDOFF.md')}，再按其中的接力指令执行。`,
    '验收目标：判断登录功能是否已完成，证据是否充分，接手者第一步应该做什么。',
    '只回复验收结论：PASS 或 BLOCKER，并列出最多 3 条问题（如果有），每条附证据路径。',
    '最后单独一行输出：EXPERIMENT_REVIEW_DONE'
  ].join('\n')
  const review = await runClaude(
    cliPath,
    ['-p', '--output-format', 'json', '--permission-mode', 'plan', '--add-dir', packDir, '--add-dir', fixture.projectRoot],
    reviewPrompt,
    fixture.projectRoot,
    10 * 60 * 1000
  )
  writeFileSync(path.join(workDir, 'review.json'), review.result, 'utf8')
  evidence.steps.push({ step: 'review', ok: review.ok, durationMs: review.durationMs })

  // --- Phase 2: continue implementation (acceptEdits) ---
  const implPrompt = [
    relayInstruction('implement'),
    '',
    `交接包目录：${packDir}`,
    `项目目录：${fixture.projectRoot}`,
    '',
    `请先读取 ${path.join(packDir, 'HANDOFF.md')}，再按其中的接力指令执行。`,
    '允许修改的范围：只有 login.ts。不要修改 login.test.ts，不要动 package.json。',
    '完成标准：npm test 全部通过。',
    '最后单独一行输出：EXPERIMENT_IMPL_DONE'
  ].join('\n')
  const impl = await runClaude(
    cliPath,
    ['-p', '--output-format', 'json', '--permission-mode', 'acceptEdits', '--add-dir', packDir, '--add-dir', fixture.projectRoot],
    implPrompt,
    fixture.projectRoot,
    10 * 60 * 1000
  )
  writeFileSync(path.join(workDir, 'impl.json'), impl.result, 'utf8')
  evidence.steps.push({ step: 'implement', ok: impl.ok, durationMs: impl.durationMs })

  // --- Evaluation ---
  // Run the project's vitest with Electron's Node 24, so crypto.getRandomValues
  // exists regardless of the system's Node version.
  const electronBin = path.join(process.cwd(), 'node_modules', 'electron', 'dist', 'electron.exe')
  const vitestBin = path.join(process.cwd(), 'node_modules', 'vitest', 'vitest.mjs')
  const testAfter = spawnSync(electronBin, [vitestBin, 'run', '--root', fixture.projectRoot], {
    cwd: fixture.projectRoot,
    windowsHide: true,
    encoding: 'utf8',
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
    timeout: 120_000
  })
  const testOut = { code: testAfter.status, out: (testAfter.stdout || '') + (testAfter.stderr || '') }
  const loginTs = readFileSync(path.join(fixture.projectRoot, 'login.ts'), 'utf8')
  const testTs = readFileSync(path.join(fixture.projectRoot, 'login.test.ts'), 'utf8')
  const evaluation = {
    testExitCode: testOut.code,
    testPassed: testOut.code === 0,
    loginImplemented: !loginTs.includes('not implemented'),
    testUntouched: testTs.includes("it('returns a token for valid credentials'"),
    loginHadHistory: loginTs.length > 100,
    npmTestOutput: testOut.out.slice(-2000)
  }

  const final = {
    ok: evaluation.testPassed && evaluation.loginImplemented && evaluation.testUntouched,
    evidence,
    evaluation,
    packDir,
    reviewFile: path.join(workDir, 'review.json'),
    implFile: path.join(workDir, 'impl.json')
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

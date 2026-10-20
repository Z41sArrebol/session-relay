import { describe, expect, it, beforeAll, afterAll } from 'vitest'
import { RelayStore } from '../src/main/core/state'
import { ZcodeReader } from '../src/main/core/zcode/reader'
import { Observer } from '../src/main/core/observer'
import { getGitEvidence } from '../src/main/core/git'
import { preparePack, type PackContext } from '../src/main/core/handoff'
import {
  buildRecoveryBrief,
  computeConfidence,
  recoveryMarkdown,
  isFollowUpMessage,
  selectEffectiveGoal,
  classifyFailures,
  selectRecommendedFailure,
  failureGuidance
} from '../src/main/core/recovery'
import { createZcodeFixture, type Fixture } from './fixtures/zcode'
import type { Logger } from '../src/main/core/log'
import type { TimelineItem } from '../src/shared/types'

const silentLogger = { info: () => undefined, warn: () => undefined, error: () => undefined } as unknown as Logger

function toolItem(id: string, command: string, time: number, exitCode: number | null, status: 'completed' | 'error' = 'completed'): TimelineItem {
  return {
    id,
    sessionId: 'sess_test',
    kind: 'tool',
    time,
    messageId: `m-${id}`,
    partId: id,
    turnId: 'turn',
    sequence: 0,
    toolName: 'Bash',
    callId: id,
    input: { command },
    status,
    exitCode
  }
}

function userItem(id: string, text: string, time: number): TimelineItem {
  return {
    id,
    sessionId: 'sess_test',
    kind: 'user',
    time,
    messageId: id,
    turnId: id,
    sequence: 0,
    text
  }
}

describe('failure guidance', () => {
  const goalTime = 500
  const tools = [
    toolItem('old-python', 'python -c "sqlite3 db.sqlite"', 100, 1, 'error'),
    toolItem('lint', 'npm run lint', 600, 1, 'error'),
    toolItem('typecheck', 'npm run typecheck', 700, 1, 'error'),
    toolItem('build-fail', 'npm run build', 800, 1, 'error'),
    toolItem('build-ok', 'npm run build', 900, 0, 'completed')
  ]

  it('does not recommend a historical exploratory failure', () => {
    const records = classifyFailures(tools, goalTime)
    const recommended = selectRecommendedFailure(records, { incompleteTodos: [], changedFiles: [] })
    expect(recommended?.item.id).toBe('typecheck')
    expect(recommended?.item.id).not.toBe('old-python')
    expect(failureGuidance(recommended, 1)).not.toContain('python')
  })

  it('marks a failure resolved by a later same-family success', () => {
    const records = classifyFailures(tools, goalTime)
    const build = records.find((record) => record.item.id === 'build-fail')
    expect(build?.resolvedBy?.id).toBe('build-ok')
  })

  it('picks the latest unresolved current failure, not the earliest', () => {
    const records = classifyFailures(tools, goalTime)
    const recommended = selectRecommendedFailure(records, { incompleteTodos: [], changedFiles: [] })
    expect(recommended?.item.id).toBe('typecheck')
    expect(failureGuidance(recommended, 0)).toContain('npm run typecheck')
    expect(failureGuidance(recommended, 0)).toContain('当前目标内最近一条')
  })

  it('does not truncate a long command into a runnable snippet', () => {
    const long = toolItem('long', `npm run ${'x'.repeat(400)}`, 1000, 1, 'error')
    const records = classifyFailures([long], goalTime)
    const recommended = selectRecommendedFailure(records, { incompleteTodos: [], changedFiles: [] })
    const guidance = failureGuidance(recommended, 0)!
    expect(guidance).toContain('命令较长')
    expect(guidance).toContain('完整执行记录')
    expect(guidance).not.toContain('…[截断]')
  })

  it('renders a multi-line failure command as a single line', () => {
    const multi = toolItem(
      'multi',
      `cd /x && python -c "
import sqlite3
print(1)"`,
      1000,
      1,
      'error'
    )
    const recommended = selectRecommendedFailure(classifyFailures([multi], 500), {
      incompleteTodos: [],
      changedFiles: []
    })
    const guidance = failureGuidance(recommended, 0)!
    expect(guidance.includes(String.fromCharCode(10))).toBe(false)
    expect(guidance).toContain('python -c')
  })

  it('mentions historical unresolved failures instead of recommending them', () => {
    const records = classifyFailures([toolItem('old-python', 'python -c "sqlite3 db.sqlite"', 100, 1, 'error')], goalTime)
    expect(selectRecommendedFailure(records, { incompleteTodos: [], changedFiles: [] })).toBeNull()
    expect(failureGuidance(null, 1)).toContain('不要直接重跑')
  })
})

describe('confidence on a clean session', () => {
  let cleanFixture: Fixture
  let cleanReader: ZcodeReader
  let cleanStore: RelayStore

  beforeAll(async () => {
    cleanFixture = createZcodeFixture()
    cleanReader = new ZcodeReader(cleanFixture.dbPath)
    cleanStore = new RelayStore(cleanFixture.storePath)
    const observer = new Observer({ store: cleanStore, reader: cleanReader, logger: silentLogger, emit: () => undefined })
    await observer.attach(cleanFixture.sessionA, cleanFixture.projectRoot)
  })

  afterAll(() => {
    cleanReader.close()
    cleanStore.close()
    cleanFixture.cleanup()
  })

  it('is high when a session has evidence and no warnings', async () => {
    const row = cleanStore.getAttached(cleanFixture.sessionA)!
    const git = await getGitEvidence({
      sessionId: cleanFixture.sessionA,
      projectRoot: cleanFixture.projectRoot,
      baseline: row.baseline,
      live: row.live
    })
    const timeline = new Observer({ store: cleanStore, reader: cleanReader, logger: silentLogger, emit: () => undefined }).getTimeline(
      cleanFixture.sessionA
    )
    const brief = buildRecoveryBrief({
      row,
      git,
      timeline: timeline.items,
      tokens: timeline.tokens,
      summary: null,
      todos: cleanStore.getTodos(cleanFixture.sessionA),
      turns: cleanStore.getTurns(cleanFixture.sessionA),
      modelErrorCount: cleanStore.countModelErrors(cleanFixture.sessionA)
    })
    expect(brief.confidence).toBe('high')
    expect(brief.confidenceScore).toBeGreaterThanOrEqual(90)
    expect(brief.confidenceReasons.join(' ')).toContain('门槛')
  })
})

describe('confidence score and gates', () => {
  const allGood = {
    gitAvailable: true,
    hasBaseline: true,
    dangerCount: 0,
    warnCount: 0,
    usableGoal: true,
    verifiedEvidence: true,
    missingWritten: 0,
    syncError: false,
    running: false,
    staleTodos: false
  }

  it('is high only when every evidence gate passes', () => {
    const result = computeConfidence(allGood)
    expect(result.confidence).toBe('high')
    expect(result.score).toBeGreaterThanOrEqual(90)
    expect(result.reasons.join(' ')).toContain('门槛')
  })

  it('drops below high on any single gate', () => {
    for (const patch of [
      { hasBaseline: false },
      { usableGoal: false },
      { verifiedEvidence: false },
      { missingWritten: 1 },
      { staleTodos: true },
      { running: true },
      { warnCount: 1 },
      { dangerCount: 1 }
    ]) {
      const result = computeConfidence({ ...allGood, ...patch })
      expect(result.confidence).not.toBe('high')
    }
  })

  it('explains why it is not high', () => {
    const result = computeConfidence({ ...allGood, hasBaseline: false, verifiedEvidence: false })
    expect(result.confidence).not.toBe('high')
    expect(result.reasons.join(' ')).toContain('缺少接入时基线')
    expect(result.reasons.join(' ')).toContain('没有可核对的完成证据')
  })
})

describe('recovery brief for a stalled session', () => {
  let fixture: Fixture
  let reader: ZcodeReader
  let store: RelayStore
  let observer: Observer
  let ctx: PackContext

  beforeAll(async () => {
    fixture = createZcodeFixture({ recovery: true })
    reader = new ZcodeReader(fixture.dbPath)
    store = new RelayStore(fixture.storePath)
    observer = new Observer({ store, reader, logger: silentLogger, emit: () => undefined })
    await observer.attach(fixture.sessionA, fixture.projectRoot)
    const row = observer.getRow(fixture.sessionA)
    const git = await getGitEvidence({
      sessionId: fixture.sessionA,
      projectRoot: fixture.projectRoot,
      baseline: row.baseline,
      live: row.live
    })
    const timeline = observer.getTimeline(fixture.sessionA)
    ctx = {
      row,
      git,
      timeline: timeline.items,
      tokens: timeline.tokens,
      summary: null,
      todos: store.getTodos(fixture.sessionA),
      turns: store.getTurns(fixture.sessionA),
      modelErrorCount: store.countModelErrors(fixture.sessionA)
    }
  })

  afterAll(() => {
    reader.close()
    store.close()
    fixture.cleanup()
  })

  it('answers the five recovery questions from Z-Code records', () => {
    const brief = buildRecoveryBrief(ctx)
    expect(brief.latestGoal).toContain('补充：只验收登录流程')
    expect(brief.olderRequirements).toContain('实现登录页并跑测试')
    expect(brief.olderRequirements).toContain('可能仍然有效')

    expect(brief.completedEvidence).toContain('实现登录表单')
    expect(brief.completedEvidence).toContain('退出码 0')

    expect(brief.failedAttempts).toContain('npm run build')
    expect(brief.failedAttempts).toContain('疑似已解决')

    expect(brief.workspaceConsistency).toContain('分支')
    expect(brief.workspaceConsistency).toContain('接入前已存在的修改')

    expect(brief.nextActions).toContain('补登录测试')
    expect(brief.nextActions).toContain('更新 README')
    expect(brief.incompleteTodos).toHaveLength(3)
  })

  it('skips trailing control messages when selecting the effective goal', () => {
    const users = [
      userItem('u1', '实现登录页并跑测试。', 1),
      userItem('u2', '补充：只验收登录流程。', 2),
      userItem('u3', '继续完成任务。', 3),
      userItem('u4', '现在怎么样了？', 4)
    ]
    const selection = selectEffectiveGoal(users)
    expect(selection.goal?.text).toContain('只验收登录流程')
    expect(selection.trailing.map((item) => item.text)).toEqual(['继续完成任务。', '现在怎么样了？'])
    expect(selection.older.map((item) => item.text)).toContain('实现登录页并跑测试。')
  })

  it('keeps a short specific instruction as substantive', () => {
    expect(isFollowUpMessage('改红色')).toBe(false)
    expect(isFollowUpMessage('继续做登录页')).toBe(false)
    expect(isFollowUpMessage('继续完成任务。')).toBe(true)
    expect(isFollowUpMessage('现在怎么样了？')).toBe(true)
    const selection = selectEffectiveGoal([userItem('u1', '实现登录页', 1), userItem('u2', '改红色', 2)])
    expect(selection.goal?.text).toBe('改红色')
  })

  it('marks an all-control conversation instead of pretending a goal exists', () => {
    const selection = selectEffectiveGoal([userItem('u1', '继续', 1), userItem('u2', '现在怎么样了', 2)])
    expect(selection.goal?.text).toBe('继续')
    expect(selection.goalIsFollowUp).toBe(true)
    expect(selection.trailing).toHaveLength(1)
  })

  it('does not let a trailing 继续 replace the real goal in the brief', () => {
    const controls = [
      userItem('u-continue', '继续完成任务。', Date.now() + 10_000),
      userItem('u-status', '现在怎么样了？', Date.now() + 10_001)
    ]
    const brief = buildRecoveryBrief({ ...ctx, timeline: [...ctx.timeline, ...controls] })
    expect(brief.latestGoal).toContain('补充：只验收登录流程')
    expect(brief.latestGoal).toContain('控制/进度消息')
    expect(brief.olderRequirements).toContain('实现登录页')
    expect(brief.olderRequirements).toContain('可能仍然有效')
    expect(brief.olderRequirements).not.toContain('可能已经失效')
  })

  it('detects context overflow, unfinished todos and model errors', () => {
    const brief = buildRecoveryBrief(ctx)
    const ids = brief.signals.map((s) => s.id)
    expect(ids).toContain('context-exceeded')
    expect(ids).toContain('todos')
    expect(ids).toContain('model-errors')
    expect(brief.confidence).not.toBe('high')
    expect(brief.signals.find((s) => s.id === 'context-exceeded')?.level).toBe('danger')
  })

  it('renders a compact five-section markdown and includes it in HANDOFF', async () => {
    const brief = buildRecoveryBrief(ctx)
    const md = recoveryMarkdown(brief)
    for (const title of ['最新目标', '已完成与可核对证据', '失败过的路线', '工作区一致性', '接手后先做什么']) {
      expect(md).toContain(title)
    }
    const plan = await preparePack(ctx, {
      sessionId: fixture.sessionA,
      mode: 'review',
      filePaths: [],
      includeFullFiles: false,
      extraNotes: ''
    })
    expect(plan.recovery.confidence).toBe(brief.confidence)
    expect(plan.markdown).toContain('恢复简报（接手先看）')
    expect(plan.markdown).toContain('最新目标')
    expect(plan.markdown).toContain('更新 README')
    expect(plan.manifest.recovery.signals.some((s) => s.id === 'context-exceeded')).toBe(true)
    expect(plan.markdown).not.toContain('INTERNAL_REASONING')
  })
})

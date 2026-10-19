import { describe, expect, it, beforeAll, afterAll } from 'vitest'
import { RelayStore } from '../src/main/core/state'
import { ZcodeReader } from '../src/main/core/zcode/reader'
import { Observer } from '../src/main/core/observer'
import { getGitEvidence } from '../src/main/core/git'
import { preparePack, type PackContext } from '../src/main/core/handoff'
import { buildRecoveryBrief, recoveryMarkdown } from '../src/main/core/recovery'
import { createZcodeFixture, type Fixture } from './fixtures/zcode'
import type { Logger } from '../src/main/core/log'

const silentLogger = { info: () => undefined, warn: () => undefined, error: () => undefined } as unknown as Logger

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
    expect(brief.olderRequirements).toContain('可能已经失效')

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

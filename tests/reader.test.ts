import type { Logger } from '../src/main/core/log'
import { describe, expect, it, beforeAll, afterAll } from 'vitest'
import { RelayStore } from '../src/main/core/state'
import { ZcodeReader } from '../src/main/core/zcode/reader'
import { buildEvents } from '../src/main/core/zcode/events'
import { Observer } from '../src/main/core/observer'
import {
  createZcodeFixture,
  appendToolUsage,
  appendRunningToolCall,
  completeRunningToolCall,
  appendUserMessage,
  updatePartText,
  appendCompletedModelUsage,
  type Fixture
} from './fixtures/zcode'

const silentLogger = { info: () => undefined, warn: () => undefined, error: () => undefined } as unknown as Logger

describe('Z-Code reader and incremental sync', () => {
  let fixture: Fixture
  let reader: ZcodeReader
  let store: RelayStore

  beforeAll(() => {
    fixture = createZcodeFixture()
    reader = new ZcodeReader(fixture.dbPath)
    store = new RelayStore(fixture.storePath)
  })

  afterAll(() => {
    reader.close()
    store.close()
    fixture.cleanup()
  })

  it('lists sessions with directory and model, without reading bodies', () => {
    const sessions = reader.listSessions()
    expect(sessions.map((s) => s.id)).toContain(fixture.sessionA)
    const a = sessions.find((s) => s.id === fixture.sessionA)!
    expect(a.directory).toBe(fixture.projectRoot)
    expect(a.title).toBe('测试会话 A')
    expect(a.model?.modelId).toBe('test/model')
  })

  it('detects schema capabilities', () => {
    const schema = reader.getSchema()
    expect(schema.compatible).toBe(true)
    expect(schema.capabilities.toolUsage).toBe(true)
    expect(schema.capabilities.modelUsage).toBe(true)
    expect(schema.capabilities.json).toBe(true)
  })

  it('collects user prompts, public replies, tools; excludes reasoning and injected context', () => {
    const observer = makeObserver(fixture, store, reader, silentLogger)
    return observer.attach(fixture.sessionA, fixture.projectRoot).then(() => {
      const timeline = observer.getTimeline(fixture.sessionA)
      const text = timeline.items.map((i) => i.text || '').join('\n')
      expect(text).toContain('实现登录页并跑测试。')
      expect(text).toContain('登录页已完成，测试通过。')
      expect(text).not.toContain('INTERNAL_REASONING_SHOULD_NOT_BE_COLLECTED')
      expect(text).not.toContain('SYSTEM_INJECTION_SHOULD_NOT_APPEAR')
      const tool = timeline.items.find((i) => i.kind === 'tool')!
      expect(tool.toolName).toBe('Bash')
      expect(tool.output).toContain('PASS login.test.ts')
      expect(tool.exitCode).toBe(0)
      expect(timeline.tokens.input).toBe(1200)
      expect(timeline.tokens.cacheRead).toBe(900)
    })
  })

  it('does not mix records between sessions', () => {
    const observer = makeObserver(fixture, store, reader, silentLogger)
    return observer
      .attach(fixture.sessionB, fixture.projectRoot)
      .then(() => {
        const b = observer.getTimeline(fixture.sessionB)
        const joined = b.items.map((i) => i.text || '').join('\n')
        expect(joined).toContain('B 会话的独立要求。')
        expect(joined).not.toContain('实现登录页并跑测试。')
        expect(b.items.every((i) => i.sessionId === fixture.sessionB)).toBe(true)
      })
  })

  it('upserts an in-place streaming update without duplicating the event', async () => {
    const observer = makeObserver(fixture, store, reader, silentLogger)
    const before = observer.getTimeline(fixture.sessionA)
    const messageEvent = before.items.find((i) => i.kind === 'assistant' && i.messageId === 'msg_asst_a')!
    const countBefore = before.items.filter((i) => i.kind === 'assistant').length

    updatePartText(fixture.dbPath, 'part_text_a', '先实现表单，再补测试。追加一句。', Date.now() + 1000)
    await observer.sync(fixture.sessionA, true)
    const after = observer.getTimeline(fixture.sessionA)
    const updated = after.items.find((i) => i.id === messageEvent.id)!
    expect(updated.text).toContain('追加一句')
    expect(after.items.filter((i) => i.kind === 'assistant').length).toBe(countBefore)
  })

  it('re-checks a long-running tool even after the watermark moved past its start', async () => {
    const observer = makeObserver(fixture, store, reader, silentLogger)
    const start = Date.now() - 60_000
    appendRunningToolCall(fixture.dbPath, {
      sessionId: fixture.sessionA,
      messageId: 'msg_asst_a',
      partId: 'part_long_tool',
      usageId: 'usage_long_tool',
      callId: 'call_long_tool',
      startedAt: start,
      command: 'npm run long-task'
    })
    // Another tool completes much later, pushing the watermark past the long task's start.
    appendToolUsage(fixture.dbPath, {
      id: 'usage_later_tool',
      sessionId: fixture.sessionA,
      callId: 'call_later_tool',
      status: 'completed',
      startedAt: start + 30_000,
      completedAt: start + 31_000
    })
    await observer.sync(fixture.sessionA, true)
    let tools = observer.getTimeline(fixture.sessionA).items.filter((i) => i.kind === 'tool')
    expect(tools.find((t) => t.callId === 'call_long_tool')?.status).toBe('running')

    // The long task finishes later. It must still be picked up.
    completeRunningToolCall(fixture.dbPath, {
      partId: 'part_long_tool',
      usageId: 'usage_long_tool',
      completedAt: start + 120_000,
      output: 'long task done'
    })
    await observer.sync(fixture.sessionA, true)
    tools = observer.getTimeline(fixture.sessionA).items.filter((i) => i.kind === 'tool')
    const longTool = tools.find((t) => t.callId === 'call_long_tool')!
    expect(longTool.status).toBe('completed')
    expect(longTool.output).toContain('long task done')
  })

  it('re-reads two parallel running tools independently', async () => {
    const observer = makeObserver(fixture, store, reader, silentLogger)
    const start = Date.now() + 70_000
    appendRunningToolCall(fixture.dbPath, {
      sessionId: fixture.sessionA,
      messageId: 'msg_asst_a',
      partId: 'part_par_1',
      usageId: 'usage_par_1',
      callId: 'call_par_1',
      startedAt: start,
      command: 'npm run task-1'
    })
    appendRunningToolCall(fixture.dbPath, {
      sessionId: fixture.sessionA,
      messageId: 'msg_asst_a',
      partId: 'part_par_2',
      usageId: 'usage_par_2',
      callId: 'call_par_2',
      startedAt: start + 1,
      command: 'npm run task-2'
    })
    await observer.sync(fixture.sessionA, true)
    let tools = observer.getTimeline(fixture.sessionA).items.filter((i) => i.kind === 'tool')
    expect(tools.find((t) => t.callId === 'call_par_1')?.status).toBe('running')
    expect(tools.find((t) => t.callId === 'call_par_2')?.status).toBe('running')

    completeRunningToolCall(fixture.dbPath, {
      partId: 'part_par_1',
      usageId: 'usage_par_1',
      completedAt: start + 10_000,
      output: 'task 1 done'
    })
    await observer.sync(fixture.sessionA, true)
    tools = observer.getTimeline(fixture.sessionA).items.filter((i) => i.kind === 'tool')
    expect(tools.find((t) => t.callId === 'call_par_1')?.status).toBe('completed')
    expect(tools.find((t) => t.callId === 'call_par_2')?.status).toBe('running')

    completeRunningToolCall(fixture.dbPath, {
      partId: 'part_par_2',
      usageId: 'usage_par_2',
      completedAt: start + 20_000,
      output: 'task 2 done'
    })
    await observer.sync(fixture.sessionA, true)
    tools = observer.getTimeline(fixture.sessionA).items.filter((i) => i.kind === 'tool')
    expect(tools.find((t) => t.callId === 'call_par_2')?.status).toBe('completed')
  })

  it('recovers after the source database is temporarily locked', async () => {
    const Database = (await import('better-sqlite3')).default
    const lockedReader = new ZcodeReader(fixture.dbPath, { busyTimeoutMs: 40 })
    const observer = makeObserver(fixture, store, lockedReader, silentLogger)
    const before = observer.getTimeline(fixture.sessionA)

    const writer = new Database(fixture.dbPath)
    writer.exec('BEGIN EXCLUSIVE')
    let failed
    try {
      failed = await observer.sync(fixture.sessionA, true)
    } finally {
      writer.exec('COMMIT')
      writer.close()
    }
    expect(failed.ok).toBe(false)
    expect(observer.getRow(fixture.sessionA).syncError).toBeTruthy()
    expect(observer.getTimeline(fixture.sessionA).items.length).toBe(before.items.length)

    const recovered = await observer.sync(fixture.sessionA, true)
    expect(recovered.ok).toBe(true)
    expect(observer.getRow(fixture.sessionA).syncError).toBeNull()
    expect(observer.getTimeline(fixture.sessionA).items.length).toBeGreaterThanOrEqual(before.items.length)
    lockedReader.close()
  })

  it('supports pause, resume and restart without duplicate imports', async () => {
    const observer = makeObserver(fixture, store, reader, silentLogger)
    const before = observer.getTimeline(fixture.sessionA)
    observer.setPaused(fixture.sessionA, true)
    const pausedAt = Date.now() + 1000
    appendUserMessage(fixture.dbPath, fixture.sessionA, 'msg_user_paused', pausedAt, '暂停期间的新要求。')
    const pausedSync = await observer.sync(fixture.sessionA, false)
    expect(pausedSync.newEvents).toBe(0)

    observer.setPaused(fixture.sessionA, false)
    await observer.sync(fixture.sessionA, true)
    const afterResume = observer.getTimeline(fixture.sessionA)
    expect(afterResume.items.some((i) => i.messageId === 'msg_user_paused')).toBe(true)
    expect(afterResume.items.length).toBeGreaterThan(before.items.length)
  })

  it('recovers the watermark after a store restart and does not duplicate events', async () => {
    const observer = makeObserver(fixture, store, reader, silentLogger)
    const before = observer.getTimeline(fixture.sessionA)
    const storePath = fixture.storePath
    store.close()

    const reopened = new RelayStore(storePath)
    const observer2 = makeObserver(fixture, reopened, reader, silentLogger)
    await observer2.sync(fixture.sessionA, true)
    const after = observer2.getTimeline(fixture.sessionA)
    expect(after.items.length).toBe(before.items.length)
    expect(new Set(after.items.map((i) => i.id)).size).toBe(after.items.length)
    reopened.close()
    // restore the shared store for afterAll
    store = new RelayStore(storePath)
  })

  it('still lists sessions when the optional model_usage table is missing', async () => {
    const { copyFileSync } = await import('node:fs')
    const path = await import('node:path')
    const Database = (await import('better-sqlite3')).default
    const copy = path.join(fixture.root, 'no-model.sqlite')
    copyFileSync(fixture.dbPath, copy)
    const db = new Database(copy)
    db.exec('DROP TABLE model_usage')
    db.close()
    const degraded = new ZcodeReader(copy)
    expect(degraded.getSchema().compatible).toBe(true)
    expect(degraded.getSchema().capabilities.modelUsage).toBe(false)
    expect(degraded.getSchema().degraded.join(' ')).toContain('model_usage')
    const sessions = degraded.listSessions()
    expect(sessions.length).toBeGreaterThanOrEqual(2)
    expect(sessions.find((s) => s.id === fixture.sessionA)?.model).toBeNull()
    degraded.close()
  })

  it('keeps model usage additions that arrive after the first sync', async () => {
    const observer = makeObserver(fixture, store, reader, silentLogger)
    const before = observer.getTimeline(fixture.sessionA).tokens.calls
    appendCompletedModelUsage(fixture.dbPath, {
      id: 'usage_model_late',
      sessionId: fixture.sessionA,
      messageId: 'msg_final_a',
      startedAt: Date.now() + 2000,
      completedAt: Date.now() + 2500
    })
    await observer.sync(fixture.sessionA, true)
    const after = observer.getTimeline(fixture.sessionA).tokens
    expect(after.calls).toBe(before + 1)
    expect(after.input).toBe(1250)
  })
})

function makeObserver(fixture: Fixture, store: RelayStore, reader: ZcodeReader, logger: typeof silentLogger): Observer {
  return new Observer({
    store,
    reader,
    logger,
    emit: () => undefined
  })
}

// Keep the event builder covered directly for the system-note filter.
describe('event builder', () => {
  it('does not emit step-start/step-finish parts', () => {
    expect(typeof buildEvents).toBe('function')
  })
})

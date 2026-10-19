import type {
  AttachedSession,
  LiveState,
  ModelRef,
  RelayEvent,
  SummaryDraft,
  SyncResult,
  TimelineItem,
  TimelineResponse,
  TokenTotals
} from '../../shared/types'
import type { Logger } from './log'
import { captureBaseline } from './git'
import { dirExists, RelayError } from './paths'
import type { RelayStore, StoredAttachedRow } from './state'
import { buildEvents } from './zcode/events'
import type { ZcodeReader, ZMessageRow } from './zcode/reader'

const SYNC_INTERVAL_MS = 2500

interface ObserverDeps {
  store: RelayStore
  reader: ZcodeReader
  logger: Logger
  emit: (event: RelayEvent) => void
}

export class Observer {
  private deps: ObserverDeps
  private timer: NodeJS.Timeout | null = null
  private inflight = new Set<string>()
  private stopped = true

  constructor(deps: ObserverDeps) {
    this.deps = deps
  }

  start(): void {
    if (!this.stopped) return
    this.stopped = false
    this.timer = setInterval(() => this.tick(), SYNC_INTERVAL_MS)
    this.tick()
  }

  stop(): void {
    this.stopped = true
    if (this.timer) clearInterval(this.timer)
    this.timer = null
  }

  private tick(): void {
    if (this.stopped) return
    for (const row of this.deps.store.listAttached()) {
      if (row.paused) continue
      if (this.inflight.has(row.sessionId)) continue
      void this.sync(row.sessionId).catch(() => {
        // sync() records its own error; swallow here so one session can't stop the loop
      })
    }
  }

  async attach(sessionId: string, projectRoot: string): Promise<AttachedSession> {
    if (!/^sess_[A-Za-z0-9._-]+$/.test(sessionId)) {
      throw new RelayError('session-invalid', '会话 ID 格式不正确')
    }
    if (!dirExists(projectRoot)) {
      throw new RelayError('project-missing', `项目目录不存在：${projectRoot}`)
    }
    const session = this.deps.reader.getSession(sessionId)
    if (!session) throw new RelayError('session-missing', 'Z-Code 中找不到该会话')
    if (session.parentId) throw new RelayError('session-child', '第一版只支持接入顶层会话，子 Agent 会话请从其父会话查看')

    const baseline = await captureBaseline(projectRoot)
    const model = this.deps.reader.latestModel(sessionId)
    this.deps.store.attach({
      sessionId,
      projectRoot,
      sourceDb: this.deps.reader.path,
      baseline,
      title: session.title,
      directory: session.directory,
      model,
      attachedAt: Date.now()
    })
    this.deps.logger.info(`attach session=${sessionId} baseline=${baseline.info.hasBaseline}`)
    await this.sync(sessionId, true)
    const row = this.deps.store.getAttached(sessionId)
    if (!row) throw new RelayError('attach-failed', '接入后无法读取本地状态')
    // sync() has already emitted any inserted records. Emitting the total here
    // would make the renderer add the same events twice.
    return this.publicSession(row)
  }

  detach(sessionId: string): void {
    this.deps.store.detach(sessionId)
    this.deps.logger.info(`detach session=${sessionId}`)
    this.deps.emit({ type: 'session-detached', sessionId })
  }

  setPaused(sessionId: string, paused: boolean): AttachedSession {
    this.ensureAttached(sessionId)
    this.deps.store.setPaused(sessionId, paused)
    const row = this.deps.store.getAttached(sessionId)
    if (!row) throw new RelayError('session-missing', '会话未接入')
    return this.publicSession(row)
  }

  async sync(sessionId: string, force = false): Promise<SyncResult> {
    const row = this.ensureAttached(sessionId)
    if (row.paused && !force) {
      return {
        ok: true,
        sessionId,
        newEvents: 0,
        updatedEvents: 0,
        lastSyncAt: row.lastSyncAt || Date.now(),
        error: null,
        live: row.live
      }
    }
    if (this.inflight.has(sessionId)) {
      return {
        ok: true,
        sessionId,
        newEvents: 0,
        updatedEvents: 0,
        lastSyncAt: row.lastSyncAt || Date.now(),
        error: null,
        live: row.live
      }
    }
    this.inflight.add(sessionId)
    try {
      const watermarks = this.deps.store.getWatermarks(sessionId)
      const z = this.deps.reader.sync(sessionId, watermarks)
      if (!z.session) throw new RelayError('session-missing', 'Z-Code 中找不到该会话')

      this.deps.store.upsertMessageMeta(sessionId, z.messages.map((m) => m.meta))
      const byId = new Map<string, ZMessageRow>()
      for (const m of z.messages) byId.set(m.id, m)
      const lookup = (messageId: string): ZMessageRow | null => {
        const cached = byId.get(messageId)
        if (cached) return cached
        const meta = this.deps.store.getMessageMeta(sessionId, messageId)
        if (meta) {
          const found: ZMessageRow = {
            id: meta.messageId,
            createdAt: meta.createdAt,
            updatedAt: meta.updatedAt,
            sequence: 0,
            meta
          }
          byId.set(messageId, found)
          return found
        }
        const remote = this.deps.reader.readMessageById(sessionId, messageId)
        if (remote) byId.set(messageId, remote)
        return remote
      }

      const events = buildEvents(sessionId, z, lookup)
      const { inserted, updated } = this.deps.store.upsertEvents(sessionId, events)
      if (z.capabilities.toolUsage) this.deps.store.upsertToolMeta(sessionId, z.tools)
      if (z.capabilities.turnUsage) this.deps.store.upsertTurnMeta(sessionId, z.turns)
      if (z.capabilities.modelUsage) this.deps.store.upsertModelCalls(sessionId, z.models)
      if (z.capabilities.todo) this.deps.store.replaceTodos(sessionId, z.todos)
      this.deps.store.setWatermarks(sessionId, z.watermarks)

      const live = this.computeLive(sessionId, z.session.updatedAt)
      const model = this.deps.reader.latestModel(sessionId) || this.modelFromEvents(sessionId)
      const eventCount = this.deps.store.countEvents(sessionId)
      const now = Date.now()
      this.deps.store.updateSessionInfo(sessionId, {
        title: z.session.title,
        directory: z.session.directory,
        model,
        lastSyncAt: now,
        syncError: null,
        live,
        eventCount
      })
      if (inserted || updated) {
        this.deps.logger.info(`sync session=${sessionId} +${inserted} ~${updated} total=${eventCount}`)
      }
      const changed =
        inserted > 0 ||
        updated > 0 ||
        row.live.state !== live.state ||
        row.live.runningTurns !== live.runningTurns ||
        row.live.runningTools !== live.runningTools ||
        row.live.latestTurnStatus !== live.latestTurnStatus ||
        row.syncError !== null
      if (changed) {
        this.deps.emit({ type: 'session-updated', sessionId, live, newEvents: inserted, eventCount, lastSyncAt: now })
      }
      return { ok: true, sessionId, newEvents: inserted, updatedEvents: updated, lastSyncAt: now, error: null, live }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      this.deps.store.setSyncError(sessionId, message)
      const failed: LiveState = {
        state: 'error',
        label: '读取失败',
        detail: message,
        asOf: Date.now(),
        runningTurns: 0,
        runningTools: 0,
        lastActivityAt: this.deps.store.lastEventTime(sessionId)
      }
      this.deps.store.setLive(sessionId, failed)
      this.deps.logger.error(`sync-failed session=${sessionId} ${message}`)
      this.deps.emit({ type: 'sync-error', sessionId, message, at: Date.now() })
      return {
        ok: false,
        sessionId,
        newEvents: 0,
        updatedEvents: 0,
        lastSyncAt: this.deps.store.getAttached(sessionId)?.lastSyncAt || 0,
        error: message,
        live: failed
      }
    } finally {
      this.inflight.delete(sessionId)
    }
  }

  private modelFromEvents(sessionId: string): ModelRef | null {
    const { items } = this.deps.store.getTimeline(sessionId, 2000)
    for (let i = items.length - 1; i >= 0; i--) {
      const m = items[i].model
      if (m && m.modelId) return m
    }
    return null
  }

  private computeLive(sessionId: string, sessionUpdatedAt: number): LiveState {
    const turns = this.deps.store.getTurns(sessionId)
    const runningTurnRows = turns.filter((t) => t.status === 'running').length
    const runningMessages = this.deps.store.countIncompleteAssistantMessages(sessionId)
    // turn_usage may be pruned on long sessions, so an incomplete assistant
    // message is counted as running too. Over-reporting "running" is safer
    // than pretending work finished.
    const runningTurns = Math.max(runningTurnRows, runningMessages)
    const runningTools = this.deps.store.countRunningTools(sessionId)
    const lastEvent = this.deps.store.lastEventTime(sessionId)
    const lastTurn = turns.length ? turns[turns.length - 1] : null
    const lastActivity = Math.max(
      lastEvent || 0,
      sessionUpdatedAt || 0,
      lastTurn?.completedAt || lastTurn?.startedAt || 0
    ) || null
    const asOf = Date.now()

    if (runningTurns > 0 || runningTools > 0) {
      return {
        state: 'running',
        label: '执行中',
        detail: `${runningTurns} 个 turn / ${runningTools} 个工具正在运行`,
        asOf,
        runningTurns,
        runningTools,
        lastActivityAt: lastActivity,
        latestTurnStatus: lastTurn?.status
      }
    }
    if (!lastEvent) {
      return {
        state: 'unknown',
        label: '等待记录',
        detail: '还没有读取到公开记录；会话可能刚开始或数据暂不可读',
        asOf,
        runningTurns,
        runningTools,
        lastActivityAt: lastActivity,
        latestTurnStatus: lastTurn?.status
      }
    }
    return {
      state: 'idle',
      label: '无进行中的 turn',
      detail: '空闲不代表任务完成；只表示当前没有检测到运行中的 turn 或工具',
      asOf,
      runningTurns,
      runningTools,
      lastActivityAt: lastActivity,
      latestTurnStatus: lastTurn?.status
    }
  }

  getTimeline(sessionId: string, limit = 5000): TimelineResponse {
    const row = this.ensureAttached(sessionId)
    const { items, hasMore } = this.deps.store.getTimeline(sessionId, limit)
    const toolMeta = this.deps.store.getToolMetaMap(sessionId)
    const calls = this.deps.store.getModelCallsByMessage(sessionId)
    let user = 0
    let assistant = 0
    let tool = 0
    for (const item of items) {
      if (item.kind === 'user') user++
      else if (item.kind === 'assistant') {
        assistant++
        const list = calls.get(item.messageId)
        if (list && list.length) {
          const usage = list.reduce<TokenTotals>(
            (acc, c) => {
              acc.input += c.inputTokens
              acc.output += c.outputTokens
              acc.reasoning += c.reasoningTokens
              acc.cacheRead += c.cacheRead
              acc.cacheWrite += c.cacheWrite
              acc.calls += 1
              return acc
            },
            { input: 0, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0, calls: 0 }
          )
          item.usage = usage
          if (!item.model && list[0]) {
            item.model = { providerId: list[0].providerId, modelId: list[0].modelId, variant: list[0].variant || undefined }
          }
        }
      } else if (item.kind === 'tool') {
        tool++
        const meta = item.callId ? toolMeta.get(item.callId) : undefined
        if (meta) {
          item.status = meta.status
          item.exitCode = meta.exitCode
          item.durationMs = meta.durationMs
          item.readOnly = meta.readOnly
          item.destructive = meta.destructive
          item.approvalStatus = meta.approvalStatus
          item.outputBytes = meta.outputBytes ?? undefined
          if (meta.errorMessage && !item.error) item.error = meta.errorMessage
          if (meta.truncated) item.truncated = true
        }
      }
    }
    const totals = this.deps.store.tokenTotals(sessionId)
    return {
      sessionId,
      items,
      totals: { user, assistant, tool },
      tokens: {
        input: totals.input,
        output: totals.output,
        reasoning: totals.reasoning,
        cacheRead: totals.cacheRead,
        cacheWrite: totals.cacheWrite,
        calls: totals.calls
      },
      live: row.live,
      lastEventAt: this.deps.store.lastEventTime(sessionId),
      hasMore,
      tokenNote:
        'Token 来自 Z-Code 的 model_usage（按模型调用尝试累计）。input 含 cache_read，output 含 reasoning；缓存与推理单独展示，不重复相加。'
    }
  }

  listAttached(): AttachedSession[] {
    return this.deps.store.listAttached().map((row) => this.publicSession(row))
  }

  publicSession(row: StoredAttachedRow): AttachedSession {
    return {
      sessionId: row.sessionId,
      title: row.title,
      directory: row.directory,
      projectRoot: row.projectRoot,
      attachedAt: row.attachedAt,
      paused: row.paused,
      baseline: row.baseline.info,
      live: row.live,
      lastSyncAt: row.lastSyncAt,
      syncError: row.syncError,
      eventCount: row.eventCount,
      model: row.model,
      sourceDb: row.sourceDb,
      selectedFiles: row.selectedFiles
    }
  }

  getRow(sessionId: string): StoredAttachedRow {
    return this.ensureAttached(sessionId)
  }

  saveSelectedFiles(sessionId: string, files: string[] | null): AttachedSession {
    this.ensureAttached(sessionId)
    this.deps.store.setSelectedFiles(sessionId, files)
    const row = this.ensureAttached(sessionId)
    return this.publicSession(row)
  }

  getSummary(sessionId: string): SummaryDraft | null {
    return this.ensureAttached(sessionId).summary
  }

  saveSummary(sessionId: string, summary: SummaryDraft | null): SummaryDraft | null {
    this.ensureAttached(sessionId)
    this.deps.store.saveSummary(sessionId, summary)
    return summary
  }

  private ensureAttached(sessionId: string): StoredAttachedRow {
    const row = this.deps.store.getAttached(sessionId)
    if (!row) throw new RelayError('session-not-attached', '该会话尚未接入')
    return row
  }
}

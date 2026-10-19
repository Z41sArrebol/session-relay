import Database from 'better-sqlite3'
import type { AttachedSession, BaselineInfo, LiveState, ModelRef, SummaryDraft, TimelineItem, TodoItem } from '../../shared/types'

export interface BaselineFileSnapshot {
  sha256: string | null
  size: number | null
  status: string
}

export interface BaselineSnapshot {
  info: BaselineInfo
  files: Record<string, BaselineFileSnapshot>
  statusText: string
}

export interface SyncWatermarks {
  message: number
  part: number
  tool: number
  usage: number
  turn: number
  /** Per-session message sequence; catches new rows even if their clock is behind. */
  messageSequence: number
}

export interface StoredAttachedRow {
  sessionId: string
  projectRoot: string
  sourceDb: string
  attachedAt: number
  paused: boolean
  baseline: BaselineSnapshot
  selectedFiles: string[] | null
  summary: SummaryDraft | null
  title: string
  directory: string
  model: ModelRef | null
  lastSyncAt: number | null
  syncError: string | null
  eventCount: number
  live: LiveState
}

interface RawAttachedRow {
  session_id: string
  project_root: string
  source_db: string
  attached_at: number
  paused: number
  baseline_json: string | null
  selected_files_json: string | null
  summary_json: string | null
  title: string
  directory: string
  model_json: string | null
  last_sync_at: number | null
  sync_error: string | null
  event_count: number
  live_json: string | null
}

const DEFAULT_LIVE: LiveState = {
  state: 'unknown',
  label: '未同步',
  detail: '还没有读取该会话',
  asOf: 0,
  runningTurns: 0,
  runningTools: 0,
  lastActivityAt: null
}

export class RelayStore {
  private db: Database.Database

  constructor(dbPath: string) {
    this.db = new Database(dbPath)
    this.db.pragma('journal_mode = WAL')
    this.db.pragma('synchronous = NORMAL')
    this.db.pragma('busy_timeout = 5000')
    this.migrate()
  }

  private migrate(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS attached_sessions (
        session_id TEXT PRIMARY KEY,
        project_root TEXT NOT NULL,
        source_db TEXT NOT NULL,
        attached_at INTEGER NOT NULL,
        paused INTEGER NOT NULL DEFAULT 0,
        baseline_json TEXT,
        selected_files_json TEXT,
        summary_json TEXT,
        title TEXT NOT NULL DEFAULT '',
        directory TEXT NOT NULL DEFAULT '',
        model_json TEXT,
        last_sync_at INTEGER,
        sync_error TEXT,
        event_count INTEGER NOT NULL DEFAULT 0,
        live_json TEXT
      );

      CREATE TABLE IF NOT EXISTS sync_state (
        session_id TEXT PRIMARY KEY,
        message_watermark INTEGER NOT NULL DEFAULT 0,
        part_watermark INTEGER NOT NULL DEFAULT 0,
        tool_watermark INTEGER NOT NULL DEFAULT 0,
        usage_watermark INTEGER NOT NULL DEFAULT 0,
        turn_watermark INTEGER NOT NULL DEFAULT 0,
        message_sequence INTEGER NOT NULL DEFAULT 0
      );

      CREATE TABLE IF NOT EXISTS events (
        session_id TEXT NOT NULL,
        event_id TEXT NOT NULL,
        kind TEXT NOT NULL,
        time INTEGER NOT NULL,
        message_id TEXT NOT NULL DEFAULT '',
        part_id TEXT,
        turn_id TEXT,
        sequence INTEGER NOT NULL DEFAULT 0,
        payload TEXT NOT NULL,
        content_hash TEXT NOT NULL,
        PRIMARY KEY (session_id, event_id)
      );
      CREATE INDEX IF NOT EXISTS events_session_time ON events(session_id, time, sequence);

      CREATE TABLE IF NOT EXISTS message_meta (
        session_id TEXT NOT NULL,
        message_id TEXT NOT NULL,
        role TEXT NOT NULL,
        parent_id TEXT,
        finish TEXT,
        model_id TEXT,
        provider_id TEXT,
        variant TEXT,
        origin TEXT,
        visibility TEXT,
        synthetic INTEGER NOT NULL DEFAULT 0,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        completed_at INTEGER,
        PRIMARY KEY (session_id, message_id)
      );

      CREATE TABLE IF NOT EXISTS tool_meta (
        session_id TEXT NOT NULL,
        id TEXT NOT NULL,
        call_id TEXT NOT NULL,
        tool_name TEXT NOT NULL,
        status TEXT NOT NULL,
        started_at INTEGER NOT NULL,
        completed_at INTEGER,
        duration_ms INTEGER,
        exit_code INTEGER,
        read_only INTEGER,
        destructive INTEGER,
        approval_status TEXT,
        output_bytes INTEGER,
        truncated INTEGER,
        error_message TEXT,
        PRIMARY KEY (session_id, id)
      );
      CREATE INDEX IF NOT EXISTS tool_meta_call ON tool_meta(session_id, call_id);

      CREATE TABLE IF NOT EXISTS turn_meta (
        session_id TEXT NOT NULL,
        turn_id TEXT NOT NULL,
        status TEXT NOT NULL,
        started_at INTEGER NOT NULL,
        completed_at INTEGER,
        user_message_id TEXT,
        tool_call_count INTEGER NOT NULL DEFAULT 0,
        tool_error_count INTEGER NOT NULL DEFAULT 0,
        input_tokens INTEGER NOT NULL DEFAULT 0,
        output_tokens INTEGER NOT NULL DEFAULT 0,
        reasoning_tokens INTEGER NOT NULL DEFAULT 0,
        context_exceeded INTEGER NOT NULL DEFAULT 0,
        cancelled_by_user INTEGER NOT NULL DEFAULT 0,
        error_type TEXT,
        PRIMARY KEY (session_id, turn_id)
      );

      CREATE TABLE IF NOT EXISTS model_calls (
        session_id TEXT NOT NULL,
        id TEXT NOT NULL,
        message_id TEXT,
        provider_id TEXT NOT NULL,
        model_id TEXT NOT NULL,
        variant TEXT,
        input_tokens INTEGER NOT NULL DEFAULT 0,
        output_tokens INTEGER NOT NULL DEFAULT 0,
        reasoning_tokens INTEGER NOT NULL DEFAULT 0,
        cache_read INTEGER NOT NULL DEFAULT 0,
        cache_write INTEGER NOT NULL DEFAULT 0,
        started_at INTEGER NOT NULL,
        status TEXT NOT NULL,
        error_type TEXT,
        PRIMARY KEY (session_id, id)
      );

      CREATE TABLE IF NOT EXISTS todo_meta (
        session_id TEXT NOT NULL,
        position INTEGER NOT NULL,
        content TEXT NOT NULL,
        status TEXT NOT NULL,
        priority TEXT NOT NULL,
        updated_at INTEGER NOT NULL,
        PRIMARY KEY (session_id, position)
      );

      CREATE TABLE IF NOT EXISTS kv (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );
    `)
    const syncCols = (this.db.prepare('PRAGMA table_info(sync_state)').all() as Array<{ name: string }>).map((c) => c.name)
    if (!syncCols.includes('message_sequence')) {
      this.db.exec('ALTER TABLE sync_state ADD COLUMN message_sequence INTEGER NOT NULL DEFAULT 0')
    }
    const addColumn = (table: string, column: string, ddl: string): void => {
      const cols = (this.db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).map((c) => c.name)
      if (!cols.includes(column)) this.db.exec(`ALTER TABLE ${table} ADD COLUMN ${ddl}`)
    }
    addColumn('turn_meta', 'context_exceeded', 'context_exceeded INTEGER NOT NULL DEFAULT 0')
    addColumn('turn_meta', 'cancelled_by_user', 'cancelled_by_user INTEGER NOT NULL DEFAULT 0')
    addColumn('turn_meta', 'error_type', 'error_type TEXT')
    addColumn('model_calls', 'error_type', 'error_type TEXT')
  }

  close(): void {
    this.db.close()
  }

  private raw(sessionId: string): RawAttachedRow | undefined {
    return this.db.prepare('SELECT * FROM attached_sessions WHERE session_id = ?').get(sessionId) as
      | RawAttachedRow
      | undefined
  }

  getAttached(sessionId: string): StoredAttachedRow | null {
    const r = this.raw(sessionId)
    if (!r) return null
    return this.toStored(r)
  }

  listAttached(): StoredAttachedRow[] {
    const rows = this.db.prepare('SELECT * FROM attached_sessions ORDER BY attached_at ASC').all() as RawAttachedRow[]
    return rows.map((r) => this.toStored(r))
  }

  private toStored(r: RawAttachedRow): StoredAttachedRow {
    return {
      sessionId: r.session_id,
      projectRoot: r.project_root,
      sourceDb: r.source_db,
      attachedAt: r.attached_at,
      paused: r.paused === 1,
      baseline: normalizeBaseline(r.baseline_json),
      selectedFiles: safeJson<string[]>(r.selected_files_json),
      summary: safeJson<SummaryDraft>(r.summary_json),
      title: r.title,
      directory: r.directory,
      model: safeJson<ModelRef>(r.model_json),
      lastSyncAt: r.last_sync_at,
      syncError: r.sync_error,
      eventCount: r.event_count,
      live: safeJson<LiveState>(r.live_json) || DEFAULT_LIVE
    }
  }

  attach(input: {
    sessionId: string
    projectRoot: string
    sourceDb: string
    baseline: BaselineSnapshot
    title: string
    directory: string
    model: ModelRef | null
    attachedAt: number
  }): void {
    this.db
      .prepare(
        `INSERT INTO attached_sessions
          (session_id, project_root, source_db, attached_at, paused, baseline_json, title, directory, model_json, live_json)
         VALUES (?, ?, ?, ?, 0, ?, ?, ?, ?, ?)
         ON CONFLICT(session_id) DO UPDATE SET
           project_root = excluded.project_root,
           source_db = excluded.source_db,
           baseline_json = excluded.baseline_json,
           title = excluded.title,
           directory = excluded.directory,
           model_json = excluded.model_json`
      )
      .run(
        input.sessionId,
        input.projectRoot,
        input.sourceDb,
        input.attachedAt,
        JSON.stringify(input.baseline),
        input.title,
        input.directory,
        JSON.stringify(input.model),
        JSON.stringify(DEFAULT_LIVE)
      )
    this.db
      .prepare('INSERT OR IGNORE INTO sync_state (session_id) VALUES (?)')
      .run(input.sessionId)
  }

  detach(sessionId: string): void {
    const tx = this.db.transaction(() => {
      this.db.prepare('DELETE FROM attached_sessions WHERE session_id = ?').run(sessionId)
      this.db.prepare('DELETE FROM sync_state WHERE session_id = ?').run(sessionId)
      this.db.prepare('DELETE FROM events WHERE session_id = ?').run(sessionId)
      this.db.prepare('DELETE FROM message_meta WHERE session_id = ?').run(sessionId)
      this.db.prepare('DELETE FROM tool_meta WHERE session_id = ?').run(sessionId)
      this.db.prepare('DELETE FROM turn_meta WHERE session_id = ?').run(sessionId)
      this.db.prepare('DELETE FROM model_calls WHERE session_id = ?').run(sessionId)
      this.db.prepare('DELETE FROM todo_meta WHERE session_id = ?').run(sessionId)
    })
    tx()
  }

  setPaused(sessionId: string, paused: boolean): void {
    this.db.prepare('UPDATE attached_sessions SET paused = ? WHERE session_id = ?').run(paused ? 1 : 0, sessionId)
  }

  updateSessionInfo(
    sessionId: string,
    info: { title: string; directory: string; model: ModelRef | null; lastSyncAt: number; syncError: string | null; live: LiveState; eventCount: number }
  ): void {
    this.db
      .prepare(
        `UPDATE attached_sessions SET title = ?, directory = ?, model_json = ?, last_sync_at = ?,
          sync_error = ?, live_json = ?, event_count = ? WHERE session_id = ?`
      )
      .run(
        info.title,
        info.directory,
        JSON.stringify(info.model),
        info.lastSyncAt,
        info.syncError,
        JSON.stringify(info.live),
        info.eventCount,
        sessionId
      )
  }

  setLive(sessionId: string, live: LiveState): void {
    this.db.prepare('UPDATE attached_sessions SET live_json = ? WHERE session_id = ?').run(JSON.stringify(live), sessionId)
  }

  setSyncError(sessionId: string, message: string | null): void {
    this.db.prepare('UPDATE attached_sessions SET sync_error = ? WHERE session_id = ?').run(message, sessionId)
  }

  getWatermarks(sessionId: string): SyncWatermarks {
    const r = this.db.prepare('SELECT * FROM sync_state WHERE session_id = ?').get(sessionId) as
      | {
          message_watermark: number
          part_watermark: number
          tool_watermark: number
          usage_watermark: number
          turn_watermark: number
          message_sequence: number
        }
      | undefined
    return {
      message: r?.message_watermark ?? 0,
      part: r?.part_watermark ?? 0,
      tool: r?.tool_watermark ?? 0,
      usage: r?.usage_watermark ?? 0,
      turn: r?.turn_watermark ?? 0,
      messageSequence: r?.message_sequence ?? 0
    }
  }

  setWatermarks(sessionId: string, w: SyncWatermarks): void {
    this.db
      .prepare(
        `INSERT INTO sync_state (session_id, message_watermark, part_watermark, tool_watermark, usage_watermark, turn_watermark, message_sequence)
         VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(session_id) DO UPDATE SET
           message_watermark = excluded.message_watermark,
           part_watermark = excluded.part_watermark,
           tool_watermark = excluded.tool_watermark,
           usage_watermark = excluded.usage_watermark,
           turn_watermark = excluded.turn_watermark,
           message_sequence = excluded.message_sequence`
      )
      .run(sessionId, w.message, w.part, w.tool, w.usage, w.turn, w.messageSequence)
  }

  upsertMessageMeta(sessionId: string, rows: MessageMetaRow[]): void {
    const stmt = this.db.prepare(
      `INSERT INTO message_meta
        (session_id, message_id, role, parent_id, finish, model_id, provider_id, variant, origin, visibility, synthetic, created_at, updated_at, completed_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(session_id, message_id) DO UPDATE SET
         role = excluded.role, parent_id = excluded.parent_id, finish = excluded.finish,
         model_id = excluded.model_id, provider_id = excluded.provider_id, variant = excluded.variant,
         origin = excluded.origin, visibility = excluded.visibility, synthetic = excluded.synthetic,
         created_at = excluded.created_at, updated_at = excluded.updated_at, completed_at = excluded.completed_at`
    )
    const tx = this.db.transaction((items: MessageMetaRow[]) => {
      for (const r of items) {
        stmt.run(
          sessionId,
          r.messageId,
          r.role,
          r.parentId,
          r.finish,
          r.modelId,
          r.providerId,
          r.variant,
          r.origin,
          r.visibility,
          r.synthetic ? 1 : 0,
          r.createdAt,
          r.updatedAt,
          r.completedAt
        )
      }
    })
    tx(rows)
  }

  getMessageMeta(sessionId: string, messageId: string): MessageMetaRow | null {
    const r = this.db
      .prepare('SELECT * FROM message_meta WHERE session_id = ? AND message_id = ?')
      .get(sessionId, messageId) as
      | {
          message_id: string
          role: string
          parent_id: string | null
          finish: string | null
          model_id: string | null
          provider_id: string | null
          variant: string | null
          origin: string | null
          visibility: string | null
          synthetic: number
          created_at: number
          updated_at: number
          completed_at: number | null
        }
      | undefined
    if (!r) return null
    return {
      messageId: r.message_id,
      role: r.role,
      parentId: r.parent_id,
      finish: r.finish,
      modelId: r.model_id,
      providerId: r.provider_id,
      variant: r.variant,
      origin: r.origin,
      visibility: r.visibility,
      synthetic: r.synthetic === 1,
      createdAt: r.created_at,
      updatedAt: r.updated_at,
      completedAt: r.completed_at
    }
  }

  upsertEvents(
    sessionId: string,
    events: Array<{ eventId: string; kind: string; time: number; messageId: string; partId: string | null; turnId: string | null; sequence: number; payload: string; contentHash: string }>
  ): { inserted: number; updated: number } {
    let inserted = 0
    let updated = 0
    const existsStmt = this.db.prepare('SELECT content_hash FROM events WHERE session_id = ? AND event_id = ?')
    const insertStmt = this.db.prepare(
      `INSERT INTO events (session_id, event_id, kind, time, message_id, part_id, turn_id, sequence, payload, content_hash)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    const updateStmt = this.db.prepare(
      `UPDATE events SET kind = ?, time = ?, message_id = ?, part_id = ?, turn_id = ?, sequence = ?, payload = ?, content_hash = ?
       WHERE session_id = ? AND event_id = ?`
    )
    const tx = this.db.transaction(() => {
      for (const e of events) {
        const existing = existsStmt.get(sessionId, e.eventId) as { content_hash: string } | undefined
        if (!existing) {
          insertStmt.run(sessionId, e.eventId, e.kind, e.time, e.messageId, e.partId, e.turnId, e.sequence, e.payload, e.contentHash)
          inserted++
        } else if (existing.content_hash !== e.contentHash) {
          updateStmt.run(e.kind, e.time, e.messageId, e.partId, e.turnId, e.sequence, e.payload, e.contentHash, sessionId, e.eventId)
          updated++
        }
      }
    })
    tx()
    return { inserted, updated }
  }

  getTimeline(sessionId: string, limit = 5000): { items: TimelineItem[]; hasMore: boolean } {
    const total = (this.db.prepare('SELECT COUNT(*) n FROM events WHERE session_id = ?').get(sessionId) as { n: number }).n
    const rows = this.db
      .prepare(
        `SELECT payload FROM events WHERE session_id = ? ORDER BY time ASC, sequence ASC, event_id ASC LIMIT ? OFFSET ?`
      )
      .all(sessionId, limit, Math.max(0, total - limit)) as Array<{ payload: string }>
    const items: TimelineItem[] = []
    for (const row of rows) {
      const item = safeJson<TimelineItem>(row.payload)
      if (item) items.push(item)
    }
    return { items, hasMore: total > limit }
  }

  lastEventTime(sessionId: string): number | null {
    const r = this.db.prepare('SELECT MAX(time) t FROM events WHERE session_id = ?').get(sessionId) as { t: number | null }
    return r?.t ?? null
  }

  countEvents(sessionId: string): number {
    return (this.db.prepare('SELECT COUNT(*) n FROM events WHERE session_id = ?').get(sessionId) as { n: number }).n
  }

  upsertToolMeta(sessionId: string, rows: ToolMetaRow[]): void {
    const stmt = this.db.prepare(
      `INSERT INTO tool_meta (session_id, id, call_id, tool_name, status, started_at, completed_at, duration_ms, exit_code, read_only, destructive, approval_status, output_bytes, truncated, error_message)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(session_id, id) DO UPDATE SET
         call_id = excluded.call_id, tool_name = excluded.tool_name, status = excluded.status,
         started_at = excluded.started_at, completed_at = excluded.completed_at, duration_ms = excluded.duration_ms,
         exit_code = excluded.exit_code, read_only = excluded.read_only, destructive = excluded.destructive,
         approval_status = excluded.approval_status, output_bytes = excluded.output_bytes,
         truncated = excluded.truncated, error_message = excluded.error_message`
    )
    const tx = this.db.transaction((items: ToolMetaRow[]) => {
      for (const r of items) {
        stmt.run(
          sessionId,
          r.id,
          r.callId,
          r.toolName,
          r.status,
          r.startedAt,
          r.completedAt,
          r.durationMs,
          r.exitCode,
          r.readOnly === null ? null : r.readOnly ? 1 : 0,
          r.destructive === null ? null : r.destructive ? 1 : 0,
          r.approvalStatus,
          r.outputBytes,
          r.truncated === null ? null : r.truncated ? 1 : 0,
          r.errorMessage
        )
      }
    })
    tx(rows)
  }

  getToolMetaMap(sessionId: string): Map<string, ToolMetaRow> {
    const rows = this.db.prepare('SELECT * FROM tool_meta WHERE session_id = ?').all(sessionId) as Array<Record<string, unknown>>
    const map = new Map<string, ToolMetaRow>()
    for (const r of rows) {
      map.set(String(r.call_id), {
        id: String(r.id),
        callId: String(r.call_id),
        toolName: String(r.tool_name),
        status: String(r.status) as ToolMetaRow['status'],
        startedAt: Number(r.started_at),
        completedAt: r.completed_at === null ? null : Number(r.completed_at),
        durationMs: r.duration_ms === null ? null : Number(r.duration_ms),
        exitCode: r.exit_code === null ? null : Number(r.exit_code),
        readOnly: r.read_only === null ? null : Number(r.read_only) === 1,
        destructive: r.destructive === null ? null : Number(r.destructive) === 1,
        approvalStatus: r.approval_status === null ? null : String(r.approval_status),
        outputBytes: r.output_bytes === null ? null : Number(r.output_bytes),
        truncated: r.truncated === null ? null : Number(r.truncated) === 1,
        errorMessage: r.error_message === null ? null : String(r.error_message)
      })
    }
    return map
  }

  upsertTurnMeta(sessionId: string, rows: TurnMetaRow[]): void {
    const stmt = this.db.prepare(
      `INSERT INTO turn_meta (session_id, turn_id, status, started_at, completed_at, user_message_id, tool_call_count, tool_error_count, input_tokens, output_tokens, reasoning_tokens, context_exceeded, cancelled_by_user, error_type)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(session_id, turn_id) DO UPDATE SET
         status = excluded.status, started_at = excluded.started_at, completed_at = excluded.completed_at,
         user_message_id = excluded.user_message_id, tool_call_count = excluded.tool_call_count,
         tool_error_count = excluded.tool_error_count, input_tokens = excluded.input_tokens,
         output_tokens = excluded.output_tokens, reasoning_tokens = excluded.reasoning_tokens,
         context_exceeded = excluded.context_exceeded, cancelled_by_user = excluded.cancelled_by_user,
         error_type = excluded.error_type`
    )
    const tx = this.db.transaction((items: TurnMetaRow[]) => {
      for (const r of items) {
        stmt.run(
          sessionId,
          r.turnId,
          r.status,
          r.startedAt,
          r.completedAt,
          r.userMessageId,
          r.toolCallCount,
          r.toolErrorCount,
          r.inputTokens,
          r.outputTokens,
          r.reasoningTokens,
          r.contextExceeded ? 1 : 0,
          r.cancelledByUser ? 1 : 0,
          r.errorType
        )
      }
    })
    tx(rows)
  }

  getTurns(sessionId: string): TurnMetaRow[] {
    const rows = this.db.prepare('SELECT * FROM turn_meta WHERE session_id = ? ORDER BY started_at ASC').all(sessionId) as Array<Record<string, unknown>>
    return rows.map((r) => ({
      turnId: String(r.turn_id),
      status: String(r.status) as TurnMetaRow['status'],
      startedAt: Number(r.started_at),
      completedAt: r.completed_at === null ? null : Number(r.completed_at),
      userMessageId: r.user_message_id === null ? null : String(r.user_message_id),
      toolCallCount: Number(r.tool_call_count),
      toolErrorCount: Number(r.tool_error_count),
      inputTokens: Number(r.input_tokens),
      outputTokens: Number(r.output_tokens),
      reasoningTokens: Number(r.reasoning_tokens),
      contextExceeded: Number(r.context_exceeded) === 1,
      cancelledByUser: Number(r.cancelled_by_user) === 1,
      errorType: r.error_type === null || r.error_type === undefined ? null : String(r.error_type)
    }))
  }

  upsertModelCalls(sessionId: string, rows: ModelCallRow[]): void {
    const stmt = this.db.prepare(
      `INSERT INTO model_calls (session_id, id, message_id, provider_id, model_id, variant, input_tokens, output_tokens, reasoning_tokens, cache_read, cache_write, started_at, status, error_type)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(session_id, id) DO UPDATE SET
         message_id = excluded.message_id, provider_id = excluded.provider_id, model_id = excluded.model_id,
         variant = excluded.variant, input_tokens = excluded.input_tokens, output_tokens = excluded.output_tokens,
         reasoning_tokens = excluded.reasoning_tokens, cache_read = excluded.cache_read,
         cache_write = excluded.cache_write, started_at = excluded.started_at, status = excluded.status,
         error_type = excluded.error_type`
    )
    const tx = this.db.transaction((items: ModelCallRow[]) => {
      for (const r of items) {
        stmt.run(
          sessionId,
          r.id,
          r.messageId,
          r.providerId,
          r.modelId,
          r.variant,
          r.inputTokens,
          r.outputTokens,
          r.reasoningTokens,
          r.cacheRead,
          r.cacheWrite,
          r.startedAt,
          r.status,
          r.errorType
        )
      }
    })
    tx(rows)
  }

  getModelCallsByMessage(sessionId: string): Map<string, ModelCallRow[]> {
    const rows = this.db.prepare('SELECT * FROM model_calls WHERE session_id = ? ORDER BY started_at ASC').all(sessionId) as Array<
      Record<string, unknown>
    >
    const map = new Map<string, ModelCallRow[]>()
    for (const r of rows) {
      const messageId = r.message_id === null ? '' : String(r.message_id)
      if (!messageId) continue
      const row: ModelCallRow = {
        id: String(r.id),
        messageId,
        providerId: String(r.provider_id),
        modelId: String(r.model_id),
        variant: r.variant === null ? null : String(r.variant),
        inputTokens: Number(r.input_tokens),
        outputTokens: Number(r.output_tokens),
        reasoningTokens: Number(r.reasoning_tokens),
        cacheRead: Number(r.cache_read),
        cacheWrite: Number(r.cache_write),
        startedAt: Number(r.started_at),
        status: String(r.status),
        errorType: r.error_type === null || r.error_type === undefined ? null : String(r.error_type)
      }
      const list = map.get(messageId)
      if (list) list.push(row)
      else map.set(messageId, [row])
    }
    return map
  }

  replaceTodos(sessionId: string, rows: TodoItem[]): void {
    const insert = this.db.prepare(
      `INSERT INTO todo_meta (session_id, position, content, status, priority, updated_at)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(session_id, position) DO UPDATE SET
         content = excluded.content, status = excluded.status, priority = excluded.priority,
         updated_at = excluded.updated_at`
    )
    const tx = this.db.transaction((items: TodoItem[]) => {
      this.db.prepare('DELETE FROM todo_meta WHERE session_id = ?').run(sessionId)
      for (const r of items) {
        insert.run(sessionId, r.position, r.content, r.status, r.priority, r.updatedAt)
      }
    })
    tx(rows)
  }

  getTodos(sessionId: string): TodoItem[] {
    const rows = this.db
      .prepare('SELECT * FROM todo_meta WHERE session_id = ? ORDER BY position ASC')
      .all(sessionId) as Array<Record<string, unknown>>
    return rows.map((r) => ({
      content: String(r.content),
      status: String(r.status),
      priority: String(r.priority),
      position: Number(r.position),
      updatedAt: Number(r.updated_at)
    }))
  }

  countModelErrors(sessionId: string): number {
    return (
      this.db
        .prepare("SELECT COUNT(*) n FROM model_calls WHERE session_id = ? AND status IN ('error','cancelled')")
        .get(sessionId) as { n: number }
    ).n
  }

  countIncompleteAssistantMessages(sessionId: string): number {
    return (
      this.db
        .prepare(
          "SELECT COUNT(*) n FROM message_meta WHERE session_id = ? AND role = 'assistant' AND completed_at IS NULL"
        )
        .get(sessionId) as { n: number }
    ).n
  }

  countRunningTools(sessionId: string): number {
    return (
      this.db
        .prepare("SELECT COUNT(*) n FROM tool_meta WHERE session_id = ? AND status = 'running'")
        .get(sessionId) as { n: number }
    ).n
  }

  tokenTotals(sessionId: string): {
    input: number
    output: number
    reasoning: number
    cacheRead: number
    cacheWrite: number
    calls: number
  } {
    const r = this.db
      .prepare(
        `SELECT COALESCE(SUM(input_tokens),0) input, COALESCE(SUM(output_tokens),0) output,
          COALESCE(SUM(reasoning_tokens),0) reasoning, COALESCE(SUM(cache_read),0) cache_read,
          COALESCE(SUM(cache_write),0) cache_write, COUNT(*) calls
         FROM model_calls WHERE session_id = ?`
      )
      .get(sessionId) as Record<string, number>
    return {
      input: Number(r.input),
      output: Number(r.output),
      reasoning: Number(r.reasoning),
      cacheRead: Number(r.cache_read),
      cacheWrite: Number(r.cache_write),
      calls: Number(r.calls)
    }
  }

  setSelectedFiles(sessionId: string, files: string[] | null): void {
    this.db
      .prepare('UPDATE attached_sessions SET selected_files_json = ? WHERE session_id = ?')
      .run(files === null ? null : JSON.stringify(files), sessionId)
  }

  saveSummary(sessionId: string, summary: SummaryDraft | null): void {
    this.db
      .prepare('UPDATE attached_sessions SET summary_json = ? WHERE session_id = ?')
      .run(summary === null ? null : JSON.stringify(summary), sessionId)
  }

  getKv(key: string): string | null {
    const r = this.db.prepare('SELECT value FROM kv WHERE key = ?').get(key) as { value: string } | undefined
    return r?.value ?? null
  }

  setKv(key: string, value: string): void {
    this.db
      .prepare('INSERT INTO kv (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
      .run(key, value)
  }
}

export interface MessageMetaRow {
  messageId: string
  role: string
  parentId: string | null
  finish: string | null
  modelId: string | null
  providerId: string | null
  variant: string | null
  origin: string | null
  visibility: string | null
  synthetic: boolean
  createdAt: number
  updatedAt: number
  completedAt: number | null
}

export interface ToolMetaRow {
  id: string
  callId: string
  toolName: string
  status: 'running' | 'completed' | 'error' | 'cancelled'
  startedAt: number
  completedAt: number | null
  durationMs: number | null
  exitCode: number | null
  readOnly: boolean | null
  destructive: boolean | null
  approvalStatus: string | null
  outputBytes: number | null
  truncated: boolean | null
  errorMessage: string | null
}

export interface TurnMetaRow {
  turnId: string
  status: 'running' | 'completed' | 'error' | 'cancelled'
  startedAt: number
  completedAt: number | null
  userMessageId: string | null
  toolCallCount: number
  toolErrorCount: number
  inputTokens: number
  outputTokens: number
  reasoningTokens: number
  contextExceeded: boolean
  cancelledByUser: boolean
  errorType: string | null
}

export interface ModelCallRow {
  id: string
  messageId: string | null
  providerId: string
  modelId: string
  variant: string | null
  inputTokens: number
  outputTokens: number
  reasoningTokens: number
  cacheRead: number
  cacheWrite: number
  startedAt: number
  status: string
  errorType: string | null
}

function normalizeBaseline(raw: string | null | undefined): BaselineSnapshot {
  const parsed = safeJson<Partial<BaselineSnapshot> & Partial<BaselineInfo>>(raw)
  if (parsed && parsed.info) {
    return {
      info: parsed.info,
      files: parsed.files || {},
      statusText: parsed.statusText || ''
    }
  }
  // Older app state stored BaselineInfo directly (before file snapshots).
  if (parsed && typeof parsed.hasBaseline === 'boolean') {
    return {
      info: {
        id: parsed.id || '',
        capturedAt: parsed.capturedAt || 0,
        hasBaseline: parsed.hasBaseline,
        head: parsed.head || null,
        gitRoot: parsed.gitRoot || null,
        note: parsed.note || '旧版基线：没有逐文件快照',
        reason: parsed.reason
      },
      files: {},
      statusText: ''
    }
  }
  return {
    info: {
      id: '',
      capturedAt: 0,
      hasBaseline: false,
      head: null,
      gitRoot: null,
      note: '没有基线'
    },
    files: {},
    statusText: ''
  }
}

function safeJson<T>(raw: string | null | undefined): T | null {
  if (!raw) return null
  try {
    return JSON.parse(raw) as T
  } catch {
    return null
  }
}

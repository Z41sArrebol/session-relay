import Database from 'better-sqlite3'
import { existsSync } from 'node:fs'
import type { ModelRef, SessionSummary, TodoItem } from '../../../shared/types'
import type { MessageMetaRow, ModelCallRow, SyncWatermarks, ToolMetaRow, TurnMetaRow } from '../state'
import { RelayError } from '../paths'

/**
 * 15s overlap. This is a safety margin for late writes, not a correctness
 * guarantee. Correctness comes from: primary-key upsert + always re-reading
 * unfinished rows (running tools / turns / model calls / incomplete assistant
 * messages) on every poll, regardless of the time watermark.
 */
const OVERLAP_MS = 15_000

export interface ZCapabilities {
  toolUsage: boolean
  turnUsage: boolean
  modelUsage: boolean
  todo: boolean
  json: boolean
}

export interface SchemaProbe {
  compatible: boolean
  missing: string[]
  detail: string
  optionalTables: string[]
  capabilities: ZCapabilities
  degraded: string[]
}

export interface ZSessionRow {
  id: string
  parentId: string | null
  projectId: string
  directory: string
  title: string
  titleSource: string
  taskType: string
  version: string
  createdAt: number
  updatedAt: number
  archived: boolean
  childCount: number
}

export interface ZMessageRow {
  id: string
  createdAt: number
  updatedAt: number
  sequence: number
  meta: MessageMetaRow
}

export interface ZPartRow {
  id: string
  messageId: string
  createdAt: number
  updatedAt: number
  sequence: number
  data: Record<string, unknown>
}

export interface ZSyncData {
  session: ZSessionRow | null
  messages: ZMessageRow[]
  parts: ZPartRow[]
  tools: ToolMetaRow[]
  turns: TurnMetaRow[]
  models: ModelCallRow[]
  todos: TodoItem[]
  watermarks: SyncWatermarks
  capabilities: ZCapabilities
}

interface RawSessionRow {
  id: string
  parent_id: string | null
  project_id: string | null
  directory: string
  title: string
  title_source: string | null
  task_type: string | null
  version: string | null
  time_created: number
  time_updated: number
  time_archived: number | null
  child_count?: number
}

interface RawMessageRow {
  id: string
  time_created: number
  time_updated: number
  sequence: number | null
  data: string
}

interface RawPartRow {
  id: string
  message_id: string
  time_created: number
  time_updated: number
  sequence: number | null
  data: string
}

function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)
}

function retry<T>(fn: () => T, attempts = 4): T {
  let last: unknown
  for (let i = 0; i < attempts; i++) {
    try {
      return fn()
    } catch (error) {
      last = error
      const code = (error as { code?: string }).code || ''
      if (!/SQLITE_BUSY|SQLITE_LOCKED|database is locked/i.test(code + String((error as Error).message))) {
        throw error
      }
      sleepSync(120 * (i + 1))
    }
  }
  throw last
}

function json<T = Record<string, unknown>>(text: string): T | null {
  try {
    return JSON.parse(text) as T
  } catch {
    return null
  }
}

function num(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0
}

function str(value: unknown): string {
  return typeof value === 'string' ? value : ''
}

const REQUIRED_TABLES = ['session', 'message', 'part']

const REQUIRED_COLUMNS: Record<string, string[]> = {
  session: ['id', 'parent_id', 'directory', 'title', 'time_created', 'time_updated'],
  message: ['id', 'session_id', 'time_created', 'time_updated', 'data'],
  part: ['id', 'message_id', 'session_id', 'time_created', 'time_updated', 'data']
}

const OPTIONAL_TABLE_COLUMNS: Record<string, { required: string[]; label: string }> = {
  tool_usage: {
    label: '工具执行元数据',
    required: [
      'id',
      'tool_call_id',
      'tool_name',
      'status',
      'started_at',
      'completed_at',
      'duration_ms',
      'exit_code',
      'read_only',
      'destructive',
      'approval_status',
      'output_bytes',
      'truncated',
      'error_message'
    ]
  },
  turn_usage: {
    label: 'turn 状态与统计',
    required: ['turn_id', 'status', 'started_at', 'completed_at']
  },
  model_usage: {
    label: '模型调用与 Token',
    required: [
      'id',
      'assistant_message_id',
      'provider_id',
      'model_id',
      'input_tokens',
      'output_tokens',
      'reasoning_tokens',
      'started_at',
      'status'
    ]
  },
  todo: {
    label: '会话待办',
    required: ['session_id', 'content', 'status', 'priority', 'position', 'time_updated']
  }
}

export class ZcodeReader {
  readonly path: string
  private db: Database.Database | null = null
  private schema: SchemaProbe
  private columns = new Map<string, Set<string>>()

  constructor(dbPath: string, opts: { busyTimeoutMs?: number } = {}) {
    this.path = dbPath
    this.schema = {
      compatible: false,
      missing: [],
      detail: '未连接',
      optionalTables: [],
      capabilities: { toolUsage: false, turnUsage: false, modelUsage: false, todo: false, json: false },
      degraded: []
    }
    if (!existsSync(dbPath)) {
      this.schema = {
        ...this.schema,
        missing: ['database'],
        detail: `找不到 ${dbPath}`
      }
      return
    }
    const busyTimeout = opts.busyTimeoutMs ?? 5000
    this.db = new Database(dbPath, { readonly: true, fileMustExist: true, timeout: busyTimeout })
    this.db.pragma('query_only = ON')
    this.db.pragma(`busy_timeout = ${busyTimeout}`)
    this.schema = this.probe()
  }

  getSchema(): SchemaProbe {
    return this.schema
  }

  close(): void {
    this.db?.close()
    this.db = null
  }

  private requireDb(): Database.Database {
    if (!this.db) throw new RelayError('zcode-unavailable', this.schema.detail || 'Z-Code 数据库不可用')
    return this.db
  }

  private tableColumns(table: string): Set<string> {
    const cached = this.columns.get(table)
    if (cached) return cached
    const db = this.requireDb()
    const rows = retry(() => db.prepare(`PRAGMA table_info("${table}")`).all()) as Array<{ name: string }>
    const set = new Set(rows.map((r) => r.name))
    this.columns.set(table, set)
    return set
  }

  private has(table: string, column: string): boolean {
    return this.tableColumns(table).has(column)
  }

  private probe(): SchemaProbe {
    const db = this.requireDb()
    const tables = new Set(
      (retry(() => db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all()) as Array<{ name: string }>).map(
        (r) => r.name
      )
    )
    const missing: string[] = []
    const degraded: string[] = []

    for (const table of REQUIRED_TABLES) {
      if (!tables.has(table)) missing.push(`表 ${table}`)
    }
    for (const [table, needed] of Object.entries(REQUIRED_COLUMNS)) {
      if (!tables.has(table)) continue
      const cols = this.tableColumns(table)
      const absent = needed.filter((c) => !cols.has(c))
      if (absent.length) missing.push(`${table}.${absent.join(',')}`)
    }

    let jsonOk = false
    try {
      db.prepare("SELECT json_valid('{}') v").get()
      jsonOk = true
    } catch {
      degraded.push('SQLite 缺少 JSON1，无法复查未完成消息/工具的中间状态')
    }

    const capabilities: ZCapabilities = {
      toolUsage: false,
      turnUsage: false,
      modelUsage: false,
      todo: false,
      json: jsonOk
    }
    const optionalTables: string[] = []
    for (const [table, spec] of Object.entries(OPTIONAL_TABLE_COLUMNS)) {
      if (!tables.has(table)) {
        degraded.push(`缺少可选表 ${table}（${spec.label}不可用）`)
        continue
      }
      const cols = this.tableColumns(table)
      const absent = spec.required.filter((c) => !cols.has(c))
      if (absent.length) {
        degraded.push(`可选表 ${table} 缺列 ${absent.join(',')}（${spec.label}降级）`)
        continue
      }
      optionalTables.push(table)
      if (table === 'tool_usage') capabilities.toolUsage = true
      if (table === 'turn_usage') capabilities.turnUsage = true
      if (table === 'model_usage') capabilities.modelUsage = true
      if (table === 'todo') capabilities.todo = true
    }

    const compatible = missing.length === 0
    return {
      compatible,
      missing,
      optionalTables,
      capabilities,
      degraded,
      detail: compatible
        ? `结构兼容：session / message / part；可选能力 ${optionalTables.join('、') || '无'}${
            degraded.length ? `；降级：${degraded.join('；')}` : ''
          }`
        : `结构不兼容：${missing.join('；')}`
    }
  }

  private sessionColumn(name: string, fallback: string): string {
    return this.has('session', name) ? `s.${name}` : fallback
  }

  listSessions(limit = 400): SessionSummary[] {
    const db = this.requireDb()
    if (!this.schema.compatible) throw new RelayError('schema-incompatible', this.schema.detail)
    const projectId = this.sessionColumn('project_id', "''")
    const titleSource = this.sessionColumn('title_source', "''")
    const taskType = this.sessionColumn('task_type', "'interactive'")
    const version = this.sessionColumn('version', "''")
    const archived = this.sessionColumn('time_archived', 'NULL')
    const rows = retry(() =>
      db
        .prepare(
          `SELECT s.id, s.parent_id, ${projectId} project_id, s.directory, s.title,
                  ${titleSource} title_source, ${taskType} task_type, ${version} version,
                  s.time_created, s.time_updated, ${archived} time_archived,
                  (SELECT COUNT(*) FROM session c WHERE c.parent_id = s.id) child_count,
                  (SELECT MAX(m.time_updated) FROM message m WHERE m.session_id = s.id) last_at
           FROM session s
           WHERE s.parent_id IS NULL
           ORDER BY s.time_updated DESC
           LIMIT ?`
        )
        .all(limit) as Array<RawSessionRow & { last_at: number | null }>
    )

    let modelStmt: Database.Statement | null = null
    if (this.schema.capabilities.modelUsage) {
      // Prepared only after the capability check: a missing optional table
      // must never make the session list fail.
      const variant = this.has('model_usage', 'variant') ? 'variant' : 'NULL variant'
      modelStmt = db.prepare(
        `SELECT provider_id, model_id, ${variant} FROM model_usage WHERE session_id = ? ORDER BY started_at DESC LIMIT 1`
      )
    }
    return rows.map((r) => {
      let model: ModelRef | null = null
      if (modelStmt) {
        const m = retry(() => modelStmt!.get(r.id)) as
          | { provider_id: string; model_id: string; variant: string | null }
          | undefined
        if (m && m.model_id) model = { providerId: m.provider_id, modelId: m.model_id, variant: m.variant || undefined }
      }
      return {
        id: r.id,
        title: r.title || '',
        titleIsDefault: (r.title_source || 'default') === 'default',
        directory: r.directory || '',
        projectId: r.project_id || '',
        parentId: r.parent_id,
        taskType: r.task_type || 'interactive',
        version: r.version || '',
        createdAt: r.time_created,
        updatedAt: r.time_updated,
        archived: r.time_archived !== null && r.time_archived !== undefined,
        lastMessageAt: r.last_at ?? null,
        childSessionCount: r.child_count ?? 0,
        model
      }
    })
  }

  getSession(sessionId: string): ZSessionRow | null {
    const db = this.requireDb()
    const projectId = this.sessionColumn('project_id', "''")
    const titleSource = this.sessionColumn('title_source', "''")
    const taskType = this.sessionColumn('task_type', "'interactive'")
    const version = this.sessionColumn('version', "''")
    const archived = this.sessionColumn('time_archived', 'NULL')
    const r = retry(() =>
      db
        .prepare(
          `SELECT s.id, s.parent_id, ${projectId} project_id, s.directory, s.title,
                  ${titleSource} title_source, ${taskType} task_type, ${version} version,
                  s.time_created, s.time_updated, ${archived} time_archived,
                  (SELECT COUNT(*) FROM session c WHERE c.parent_id = s.id) child_count
           FROM session s WHERE s.id = ?`
        )
        .get(sessionId)
    ) as RawSessionRow | undefined
    if (!r) return null
    return {
      id: r.id,
      parentId: r.parent_id,
      projectId: r.project_id || '',
      directory: r.directory || '',
      title: r.title || '',
      titleSource: r.title_source || '',
      taskType: r.task_type || 'interactive',
      version: r.version || '',
      createdAt: r.time_created,
      updatedAt: r.time_updated,
      archived: r.time_archived !== null && r.time_archived !== undefined,
      childCount: r.child_count ?? 0
    }
  }

  latestModel(sessionId: string): ModelRef | null {
    if (!this.schema.capabilities.modelUsage) return null
    const db = this.requireDb()
    const variant = this.has('model_usage', 'variant') ? 'variant' : 'NULL variant'
    const m = retry(() =>
      db
        .prepare(
          `SELECT provider_id, model_id, ${variant} FROM model_usage WHERE session_id = ? ORDER BY started_at DESC LIMIT 1`
        )
        .get(sessionId)
    ) as { provider_id: string; model_id: string; variant: string | null } | undefined
    if (!m || !m.model_id) return null
    return { providerId: m.provider_id, modelId: m.model_id, variant: m.variant || undefined }
  }

  readMessageById(sessionId: string, messageId: string): ZMessageRow | null {
    const db = this.requireDb()
    const seq = this.has('message', 'sequence') ? 'sequence' : 'NULL sequence'
    const r = retry(() =>
      db
        .prepare(
          `SELECT id, time_created, time_updated, ${seq}, data FROM message WHERE session_id = ? AND id = ?`
        )
        .get(sessionId, messageId)
    ) as RawMessageRow | undefined
    return r ? this.parseMessage(r) : null
  }

  sync(sessionId: string, watermarks: SyncWatermarks): ZSyncData {
    const db = this.requireDb()
    if (!this.schema.compatible) throw new RelayError('schema-incompatible', this.schema.detail)
    const caps = this.schema.capabilities
    const session = this.getSession(sessionId)

    const msgSince = watermarks.message > 0 ? Math.max(0, watermarks.message - OVERLAP_MS) : 0
    const partSince = watermarks.part > 0 ? Math.max(0, watermarks.part - OVERLAP_MS) : 0
    const toolSince = watermarks.tool > 0 ? Math.max(0, watermarks.tool - OVERLAP_MS) : 0
    const usageSince = watermarks.usage > 0 ? Math.max(0, watermarks.usage - OVERLAP_MS) : 0
    const turnSince = watermarks.turn > 0 ? Math.max(0, watermarks.turn - OVERLAP_MS) : 0
    const msgSeqSince = watermarks.messageSequence > 0 ? Math.max(0, watermarks.messageSequence - 2) : 0
    const hasMessageSequence = this.has('message', 'sequence')

    const msgSeq = hasMessageSequence ? 'sequence' : 'NULL sequence'
    const partSeq = this.has('part', 'sequence') ? 'p.sequence' : 'NULL sequence'

    let msgWhere = 'session_id = ?'
    const msgArgs: unknown[] = [sessionId]
    if (msgSince) {
      msgArgs.push(msgSince)
      msgWhere += ' AND (time_updated > ?'
      if (hasMessageSequence && msgSeqSince) {
        // Clock-skew safety: a brand-new row can have an older timestamp than
        // the time watermark. Its session-local sequence is still larger.
        msgWhere += ' OR sequence > ?'
        msgArgs.push(msgSeqSince)
      }
      if (caps.json) {
        msgWhere += " OR (json_extract(data,'$.role') = 'assistant' AND json_extract(data,'$.time.completed') IS NULL)"
      }
      msgWhere += ')'
    }
    const msgRows = retry(() =>
      db
        .prepare(
          `SELECT id, time_created, time_updated, ${msgSeq}, data FROM message
           WHERE ${msgWhere} ORDER BY time_updated ASC`
        )
        .all(...msgArgs) as RawMessageRow[]
    )

    let partWhere = 'p.session_id = ?'
    const partArgs: unknown[] = [sessionId]
    if (partSince) {
      partArgs.push(partSince)
      partWhere += ' AND (p.time_updated > ?'
      if (hasMessageSequence && msgSeqSince) {
        partWhere +=
          ' OR p.message_id IN (SELECT id FROM message WHERE session_id = ? AND sequence > ?)'
        partArgs.push(sessionId, msgSeqSince)
      }
      if (caps.json) {
        partWhere +=
          " OR (json_extract(m.data,'$.role') = 'assistant' AND json_extract(m.data,'$.time.completed') IS NULL)" +
          " OR json_extract(p.data,'$.state.status') IN ('running','pending')"
      }
      partWhere += ')'
    }
    const partRows = retry(() =>
      db
        .prepare(
          `SELECT p.id, p.message_id, p.time_created, p.time_updated, ${partSeq}, p.data
           FROM part p JOIN message m ON m.id = p.message_id
           WHERE ${partWhere} ORDER BY p.time_updated ASC`
        )
        .all(...partArgs) as RawPartRow[]
    )

    const tools: ToolMetaRow[] = caps.toolUsage
      ? (retry(() =>
          db
            .prepare(
              `SELECT id, tool_call_id, tool_name, status, started_at, completed_at, duration_ms, exit_code,
                      read_only, destructive, approval_status, output_bytes, truncated, error_message
               FROM tool_usage WHERE session_id = ?
               ${toolSince ? "AND (COALESCE(completed_at, started_at) > ? OR status = 'running' OR completed_at IS NULL)" : ''}`
            )
            .all(...(toolSince ? [sessionId, toolSince] : [sessionId]))
        ) as Array<Record<string, unknown>>).map((r) => ({
          id: String(r.id),
          callId: String(r.tool_call_id),
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
        }))
      : []

    const turnCols = this.has('turn_usage', 'user_message_id')
      ? `COALESCE(user_message_id,'') user_message_id, COALESCE(tool_call_count,0) tool_call_count,
         COALESCE(tool_error_count,0) tool_error_count, COALESCE(input_tokens,0) input_tokens,
         COALESCE(output_tokens,0) output_tokens, COALESCE(reasoning_tokens,0) reasoning_tokens,
         ${this.has('turn_usage', 'context_exceeded') ? 'COALESCE(context_exceeded,0)' : '0'} context_exceeded,
         ${this.has('turn_usage', 'cancelled_by_user') ? 'COALESCE(cancelled_by_user,0)' : '0'} cancelled_by_user,
         ${this.has('turn_usage', 'error_type') ? 'error_type' : 'NULL error_type'}`
      : `'' user_message_id, 0 tool_call_count, 0 tool_error_count, 0 input_tokens, 0 output_tokens, 0 reasoning_tokens,
         0 context_exceeded, 0 cancelled_by_user, NULL error_type`
    const turns: TurnMetaRow[] = caps.turnUsage
      ? (retry(() =>
          db
            .prepare(
              `SELECT turn_id, status, started_at, completed_at, ${turnCols}
               FROM turn_usage WHERE session_id = ?
               ${turnSince ? "AND (COALESCE(completed_at, started_at) > ? OR status = 'running' OR completed_at IS NULL)" : ''}`
            )
            .all(...(turnSince ? [sessionId, turnSince] : [sessionId]))
        ) as Array<Record<string, unknown>>).map((r) => ({
          turnId: String(r.turn_id),
          status: String(r.status) as TurnMetaRow['status'],
          startedAt: Number(r.started_at),
          completedAt: r.completed_at === null ? null : Number(r.completed_at),
          userMessageId: r.user_message_id === null || r.user_message_id === '' ? null : String(r.user_message_id),
          toolCallCount: Number(r.tool_call_count),
          toolErrorCount: Number(r.tool_error_count),
          inputTokens: Number(r.input_tokens),
          outputTokens: Number(r.output_tokens),
          reasoningTokens: Number(r.reasoning_tokens),
          contextExceeded: Number(r.context_exceeded) === 1,
          cancelledByUser: Number(r.cancelled_by_user) === 1,
          errorType: r.error_type === null || r.error_type === undefined ? null : String(r.error_type)
        }))
      : []

    const variant = this.has('model_usage', 'variant') ? 'variant' : 'NULL variant'
    const cacheRead = this.has('model_usage', 'cache_read_input_tokens') ? 'cache_read_input_tokens' : '0 cache_read_input_tokens'
    const cacheWrite = this.has('model_usage', 'cache_creation_input_tokens')
      ? 'cache_creation_input_tokens'
      : '0 cache_creation_input_tokens'
    const modelError = this.has('model_usage', 'error_type') ? 'error_type' : 'NULL error_type'
    const models: ModelCallRow[] = caps.modelUsage
      ? (retry(() =>
          db
            .prepare(
              `SELECT id, assistant_message_id, provider_id, model_id, ${variant}, input_tokens, output_tokens,
                      reasoning_tokens, ${cacheRead}, ${cacheWrite}, started_at, status, ${modelError}
               FROM model_usage WHERE session_id = ?
               ${usageSince ? "AND (COALESCE(completed_at, started_at) > ? OR status = 'running' OR completed_at IS NULL)" : ''}`
            )
            .all(...(usageSince ? [sessionId, usageSince] : [sessionId]))
        ) as Array<Record<string, unknown>>).map((r) => ({
          id: String(r.id),
          messageId: r.assistant_message_id === null ? null : String(r.assistant_message_id),
          providerId: String(r.provider_id),
          modelId: String(r.model_id),
          variant: r.variant === null ? null : String(r.variant),
          inputTokens: Number(r.input_tokens),
          outputTokens: Number(r.output_tokens),
          reasoningTokens: Number(r.reasoning_tokens),
          cacheRead: Number(r.cache_read_input_tokens),
          cacheWrite: Number(r.cache_creation_input_tokens),
          startedAt: Number(r.started_at),
          status: String(r.status),
          errorType: r.error_type === null || r.error_type === undefined ? null : String(r.error_type)
        }))
      : []

    const todos: TodoItem[] = caps.todo
      ? (retry(() =>
          db
            .prepare(
              `SELECT content, status, priority, position, time_updated
               FROM todo WHERE session_id = ? ORDER BY position ASC`
            )
            .all(sessionId)
        ) as Array<Record<string, unknown>>).map((r) => ({
          content: String(r.content),
          status: String(r.status),
          priority: String(r.priority),
          position: Number(r.position),
          updatedAt: Number(r.time_updated)
        }))
      : []

    return {
      session,
      messages: msgRows.map((r) => this.parseMessage(r)),
      parts: partRows.map((r) => this.parsePart(r)),
      tools,
      turns,
      models,
      todos,
      watermarks: this.readWatermarks(sessionId),
      capabilities: caps
    }
  }

  private readWatermarks(sessionId: string): SyncWatermarks {
    const db = this.requireDb()
    const caps = this.schema.capabilities
    const one = (sql: string): number => {
      try {
        const r = retry(() => db.prepare(sql).get(sessionId)) as { v: number | null } | undefined
        return num(r?.v)
      } catch {
        return 0
      }
    }
    return {
      message: one('SELECT MAX(time_updated) v FROM message WHERE session_id = ?'),
      part: one('SELECT MAX(time_updated) v FROM part WHERE session_id = ?'),
      messageSequence: this.has('message', 'sequence')
        ? one('SELECT MAX(sequence) v FROM message WHERE session_id = ?')
        : 0,
      tool: caps.toolUsage
        ? one('SELECT MAX(COALESCE(completed_at, started_at)) v FROM tool_usage WHERE session_id = ?')
        : 0,
      usage: caps.modelUsage
        ? one('SELECT MAX(COALESCE(completed_at, started_at)) v FROM model_usage WHERE session_id = ?')
        : 0,
      turn: caps.turnUsage
        ? one('SELECT MAX(COALESCE(completed_at, started_at)) v FROM turn_usage WHERE session_id = ?')
        : 0
    }
  }

  private parseMessage(r: RawMessageRow): ZMessageRow {
    const d = json<Record<string, unknown>>(r.data) || {}
    const semantics = (d.semantics as Record<string, unknown>) || {}
    const time = (d.time as Record<string, unknown>) || {}
    const modelSel = (d.modelSelection as Record<string, unknown>) || {}
    const model = (d.model as Record<string, unknown>) || {}
    const meta: MessageMetaRow = {
      messageId: r.id,
      role: str(d.role) || 'unknown',
      parentId: str(d.parentID) || null,
      finish: d.finish === null || d.finish === undefined ? null : String(d.finish),
      modelId: str(d.modelId) || str(model.modelID) || str(modelSel.modelId) || null,
      providerId: str(d.providerId) || str(model.providerID) || str(modelSel.providerId) || null,
      variant: str(d.variant) || str((modelSel.options as Record<string, unknown>)?.reasoningLevel) || null,
      origin: str(semantics.origin) || null,
      visibility: str(d.visibility) || str((d.metadata as Record<string, unknown>)?.visibility) || null,
      synthetic: d.synthetic === true,
      createdAt: r.time_created || num(time.created),
      updatedAt: r.time_updated,
      completedAt: time.completed === undefined || time.completed === null ? null : num(time.completed)
    }
    return {
      id: r.id,
      createdAt: r.time_created,
      updatedAt: r.time_updated,
      sequence: r.sequence ?? 0,
      meta
    }
  }

  private parsePart(r: RawPartRow): ZPartRow {
    return {
      id: r.id,
      messageId: r.message_id,
      createdAt: r.time_created,
      updatedAt: r.time_updated,
      sequence: r.sequence ?? 0,
      data: json<Record<string, unknown>>(r.data) || {}
    }
  }
}

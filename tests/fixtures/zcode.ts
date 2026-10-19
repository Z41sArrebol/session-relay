import Database from 'better-sqlite3'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'

export interface Fixture {
  root: string
  dbPath: string
  projectRoot: string
  storePath: string
  sessionA: string
  sessionB: string
  cleanup: () => void
}

const SCHEMA = `
CREATE TABLE session (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL DEFAULT '',
  workspace_id TEXT,
  parent_id TEXT,
  slug TEXT NOT NULL DEFAULT '',
  directory TEXT NOT NULL,
  path TEXT,
  title TEXT NOT NULL,
  version TEXT NOT NULL DEFAULT 'test',
  share_url TEXT,
  summary_additions INTEGER,
  summary_deletions INTEGER,
  summary_files INTEGER,
  summary_diffs TEXT,
  revert TEXT,
  permission TEXT,
  time_created INTEGER NOT NULL,
  time_updated INTEGER NOT NULL,
  time_compacting INTEGER,
  time_archived INTEGER,
  task_type TEXT NOT NULL DEFAULT 'interactive',
  title_source TEXT NOT NULL DEFAULT 'first_input',
  title_message_id TEXT,
  time_title_updated INTEGER,
  trace_id TEXT
);
CREATE TABLE message (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  time_created INTEGER NOT NULL,
  time_updated INTEGER NOT NULL,
  data TEXT NOT NULL,
  sequence INTEGER
);
CREATE TABLE part (
  id TEXT PRIMARY KEY,
  message_id TEXT NOT NULL,
  session_id TEXT NOT NULL,
  time_created INTEGER NOT NULL,
  time_updated INTEGER NOT NULL,
  data TEXT NOT NULL,
  sequence INTEGER
);
CREATE TABLE tool_usage (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  turn_id TEXT,
  trace_id TEXT,
  tool_call_id TEXT NOT NULL,
  tool_name TEXT NOT NULL,
  side_effect_scope TEXT,
  read_only INTEGER,
  destructive INTEGER,
  approval_status TEXT,
  status TEXT NOT NULL,
  started_at INTEGER NOT NULL,
  first_output_at INTEGER,
  completed_at INTEGER,
  duration_ms INTEGER,
  time_to_first_output_ms INTEGER,
  exit_code INTEGER,
  output_bytes INTEGER NOT NULL DEFAULT 0,
  stdout_bytes INTEGER NOT NULL DEFAULT 0,
  stderr_bytes INTEGER NOT NULL DEFAULT 0,
  truncated INTEGER NOT NULL DEFAULT 0,
  retry_count INTEGER NOT NULL DEFAULT 0,
  retryable INTEGER NOT NULL DEFAULT 0,
  cancelled_by_user INTEGER NOT NULL DEFAULT 0,
  error_type TEXT,
  error_code TEXT,
  error_message TEXT
);
CREATE TABLE turn_usage (
  session_id TEXT NOT NULL,
  turn_id TEXT NOT NULL,
  trace_id TEXT,
  user_message_id TEXT,
  status TEXT NOT NULL,
  started_at INTEGER NOT NULL,
  first_model_start_at INTEGER,
  first_token_at INTEGER,
  completed_at INTEGER,
  duration_ms INTEGER,
  time_to_first_token_ms INTEGER,
  model_request_count INTEGER NOT NULL DEFAULT 0,
  model_retry_count INTEGER NOT NULL DEFAULT 0,
  tool_call_count INTEGER NOT NULL DEFAULT 0,
  tool_error_count INTEGER NOT NULL DEFAULT 0,
  input_tokens INTEGER NOT NULL DEFAULT 0,
  output_tokens INTEGER NOT NULL DEFAULT 0,
  reasoning_tokens INTEGER NOT NULL DEFAULT 0,
  cache_creation_input_tokens INTEGER NOT NULL DEFAULT 0,
  cache_read_input_tokens INTEGER NOT NULL DEFAULT 0,
  computed_total_tokens INTEGER NOT NULL DEFAULT 0,
  retryable INTEGER NOT NULL DEFAULT 0,
  cancelled_by_user INTEGER NOT NULL DEFAULT 0,
  context_exceeded INTEGER NOT NULL DEFAULT 0,
  error_type TEXT,
  error_code TEXT,
  error_message TEXT,
  PRIMARY KEY (session_id, turn_id)
);
CREATE TABLE model_usage (
  id TEXT PRIMARY KEY,
  logical_request_id TEXT NOT NULL,
  attempt_index INTEGER NOT NULL DEFAULT 0,
  session_id TEXT NOT NULL,
  turn_id TEXT,
  trace_id TEXT,
  span_id TEXT,
  assistant_message_id TEXT,
  parent_user_message_id TEXT,
  query_source TEXT NOT NULL DEFAULT 'test',
  provider_id TEXT NOT NULL,
  model_id TEXT NOT NULL,
  variant TEXT,
  agent TEXT,
  mode TEXT,
  task_type TEXT,
  status TEXT NOT NULL,
  started_at INTEGER NOT NULL,
  first_token_at INTEGER,
  completed_at INTEGER,
  duration_ms INTEGER,
  time_to_first_token_ms INTEGER,
  finish_reason TEXT,
  tool_call_count INTEGER NOT NULL DEFAULT 0,
  input_tokens INTEGER NOT NULL DEFAULT 0,
  output_tokens INTEGER NOT NULL DEFAULT 0,
  reasoning_tokens INTEGER NOT NULL DEFAULT 0,
  cache_creation_input_tokens INTEGER NOT NULL DEFAULT 0,
  cache_read_input_tokens INTEGER NOT NULL DEFAULT 0,
  provider_total_tokens INTEGER,
  computed_total_tokens INTEGER NOT NULL DEFAULT 0,
  retry_count INTEGER NOT NULL DEFAULT 0,
  retryable INTEGER NOT NULL DEFAULT 0,
  cancelled_by_user INTEGER NOT NULL DEFAULT 0,
  context_exceeded INTEGER NOT NULL DEFAULT 0,
  error_type TEXT,
  error_code TEXT,
  error_message TEXT,
  raw_usage_json TEXT,
  provider_metadata_json TEXT
);
CREATE TABLE todo (
  session_id TEXT NOT NULL,
  content TEXT NOT NULL,
  status TEXT NOT NULL,
  priority TEXT NOT NULL,
  position INTEGER NOT NULL,
  time_created INTEGER NOT NULL,
  time_updated INTEGER NOT NULL,
  PRIMARY KEY (session_id, position)
);
`

export function createZcodeFixture(options: { recovery?: boolean } = {}): Fixture {
  const root = mkdtempSync(path.join(os.tmpdir(), 'session-relay-test-'))
  const dbPath = path.join(root, 'db.sqlite')
  const projectRoot = path.join(root, 'project')
  const storePath = path.join(root, 'relay.sqlite')
  mkdirSync(projectRoot, { recursive: true })
  initGit(projectRoot)

  const db = new Database(dbPath)
  db.exec(SCHEMA)
  const now = Date.now() - 120_000
  const sessionA = 'sess_test_a_0001'
  const sessionB = 'sess_test_b_0002'
  insertSession(db, {
    id: sessionA,
    title: '测试会话 A',
    directory: projectRoot,
    createdAt: now,
    updatedAt: now + 5000,
    titleSource: 'generated'
  })
  insertSession(db, {
    id: sessionB,
    title: '测试会话 B',
    directory: projectRoot,
    createdAt: now,
    updatedAt: now + 3000,
    titleSource: 'first_input'
  })

  const userA = 'msg_user_a'
  const asstA = 'msg_asst_a'
  const finalA = 'msg_final_a'
  insertUserMessage(db, sessionA, userA, now + 100, '实现登录页并跑测试。')
  insertAssistantMessage(db, sessionA, asstA, userA, now + 200, now + 900, 'tool-calls', 'tool-calls')
  insertToolPart(db, sessionA, asstA, 'part_tool_a', now + 300, {
    callID: 'call_test_a',
    tool: 'Bash',
    state: {
      status: 'completed',
      input: { command: 'npm test' },
      output: 'PASS login.test.ts (3 tests)',
      time: { start: now + 300, end: now + 900 }
    }
  })
  insertTextPart(db, sessionA, asstA, 'part_text_a', now + 280, '先实现表单，再补测试。')
  insertReasoningPart(db, sessionA, asstA, 'part_reason_a', now + 250, 'INTERNAL_REASONING_SHOULD_NOT_BE_COLLECTED')
  insertAssistantMessage(db, sessionA, finalA, userA, now + 1000, now + 1600, 'stop', 'stop')
  insertTextPart(db, sessionA, finalA, 'part_text_final', now + 1100, '登录页已完成，测试通过。')
  // model-only injected user context must not appear as a user requirement
  insertInjectedMessage(db, sessionA, 'msg_injected_a', now + 150, 'SYSTEM_INJECTION_SHOULD_NOT_APPEAR')

  insertToolUsage(db, {
    id: 'usage_tool_a',
    sessionId: sessionA,
    callId: 'call_test_a',
    toolName: 'Bash',
    status: 'completed',
    startedAt: now + 300,
    completedAt: now + 900,
    durationMs: 600,
    exitCode: 0,
    readOnly: false,
    destructive: false,
    outputBytes: 27
  })
  insertTurnUsage(db, {
    sessionId: sessionA,
    turnId: 'turn_a',
    userMessageId: userA,
    status: 'completed',
    startedAt: now + 100,
    completedAt: now + 1600,
    inputTokens: 1200,
    outputTokens: 80,
    toolCallCount: 1
  })
  insertModelUsage(db, {
    id: 'usage_model_a',
    sessionId: sessionA,
    messageId: asstA,
    providerId: 'magpie',
    modelId: 'test/model',
    startedAt: now + 200,
    completedAt: now + 900,
    inputTokens: 1000,
    outputTokens: 60,
    cacheRead: 800
  })
  insertModelUsage(db, {
    id: 'usage_model_a2',
    sessionId: sessionA,
    messageId: finalA,
    providerId: 'magpie',
    modelId: 'test/model',
    startedAt: now + 1000,
    completedAt: now + 1600,
    inputTokens: 200,
    outputTokens: 20,
    cacheRead: 100
  })

  const userB = 'msg_user_b'
  insertUserMessage(db, sessionB, userB, now + 100, 'B 会话的独立要求。')
  insertAssistantMessage(db, sessionB, 'msg_asst_b', userB, now + 200, now + 500, 'stop', 'stop')
  insertTextPart(db, sessionB, 'msg_asst_b', 'part_text_b', now + 300, 'B 会话的回复。')

  if (options.recovery) {
    insertUserMessage(db, sessionA, 'msg_user_a2', now + 1700, '补充：只验收登录流程，不要改样式。')
    insertTodo(db, sessionA, 0, '实现登录表单', 'completed', 'high', now + 100)
    insertTodo(db, sessionA, 1, '补登录测试', 'in_progress', 'high', now + 1200)
    insertTodo(db, sessionA, 2, '更新 README', 'pending', 'high', now + 1200)
    insertTodo(db, sessionA, 3, '清理调试日志', 'pending', 'medium', now + 1200)
    insertToolPart(db, sessionA, 'msg_asst_a', 'part_build_fail', now + 1750, {
      callID: 'call_build_1',
      tool: 'Bash',
      state: {
        status: 'error',
        input: { command: 'npm run build' },
        error: 'Type error in login.ts',
        time: { start: now + 1750, end: now + 1800 }
      }
    })
    insertToolUsage(db, {
      id: 'usage_build_1',
      sessionId: sessionA,
      callId: 'call_build_1',
      toolName: 'Bash',
      status: 'error',
      startedAt: now + 1750,
      completedAt: now + 1800,
      durationMs: 50,
      exitCode: 1,
      readOnly: false,
      destructive: false,
      outputBytes: 0
    })
    insertToolPart(db, sessionA, 'msg_asst_a', 'part_build_ok', now + 1850, {
      callID: 'call_build_2',
      tool: 'Bash',
      state: {
        status: 'completed',
        input: { command: 'npm run build' },
        output: 'build ok',
        time: { start: now + 1850, end: now + 1900 }
      }
    })
    insertToolUsage(db, {
      id: 'usage_build_2',
      sessionId: sessionA,
      callId: 'call_build_2',
      toolName: 'Bash',
      status: 'completed',
      startedAt: now + 1850,
      completedAt: now + 1900,
      durationMs: 50,
      exitCode: 0,
      readOnly: false,
      destructive: false,
      outputBytes: 8
    })
    insertModelUsage(db, {
      id: 'usage_model_err',
      sessionId: sessionA,
      messageId: asstA,
      providerId: 'magpie',
      modelId: 'test/model',
      startedAt: now + 1950,
      completedAt: now + 1960,
      inputTokens: 0,
      outputTokens: 0,
      cacheRead: 0,
      status: 'error',
      errorType: 'server_error'
    })
    db.prepare('UPDATE turn_usage SET context_exceeded = 1 WHERE session_id = ? AND turn_id = ?').run(sessionA, 'turn_a')
  }

  writeFileSync(path.join(projectRoot, 'app.ts'), 'export const version = 1\nexport const name = "fixture"\n', 'utf8')
  writeFileSync(path.join(projectRoot, 'README.md'), '# Fixture\n', 'utf8')
  git(projectRoot, ['add', '.'])
  git(projectRoot, ['-c', 'user.email=test@example.com', '-c', 'user.name=Test', 'commit', '-m', 'baseline'])
  // pre-existing modification at attach time
  writeFileSync(path.join(projectRoot, 'README.md'), '# Fixture\n\npre-existing change\n', 'utf8')
  // untracked file
  writeFileSync(path.join(projectRoot, 'notes.txt'), 'handoff notes\n', 'utf8')
  // a file that will change during observation
  writeFileSync(path.join(projectRoot, 'later.txt'), 'before\n', 'utf8')
  db.close()

  return {
    root,
    dbPath,
    projectRoot,
    storePath,
    sessionA,
    sessionB,
    cleanup: () => {
      try {
        rmSync(root, { recursive: true, force: true })
      } catch {
        // windows may keep a handle briefly
      }
    }
  }
}

function insertSession(
  db: Database.Database,
  input: { id: string; title: string; directory: string; createdAt: number; updatedAt: number; titleSource: string }
): void {
  db.prepare(
    `INSERT INTO session (id, project_id, parent_id, slug, directory, title, version, time_created, time_updated, task_type, title_source)
     VALUES (?, 'proj', NULL, ?, ?, ?, 'test', ?, ?, 'interactive', ?)`
  ).run(input.id, input.id, input.directory, input.title, input.createdAt, input.updatedAt, input.titleSource)
}

function insertMessage(
  db: Database.Database,
  sessionId: string,
  id: string,
  createdAt: number,
  updatedAt: number,
  sequence: number,
  data: Record<string, unknown>
): void {
  db.prepare('INSERT INTO message (id, session_id, time_created, time_updated, data, sequence) VALUES (?, ?, ?, ?, ?, ?)').run(
    id,
    sessionId,
    createdAt,
    updatedAt,
    JSON.stringify(data),
    sequence
  )
}

function nextSequence(db: Database.Database, sessionId: string): number {
  const row = db.prepare('SELECT COALESCE(MAX(sequence), 0) + 1 n FROM message WHERE session_id = ?').get(sessionId) as {
    n: number
  }
  return row.n
}

function insertUserMessage(db: Database.Database, sessionId: string, id: string, time: number, text: string): void {
  insertMessage(db, sessionId, id, time, time, nextSequence(db, sessionId), {
    role: 'user',
    time: { created: time },
    semantics: { origin: 'real_user', kind: 'user_prompt', uiVisibility: 'visible' },
    metadata: { inputIntent: { kind: 'sendText' } }
  })
  insertTextPart(db, sessionId, id, `${id}_part`, time + 1, text)
}

function insertInjectedMessage(db: Database.Database, sessionId: string, id: string, time: number, text: string): void {
  insertMessage(db, sessionId, id, time, time, nextSequence(db, sessionId), {
    role: 'user',
    time: { created: time },
    semantics: { origin: 'agent_runtime', kind: 'system_reminder', uiVisibility: 'hidden' },
    metadata: { visibility: 'model-only', source: 'agent_listing_delta' },
    visibility: 'model-only',
    synthetic: true
  })
  insertTextPart(db, sessionId, id, `${id}_part`, time + 1, text)
}

function insertAssistantMessage(
  db: Database.Database,
  sessionId: string,
  id: string,
  parentId: string,
  createdAt: number,
  completedAt: number,
  finish: string,
  sequenceKind: string
): void {
  insertMessage(db, sessionId, id, createdAt, completedAt, finish === 'stop' ? 5 : 3, {
    role: 'assistant',
    time: { created: createdAt, completed: completedAt },
    parentID: parentId,
    modelId: 'test/model',
    providerId: 'magpie',
    finish,
    semantics: { origin: 'agent_runtime', kind: sequenceKind, uiVisibility: 'visible' },
    tokens: { input: 100, output: 10, reasoning: 0, cache: { read: 0, write: 0 } }
  })
}

function insertTextPart(db: Database.Database, sessionId: string, messageId: string, id: string, time: number, text: string): void {
  db.prepare('INSERT INTO part (id, message_id, session_id, time_created, time_updated, data, sequence) VALUES (?, ?, ?, ?, ?, ?, 0)').run(
    id,
    messageId,
    sessionId,
    time,
    time,
    JSON.stringify({ type: 'text', text, time: { start: time, end: time } })
  )
}

function insertReasoningPart(db: Database.Database, sessionId: string, messageId: string, id: string, time: number, text: string): void {
  db.prepare('INSERT INTO part (id, message_id, session_id, time_created, time_updated, data, sequence) VALUES (?, ?, ?, ?, ?, ?, 1)').run(
    id,
    messageId,
    sessionId,
    time,
    time,
    JSON.stringify({ type: 'reasoning', text, time: { start: time, end: time } })
  )
}

function insertToolPart(
  db: Database.Database,
  sessionId: string,
  messageId: string,
  id: string,
  time: number,
  data: Record<string, unknown>
): void {
  db.prepare('INSERT INTO part (id, message_id, session_id, time_created, time_updated, data, sequence) VALUES (?, ?, ?, ?, ?, ?, 2)').run(
    id,
    messageId,
    sessionId,
    time,
    time,
    JSON.stringify({ type: 'tool', ...data })
  )
}

function insertToolUsage(
  db: Database.Database,
  input: {
    id: string
    sessionId: string
    callId: string
    toolName: string
    status: string
    startedAt: number
    completedAt: number | null
    durationMs: number | null
    exitCode: number | null
    readOnly: boolean
    destructive: boolean
    outputBytes: number
  }
): void {
  db.prepare(
    `INSERT INTO tool_usage (id, session_id, turn_id, tool_call_id, tool_name, read_only, destructive, approval_status, status, started_at, completed_at, duration_ms, exit_code, output_bytes, truncated)
     VALUES (?, ?, 'turn_a', ?, ?, ?, ?, 'none', ?, ?, ?, ?, ?, ?, 0)`
  ).run(
    input.id,
    input.sessionId,
    input.callId,
    input.toolName,
    input.readOnly ? 1 : 0,
    input.destructive ? 1 : 0,
    input.status,
    input.startedAt,
    input.completedAt,
    input.durationMs,
    input.exitCode,
    input.outputBytes
  )
}

function insertTurnUsage(
  db: Database.Database,
  input: {
    sessionId: string
    turnId: string
    userMessageId: string
    status: string
    startedAt: number
    completedAt: number | null
    inputTokens: number
    outputTokens: number
    toolCallCount: number
  }
): void {
  db.prepare(
    `INSERT INTO turn_usage (session_id, turn_id, user_message_id, status, started_at, completed_at, input_tokens, output_tokens, tool_call_count)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    input.sessionId,
    input.turnId,
    input.userMessageId,
    input.status,
    input.startedAt,
    input.completedAt,
    input.inputTokens,
    input.outputTokens,
    input.toolCallCount
  )
}

function insertModelUsage(
  db: Database.Database,
  input: {
    id: string
    sessionId: string
    messageId: string
    providerId: string
    modelId: string
    startedAt: number
    completedAt: number | null
    inputTokens: number
    outputTokens: number
    cacheRead: number
    status?: string
    errorType?: string | null
  }
): void {
  db.prepare(
    `INSERT INTO model_usage (id, logical_request_id, session_id, assistant_message_id, provider_id, model_id, status, started_at, completed_at, input_tokens, output_tokens, cache_read_input_tokens, error_type)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    input.id,
    input.id,
    input.sessionId,
    input.messageId,
    input.providerId,
    input.modelId,
    input.status || 'completed',
    input.startedAt,
    input.completedAt,
    input.inputTokens,
    input.outputTokens,
    input.cacheRead,
    input.errorType || null
  )
}

function insertTodo(
  db: Database.Database,
  sessionId: string,
  position: number,
  content: string,
  status: string,
  priority: string,
  time: number
): void {
  db.prepare(
    'INSERT INTO todo (session_id, content, status, priority, position, time_created, time_updated) VALUES (?, ?, ?, ?, ?, ?, ?)'
  ).run(sessionId, content, status, priority, position, time, time)
}

function initGit(dir: string): void {
  git(dir, ['init'])
  git(dir, ['config', 'user.email', 'test@example.com'])
  git(dir, ['config', 'user.name', 'Test'])
}

export function git(dir: string, args: string[]): string {
  return execFileSync('git', ['-C', dir, ...args], { encoding: 'utf8', windowsHide: true })
}

export function appendToolUsage(
  dbPath: string,
  input: { id: string; sessionId: string; callId: string; status: string; startedAt: number; completedAt: number | null }
): void {
  const db = new Database(dbPath)
  db.prepare(
    `INSERT INTO tool_usage (id, session_id, turn_id, tool_call_id, tool_name, status, started_at, completed_at, read_only, destructive, output_bytes, truncated)
     VALUES (?, ?, 'turn_a', ?, 'Bash', ?, ?, ?, 0, 0, 0, 0)`
  ).run(input.id, input.sessionId, input.callId, input.status, input.startedAt, input.completedAt)
  db.close()
}

export function appendRunningToolCall(
  dbPath: string,
  input: {
    sessionId: string
    messageId: string
    partId: string
    usageId: string
    callId: string
    startedAt: number
    command: string
  }
): void {
  const db = new Database(dbPath)
  db.prepare(
    'INSERT INTO part (id, message_id, session_id, time_created, time_updated, data, sequence) VALUES (?, ?, ?, ?, ?, ?, 3)'
  ).run(
    input.partId,
    input.messageId,
    input.sessionId,
    input.startedAt,
    input.startedAt,
    JSON.stringify({
      type: 'tool',
      callID: input.callId,
      tool: 'Bash',
      state: {
        status: 'running',
        input: { command: input.command },
        time: { start: input.startedAt }
      }
    })
  )
  db.prepare(
    `INSERT INTO tool_usage (id, session_id, turn_id, tool_call_id, tool_name, status, started_at, completed_at, read_only, destructive, output_bytes, truncated)
     VALUES (?, ?, 'turn_a', ?, 'Bash', 'running', ?, NULL, 0, 0, 0, 0)`
  ).run(input.usageId, input.sessionId, input.callId, input.startedAt)
  db.close()
}

export function completeRunningToolCall(
  dbPath: string,
  input: { partId: string; usageId: string; completedAt: number; output: string }
): void {
  const db = new Database(dbPath)
  const row = db.prepare('SELECT data FROM part WHERE id = ?').get(input.partId) as { data: string } | undefined
  if (!row) {
    db.close()
    throw new Error('tool part not found')
  }
  const data = JSON.parse(row.data) as Record<string, unknown>
  const state = (data.state as Record<string, unknown>) || {}
  state.status = 'completed'
  state.output = input.output
  state.time = { ...(state.time as Record<string, unknown>), end: input.completedAt }
  data.state = state
  db.prepare('UPDATE part SET data = ?, time_updated = ? WHERE id = ?').run(
    JSON.stringify(data),
    input.completedAt,
    input.partId
  )
  db.prepare('UPDATE tool_usage SET status = ?, completed_at = ? WHERE id = ?').run(
    'completed',
    input.completedAt,
    input.usageId
  )
  db.close()
}

export function updateToolUsage(dbPath: string, id: string, status: string, completedAt: number): void {
  const db = new Database(dbPath)
  db.prepare('UPDATE tool_usage SET status = ?, completed_at = ? WHERE id = ?').run(status, completedAt, id)
  db.close()
}

export function appendUserMessage(dbPath: string, sessionId: string, id: string, time: number, text: string): void {
  const db = new Database(dbPath)
  insertUserMessage(db, sessionId, id, time, text)
  db.close()
}

export function updatePartText(dbPath: string, partId: string, text: string, timeUpdated: number): void {
  const db = new Database(dbPath)
  const row = db.prepare('SELECT data FROM part WHERE id = ?').get(partId) as { data: string } | undefined
  if (!row) {
    db.close()
    throw new Error('part not found')
  }
  const data = JSON.parse(row.data) as Record<string, unknown>
  data.text = text
  db.prepare('UPDATE part SET data = ?, time_updated = ? WHERE id = ?').run(JSON.stringify(data), timeUpdated, partId)
  db.close()
}

export function appendCompletedModelUsage(
  dbPath: string,
  input: { id: string; sessionId: string; messageId: string; startedAt: number; completedAt: number }
): void {
  const db = new Database(dbPath)
  insertModelUsage(db, {
    id: input.id,
    sessionId: input.sessionId,
    messageId: input.messageId,
    providerId: 'magpie',
    modelId: 'test/model',
    startedAt: input.startedAt,
    completedAt: input.completedAt,
    inputTokens: 50,
    outputTokens: 5,
    cacheRead: 0
  })
  db.close()
}

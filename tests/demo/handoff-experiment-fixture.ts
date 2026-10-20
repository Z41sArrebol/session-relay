import Database from 'better-sqlite3'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

/**
 * Isolated handoff experiment fixture. The conversation and project are
 * synthetic; the session is stored in the real Z-Code schema so the whole
 * app pipeline (reader → observer → recovery brief → pack) runs unchanged.
 */

export interface ExperimentFixture {
  root: string
  dbPath: string
  projectRoot: string
  storePath: string
  sessionId: string
  cleanup: () => void
}

const SCHEMA = `
CREATE TABLE session (
  id TEXT PRIMARY KEY, project_id TEXT NOT NULL DEFAULT '', workspace_id TEXT, parent_id TEXT,
  slug TEXT NOT NULL DEFAULT '', directory TEXT NOT NULL, path TEXT, title TEXT NOT NULL,
  version TEXT NOT NULL DEFAULT 'exp', share_url TEXT, summary_additions INTEGER, summary_deletions INTEGER,
  summary_files INTEGER, summary_diffs TEXT, revert TEXT, permission TEXT,
  time_created INTEGER NOT NULL, time_updated INTEGER NOT NULL, time_compacting INTEGER, time_archived INTEGER,
  task_type TEXT NOT NULL DEFAULT 'interactive', title_source TEXT NOT NULL DEFAULT 'first_input',
  title_message_id TEXT, time_title_updated INTEGER, trace_id TEXT
);
CREATE TABLE message (id TEXT PRIMARY KEY, session_id TEXT NOT NULL, time_created INTEGER NOT NULL, time_updated INTEGER NOT NULL, data TEXT NOT NULL, sequence INTEGER);
CREATE TABLE part (id TEXT PRIMARY KEY, message_id TEXT NOT NULL, session_id TEXT NOT NULL, time_created INTEGER NOT NULL, time_updated INTEGER NOT NULL, data TEXT NOT NULL, sequence INTEGER);
CREATE TABLE tool_usage (
  id TEXT PRIMARY KEY, session_id TEXT NOT NULL, turn_id TEXT, trace_id TEXT, tool_call_id TEXT NOT NULL,
  tool_name TEXT NOT NULL, side_effect_scope TEXT, read_only INTEGER, destructive INTEGER, approval_status TEXT,
  status TEXT NOT NULL, started_at INTEGER NOT NULL, first_output_at INTEGER, completed_at INTEGER,
  duration_ms INTEGER, time_to_first_output_ms INTEGER, exit_code INTEGER, output_bytes INTEGER NOT NULL DEFAULT 0,
  stdout_bytes INTEGER NOT NULL DEFAULT 0, stderr_bytes INTEGER NOT NULL DEFAULT 0, truncated INTEGER NOT NULL DEFAULT 0,
  retry_count INTEGER NOT NULL DEFAULT 0, retryable INTEGER NOT NULL DEFAULT 0, cancelled_by_user INTEGER NOT NULL DEFAULT 0,
  error_type TEXT, error_code TEXT, error_message TEXT
);
CREATE TABLE turn_usage (
  session_id TEXT NOT NULL, turn_id TEXT NOT NULL, trace_id TEXT, user_message_id TEXT, status TEXT NOT NULL,
  started_at INTEGER NOT NULL, first_model_start_at INTEGER, first_token_at INTEGER, completed_at INTEGER,
  duration_ms INTEGER, time_to_first_token_ms INTEGER, model_request_count INTEGER NOT NULL DEFAULT 0,
  model_retry_count INTEGER NOT NULL DEFAULT 0, tool_call_count INTEGER NOT NULL DEFAULT 0,
  tool_error_count INTEGER NOT NULL DEFAULT 0, input_tokens INTEGER NOT NULL DEFAULT 0,
  output_tokens INTEGER NOT NULL DEFAULT 0, reasoning_tokens INTEGER NOT NULL DEFAULT 0,
  cache_creation_input_tokens INTEGER NOT NULL DEFAULT 0, cache_read_input_tokens INTEGER NOT NULL DEFAULT 0,
  computed_total_tokens INTEGER NOT NULL DEFAULT 0, retryable INTEGER NOT NULL DEFAULT 0,
  cancelled_by_user INTEGER NOT NULL DEFAULT 0, context_exceeded INTEGER NOT NULL DEFAULT 0,
  error_type TEXT, error_code TEXT, error_message TEXT, PRIMARY KEY (session_id, turn_id)
);
CREATE TABLE model_usage (
  id TEXT PRIMARY KEY, logical_request_id TEXT NOT NULL, attempt_index INTEGER NOT NULL DEFAULT 0,
  session_id TEXT NOT NULL, turn_id TEXT, trace_id TEXT, span_id TEXT, assistant_message_id TEXT,
  parent_user_message_id TEXT, query_source TEXT NOT NULL DEFAULT 'exp', provider_id TEXT NOT NULL,
  model_id TEXT NOT NULL, variant TEXT, agent TEXT, mode TEXT, task_type TEXT, status TEXT NOT NULL,
  started_at INTEGER NOT NULL, first_token_at INTEGER, completed_at INTEGER, duration_ms INTEGER,
  time_to_first_token_ms INTEGER, finish_reason TEXT, tool_call_count INTEGER NOT NULL DEFAULT 0,
  input_tokens INTEGER NOT NULL DEFAULT 0, output_tokens INTEGER NOT NULL DEFAULT 0, reasoning_tokens INTEGER NOT NULL DEFAULT 0,
  cache_creation_input_tokens INTEGER NOT NULL DEFAULT 0, cache_read_input_tokens INTEGER NOT NULL DEFAULT 0,
  provider_total_tokens INTEGER, computed_total_tokens INTEGER NOT NULL DEFAULT 0, retry_count INTEGER NOT NULL DEFAULT 0,
  retryable INTEGER NOT NULL DEFAULT 0, cancelled_by_user INTEGER NOT NULL DEFAULT 0, context_exceeded INTEGER NOT NULL DEFAULT 0,
  error_type TEXT, error_code TEXT, error_message TEXT, raw_usage_json TEXT, provider_metadata_json TEXT
);
CREATE TABLE todo (session_id TEXT NOT NULL, content TEXT NOT NULL, status TEXT NOT NULL, priority TEXT NOT NULL, position INTEGER NOT NULL, time_created INTEGER NOT NULL, time_updated INTEGER NOT NULL, PRIMARY KEY (session_id, position));
`

function msg(db: Database.Database, sessionId: string, id: string, time: number, seq: number, data: Record<string, unknown>): void {
  db.prepare('INSERT INTO message (id, session_id, time_created, time_updated, data, sequence) VALUES (?, ?, ?, ?, ?, ?)').run(
    id,
    sessionId,
    time,
    time,
    JSON.stringify(data),
    seq
  )
}

function userMsg(db: Database.Database, sessionId: string, id: string, time: number, seq: number, text: string): void {
  msg(db, sessionId, id, time, seq, {
    role: 'user',
    time: { created: time },
    semantics: { origin: 'real_user', kind: 'user_prompt', uiVisibility: 'visible' }
  })
  db.prepare('INSERT INTO part (id, message_id, session_id, time_created, time_updated, data, sequence) VALUES (?, ?, ?, ?, ?, ?, 0)').run(
    `${id}_p`,
    id,
    sessionId,
    time,
    time,
    JSON.stringify({ type: 'text', text })
  )
}

function assistantMsg(db: Database.Database, sessionId: string, id: string, parentId: string, time: number, seq: number, text: string, finish: string): void {
  msg(db, sessionId, id, time, seq, {
    role: 'assistant',
    time: { created: time, completed: time + 800 },
    parentID: parentId,
    modelId: 'exp/model',
    providerId: 'exp',
    finish,
    semantics: { origin: 'agent_runtime', kind: 'assistant_response', uiVisibility: 'visible' }
  })
  if (text) {
    db.prepare('INSERT INTO part (id, message_id, session_id, time_created, time_updated, data, sequence) VALUES (?, ?, ?, ?, ?, ?, 0)').run(
      `${id}_text`,
      id,
      sessionId,
      time,
      time,
      JSON.stringify({ type: 'text', text })
    )
  }
}

function toolPart(db: Database.Database, sessionId: string, messageId: string, id: string, time: number, tool: string, input: Record<string, unknown>, output: string | null, status: string): void {
  db.prepare('INSERT INTO part (id, message_id, session_id, time_created, time_updated, data, sequence) VALUES (?, ?, ?, ?, ?, ?, 1)').run(
    id,
    messageId,
    sessionId,
    time,
    time,
    JSON.stringify({ type: 'tool', callID: id, tool, state: { status, input, ...(output !== null ? { output } : {}), time: { start: time, end: time + 400 } } })
  )
}

function toolUsage(db: Database.Database, sessionId: string, callId: string, tool: string, status: string, startedAt: number, exitCode: number | null): void {
  db.prepare(
    `INSERT INTO tool_usage (id, session_id, turn_id, tool_call_id, tool_name, status, started_at, completed_at, duration_ms, exit_code, read_only, destructive, output_bytes, truncated)
     VALUES (?, ?, 'turn1', ?, ?, ?, ?, ?, 400, ?, 0, 0, 0, 0)`
  ).run(`usage_${callId}`, sessionId, callId, tool, status, startedAt, exitCode === null ? null : startedAt + 400, exitCode)
}

function todo(db: Database.Database, sessionId: string, position: number, content: string, status: string, priority: string, time: number): void {
  db.prepare('INSERT INTO todo (session_id, content, status, priority, position, time_created, time_updated) VALUES (?, ?, ?, ?, ?, ?, ?)').run(
    sessionId,
    content,
    status,
    priority,
    position,
    time,
    time
  )
}

export function createHandoffExperiment(): ExperimentFixture {
  const root = mkdtempSync(path.join(os.tmpdir(), 'relay-handoff-exp-'))
  const dbPath = path.join(root, 'db.sqlite')
  const projectRoot = path.join(root, 'project')
  const storePath = path.join(root, 'relay.sqlite')
  const sessionId = 'sess_handoff_exp_001'
  mkdirSync(projectRoot, { recursive: true })
  execFileSync('git', ['-C', projectRoot, 'init'], { windowsHide: true })
  execFileSync('git', ['-C', projectRoot, 'config', 'user.email', 'exp@test.local'], { windowsHide: true })
  execFileSync('git', ['-C', projectRoot, 'config', 'user.name', 'Experiment'], { windowsHide: true })

  // Initial project: half a login page, a test file, README.
  writeFileSync(path.join(projectRoot, 'package.json'), JSON.stringify({ name: 'exp-login', version: '0.1.0', private: true, scripts: { test: 'vitest run' } }, null, 2), 'utf8')
  writeFileSync(
    path.join(projectRoot, 'login.ts'),
    [
      'export interface LoginRequest { user: string; password: string }',
      'export interface LoginResult { ok: boolean; token?: string; error?: string }',
      '',
      '// TODO: the actual login logic is not written yet.',
      'export function login(req: LoginRequest): LoginResult {',
      '  void req',
      '  return { ok: false, error: "not implemented" }',
      '}',
      ''
    ].join('\n'),
    'utf8'
  )
  writeFileSync(
    path.join(projectRoot, 'login.test.ts'),
    [
      "import { describe, expect, it } from 'vitest'",
      "import { login } from './login'",
      '',
      "describe('login', () => {",
      "  it('returns a token for valid credentials', () => {",
      "    const r = login({ user: 'admin', password: 'admin123' })",
      "    expect(r.ok).toBe(true)",
      "    expect(r.token).toBeTruthy()",
      "  })",
      '',
      "  it('rejects empty credentials', () => {",
      "    const r = login({ user: '', password: '' })",
      "    expect(r.ok).toBe(false)",
      "  })",
      "})",
      ''
    ].join('\n'),
    'utf8'
  )
  writeFileSync(path.join(projectRoot, 'README.md'), '# exp-login\n\nTiny login fixture for the handoff experiment.\n', 'utf8')
  execFileSync('git', ['-C', projectRoot, 'add', '.'], { windowsHide: true })
  execFileSync('git', ['-C', projectRoot, 'commit', '-m', 'baseline: login skeleton'], { windowsHide: true })

  const db = new Database(dbPath)
  db.exec(SCHEMA)
  const now = Date.now() - 300_000
  db.prepare(
    `INSERT INTO session (id, project_id, parent_id, slug, directory, title, version, time_created, time_updated, task_type, title_source)
     VALUES (?, 'proj', NULL, ?, ?, ?, 'exp', ?, ?, 'interactive', 'first_input')`
  ).run(sessionId, sessionId, projectRoot, '完成登录页的最小实现', now, now + 60_000)

  const userA = 'msg_exp_user'
  const asstA = 'msg_exp_asst'
  userMsg(db, sessionId, userA, now + 1000, 1, '完成登录页的最小实现：login.ts 里 login() 现在返回 not implemented，login.test.ts 已写好两个用例（有效凭证返回 token、空凭证拒绝）。把 login() 实现到测试通过，不要改测试文件。')
  assistantMsg(db, sessionId, asstA, userA, now + 2000, 2, '先看测试要求，再实现 login。', 'tool-calls')

  // read login.ts and the test
  toolPart(db, sessionId, asstA, 'call_read_login', now + 2500, 'Read', { file_path: path.join(projectRoot, 'login.ts') }, '（login.ts 内容）', 'completed')
  toolUsage(db, sessionId, 'call_read_login', 'Read', 'completed', now + 2500, 0)
  toolPart(db, sessionId, asstA, 'call_read_test', now + 3000, 'Read', { file_path: path.join(projectRoot, 'login.test.ts') }, '（login.test.ts 内容）', 'completed')
  toolUsage(db, sessionId, 'call_read_test', 'Read', 'completed', now + 3000, 0)

  // a failed npm test, then session went quiet — the failure is unresolved.
  toolPart(db, sessionId, asstA, 'call_test_fail', now + 4000, 'Bash', { command: 'npm test' }, 'FAIL login.test.ts > returns a token\nAssertionError: expected false to be true', 'error')
  toolUsage(db, sessionId, 'call_test_fail', 'Bash', 'error', now + 4000, 1)

  todo(db, sessionId, 0, '阅读 login.ts 与 login.test.ts', 'completed', 'high', now + 1500)
  todo(db, sessionId, 1, '实现 login() 使测试通过', 'in_progress', 'high', now + 3500)
  todo(db, sessionId, 2, '不要修改 login.test.ts', 'pending', 'high', now + 3500)

  db.prepare(
    `INSERT INTO turn_usage (session_id, turn_id, user_message_id, status, started_at, completed_at, input_tokens, output_tokens, tool_call_count, context_exceeded)
     VALUES (?, 'turn1', ?, 'completed', ?, ?, 800, 60, 3, 0)`
  ).run(sessionId, userA, now + 1000, now + 5000)
  db.prepare(
    `INSERT INTO model_usage (id, logical_request_id, session_id, assistant_message_id, provider_id, model_id, status, started_at, completed_at, input_tokens, output_tokens)
     VALUES ('usage_m1', 'usage_m1', ?, ?, 'exp', 'exp/model', 'completed', ?, ?, 800, 60)`
  ).run(sessionId, asstA, now + 2000, now + 2800)
  db.close()

  return {
    root,
    dbPath,
    projectRoot,
    storePath,
    sessionId,
    cleanup: () => {
      // caller decides when to delete; leave temp dir for inspection on failure
    }
  }
}

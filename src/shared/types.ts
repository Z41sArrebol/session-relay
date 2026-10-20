/**
 * Types shared by main, preload and renderer.
 * Everything crossing IPC is plain JSON; no file handles or Node objects.
 */

export interface ModelRef {
  providerId: string
  modelId: string
  variant?: string
}

export interface SessionSummary {
  id: string
  title: string
  titleIsDefault: boolean
  directory: string
  projectId: string
  parentId: string | null
  taskType: string
  version: string
  createdAt: number
  updatedAt: number
  archived: boolean
  lastMessageAt: number | null
  childSessionCount: number
  model: ModelRef | null
}

export interface BaselineInfo {
  id: string
  capturedAt: number
  hasBaseline: boolean
  head: string | null
  gitRoot: string | null
  note: string
  reason?: string
}

export type LiveStateKind = 'running' | 'idle' | 'unknown' | 'error'

export interface LiveState {
  state: LiveStateKind
  label: string
  detail: string
  asOf: number
  runningTurns: number
  runningTools: number
  lastActivityAt: number | null
  latestTurnStatus?: string
}

export interface AttachedSession {
  sessionId: string
  title: string
  directory: string
  projectRoot: string
  attachedAt: number
  paused: boolean
  baseline: BaselineInfo
  live: LiveState
  lastSyncAt: number | null
  syncError: string | null
  eventCount: number
  model: ModelRef | null
  sourceDb: string
  selectedFiles: string[] | null
}

export interface TokenTotals {
  input: number
  output: number
  reasoning: number
  cacheRead: number
  cacheWrite: number
  calls: number
}

export type TimelineKind = 'user' | 'assistant' | 'tool' | 'system'

export interface TimelineItem {
  id: string
  sessionId: string
  kind: TimelineKind
  time: number
  messageId: string
  partId?: string
  turnId: string | null
  sequence: number
  text?: string
  finish?: string | null
  isFinalStatement?: boolean
  toolName?: string
  callId?: string
  input?: unknown
  output?: string
  error?: string
  status?: 'running' | 'completed' | 'error' | 'cancelled' | 'pending'
  exitCode?: number | null
  durationMs?: number | null
  readOnly?: boolean | null
  destructive?: boolean | null
  approvalStatus?: string | null
  truncated?: boolean
  outputBytes?: number
  usage?: TokenTotals | null
  model?: ModelRef | null
  note?: string
}

export interface TimelineResponse {
  sessionId: string
  items: TimelineItem[]
  totals: { user: number; assistant: number; tool: number }
  tokens: TokenTotals
  live: LiveState
  lastEventAt: number | null
  hasMore: boolean
  tokenNote: string
}

export type GitFileBucket = 'staged' | 'unstaged' | 'untracked' | 'both'

export interface GitFile {
  path: string
  bucket: GitFileBucket
  indexStatus: string
  worktreeStatus: string
  size: number | null
  sha256: string | null
  preExisting: boolean
  changedSinceBaseline: boolean
  attribution: 'pre-existing' | 'changed-during-observation' | 'committed-during-observation' | 'unknown'
  sensitive: boolean
  sensitiveReasons: string[]
  selectable: boolean
  excludedReason: string | null
}

export interface GitCommit {
  hash: string
  shortHash: string
  author: string
  time: number
  subject: string
}

export interface GitEvidence {
  sessionId: string
  available: boolean
  reason: string | null
  capturedAt: number
  projectRoot: string
  gitRoot: string | null
  branch: string | null
  head: string | null
  baseline: BaselineInfo
  attribution: 'confirmed' | 'partial' | 'unknown'
  attributionNote: string
  buckets: {
    staged: GitFile[]
    unstaged: GitFile[]
    untracked: GitFile[]
  }
  commitsSinceBaseline: GitCommit[]
  statusText: string
  diffStat: { staged: string; unstaged: string }
  snapshotState: 'in_progress' | 'idle'
}

export type SummarySectionKey =
  | 'goal'
  | 'changes'
  | 'state'
  | 'files'
  | 'verification'
  | 'claims'
  | 'open'
  | 'next'

export interface SummarySectionDef {
  key: SummarySectionKey
  title: string
  hint: string
}

export const SUMMARY_SECTIONS: SummarySectionDef[] = [
  { key: 'goal', title: '原始目标与约束', hint: '首条真实用户要求，以及明确写下的限制' },
  { key: 'changes', title: '用户后来变更的要求', hint: '按时间列出后续追加或修改的要求' },
  { key: 'state', title: '当前状态与关键决策', hint: '做到哪一步、为什么这样选' },
  { key: 'files', title: '实际观察到的文件变更', hint: '来自 Git 状态与 diff，不来自模型自述' },
  { key: 'verification', title: '已执行的验证和结果', hint: '只写工具记录里的命令、退出码与输出摘要' },
  { key: 'claims', title: '执行者声称完成但尚未核实', hint: '模型原话，必须标注未经核实' },
  { key: 'open', title: '未解决问题', hint: '错误、进行中的任务、缺失信息' },
  { key: 'next', title: '建议接手者首先检查什么', hint: '按优先级给出可执行的检查项' }
]

export interface CitationCheck {
  total: number
  resolved: number
  unresolved: string[]
}

export interface SummaryDraft {
  sessionId: string
  sections: Record<SummarySectionKey, string>
  generatedAt: number
  source: 'ai' | 'template' | 'edited-template' | 'edited-ai'
  model: string | null
  evidenceHash: string
  citations: CitationCheck
  error: string | null
  stale: boolean
}

export interface ModelSettingsPublic {
  baseUrl: string
  model: string
  temperature: number
  apiKeyConfigured: boolean
  keyStorage: 'dpapi' | 'basic' | 'unavailable' | 'none'
}

export interface PublicSettings {
  model: ModelSettingsPublic
  zcodeDbPath: string
  appVersion: string
  userDataPath: string
}

export interface AppBootstrap {
  appVersion: string
  zcodeDbPath: string
  zcodeReadable: boolean
  zcodeError: string | null
  schema: { compatible: boolean; missing: string[]; detail: string }
  attached: AttachedSession[]
  settings: PublicSettings
  connectors: ConnectorInfo[]
  demoMode: false
}

export type ConnectorKind = 'export' | 'cli' | 'unsupported'

export type ConnectorVerificationState = 'candidate' | 'verified' | 'unsupported'

export interface ConnectorInfo {
  id: string
  label: string
  kind: ConnectorKind
  available: boolean
  verified: boolean
  verificationState: ConnectorVerificationState
  verifiedAt: number | null
  reason: string | null
  detail: string
  primary: boolean
}

export interface ConnectorVerification {
  connectorId: string
  verified: boolean
  verifiedAt: number | null
  latencyMs: number | null
  detail: string
  responseExcerpt: string | null
  error: string | null
}

export type RelayMode = 'review' | 'implement'

export interface PackRequest {
  sessionId: string
  mode: RelayMode
  filePaths: string[]
  includeFullFiles: boolean
  extraNotes: string
  allowSensitive?: boolean
}

export interface PackFileEntry {
  path: string
  bytes: number
  sha256: string
  role: 'handoff' | 'session' | 'change' | 'file' | 'evidence'
}

export interface ExcludedEntry {
  path: string
  reason: string
}

export interface SensitiveHit {
  path: string
  reason: string
  severity: 'high' | 'medium'
  source: 'path' | 'content'
}

export interface ManifestPreview {
  schemaVersion: number
  app: { name: string; version: string }
  source: { kind: string; dbPath: string; sessionId: string; sessionTitle: string; directory: string }
  capturedAt: string
  sessionState: 'in_progress' | 'idle'
  baseline: BaselineInfo | null
  project: {
    root: string
    gitRoot: string | null
    head: string | null
    branch: string | null
    attribution: 'confirmed' | 'partial' | 'unknown'
  }
  fileCount: number
  totalBytes: number
  files: PackFileEntry[]
  excluded: ExcludedEntry[]
  sensitiveHits: SensitiveHit[]
  privacyNotice: string
  mode: RelayMode
  tokenNote: string
  recovery: {
    confidence: 'high' | 'medium' | 'low'
    confidenceScore: number
    confidenceReasons: string[]
    signals: RecoverySignal[]
  }
}

export interface TodoItem {
  content: string
  status: 'pending' | 'in_progress' | 'completed' | string
  priority: string
  position: number
  updatedAt: number
}

export interface RecoverySignal {
  id: string
  level: 'info' | 'warn' | 'danger'
  title: string
  detail: string
}

export interface RecoveryBrief {
  sessionId: string
  generatedAt: number
  confidence: 'high' | 'medium' | 'low'
  confidenceScore: number
  confidenceReasons: string[]
  signals: RecoverySignal[]
  latestGoal: string
  olderRequirements: string
  completedEvidence: string
  failedAttempts: string
  workspaceConsistency: string
  nextActions: string
  incompleteTodos: TodoItem[]
}

export interface PackPreview {
  sessionId: string
  generatedAt: number
  mode: RelayMode
  markdown: string
  manifest: ManifestPreview
  files: PackFileEntry[]
  excluded: ExcludedEntry[]
  sensitiveHits: SensitiveHit[]
  totalBytes: number
  warnings: string[]
  relayInstruction: string
  recovery: RecoveryBrief
}

export interface ExportResult {
  ok: boolean
  directory: string | null
  zipPath: string | null
  manifestPath: string | null
  fileCount: number
  totalBytes: number
  error: string | null
}

export interface SendRequest extends PackRequest {
  connectorId: string
  confirmed: boolean
  relayInstruction: string
}

export interface SendResult {
  sent: boolean
  connectorId: string
  verified: boolean
  reason: string | null
  message: string
  output: string | null
  exitCode: number | null
  durationMs: number | null
  packDirectory: string | null
}

export interface AttachRequest {
  sessionId: string
  projectRoot: string
}

export interface SyncResult {
  ok: boolean
  sessionId: string
  newEvents: number
  updatedEvents: number
  lastSyncAt: number
  error: string | null
  live: LiveState
}

export type RelayEvent =
  | { type: 'session-updated'; sessionId: string; live: LiveState; newEvents: number; eventCount: number; lastSyncAt: number }
  | { type: 'sync-error'; sessionId: string; message: string; at: number }
  | { type: 'session-detached'; sessionId: string }

export interface RelayApi {
  bootstrap(): Promise<AppBootstrap>
  listSessions(query?: string): Promise<{ sessions: SessionSummary[]; error: string | null }>
  attachSession(request: AttachRequest): Promise<AttachedSession>
  detachSession(sessionId: string): Promise<void>
  setPaused(sessionId: string, paused: boolean): Promise<AttachedSession>
  refresh(sessionId: string): Promise<SyncResult>
  timeline(sessionId: string, limit?: number): Promise<TimelineResponse>
  recovery(sessionId: string): Promise<RecoveryBrief>
  recoveryMarkdown(sessionId: string): Promise<string>
  gitEvidence(sessionId: string): Promise<GitEvidence>
  refreshGit(sessionId: string): Promise<GitEvidence>
  chooseProjectRoot(defaultPath: string): Promise<string | null>
  previewPack(request: PackRequest): Promise<PackPreview>
  exportPack(request: PackRequest, format?: 'folder' | 'zip'): Promise<ExportResult>
  getSummary(sessionId: string): Promise<SummaryDraft | null>
  generateSummary(sessionId: string, forceTemplate?: boolean): Promise<SummaryDraft>
  saveSummary(sessionId: string, sections: Record<string, string>): Promise<SummaryDraft>
  settings(): Promise<PublicSettings>
  saveSettings(input: { baseUrl: string; model: string; temperature: number; apiKey?: string; keepKey?: boolean }): Promise<PublicSettings>
  testModel(): Promise<{ ok: boolean; message: string; latencyMs: number | null }>
  connectors(): Promise<ConnectorInfo[]>
  sendToAgent(request: SendRequest): Promise<SendResult>
  saveSelectedFiles(sessionId: string, files: string[] | null): Promise<AttachedSession>
  verifyConnector(connectorId: string, confirmed: boolean): Promise<ConnectorVerification>
  copyText(text: string): Promise<{ ok: boolean }>
  openPath(path: string): Promise<{ ok: boolean; error: string | null }>
  revealPath(path: string): Promise<void>
  onEvent(listener: (event: RelayEvent) => void): () => void
}

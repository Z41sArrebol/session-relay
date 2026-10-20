import { existsSync } from 'node:fs'
import path from 'node:path'
import type { GitFile, RecoveryBrief, RecoverySignal, TimelineItem, TodoItem } from '../../shared/types'
import type { PackContext } from './handoff'
import { isInside, safeJoin } from './paths'

const STALE_RUNNING_MS = 10 * 60 * 1000

function iso(ms: number): string {
  return new Date(ms).toISOString()
}

function cap(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max)}…[截断]`
}

function commandOf(item: TimelineItem): string {
  const input = item.input as Record<string, unknown> | undefined
  if (!input) return ''
  if (typeof input.command === 'string') return input.command
  if (typeof input.file_path === 'string') return input.file_path
  if (typeof input.path === 'string') return input.path
  try {
    return JSON.stringify(input).slice(0, 240)
  } catch {
    return ''
  }
}

function filePathOf(item: TimelineItem): string | null {
  const input = item.input as Record<string, unknown> | undefined
  if (!input) return null
  if (typeof input.file_path === 'string') return input.file_path
  if (typeof input.path === 'string') return input.path
  return null
}

function isVerification(command: string): boolean {
  return (
    /\b(npm|pnpm|yarn|bun)\s+(run\s+)?(test|build|lint|typecheck|check)\b/i.test(command) ||
    /\b(vitest|jest|pytest|go\s+test|cargo\s+test|mvn\s+test|gradle\s+test|dotnet\s+test)\b/i.test(command) ||
    /\b(tsc|eslint|prettier|ruff|flake8|mypy)\b/i.test(command)
  )
}

function allGitFiles(ctx: PackContext): GitFile[] {
  const map = new Map<string, GitFile>()
  for (const f of [...ctx.git.buckets.staged, ...ctx.git.buckets.unstaged, ...ctx.git.buckets.untracked]) map.set(f.path, f)
  return [...map.values()]
}

const FOLLOW_UP_PATTERNS: RegExp[] = [
  /^(继续|接着|往下|然后|下一步|然后呢)[。.!！,，\s]*$/,
  /^(继续|接着)(做|完成|执行|干活|工作)[。.!！\s]*$/,
  /^继续完成任务[。.!！\s]*$/,
  /^(go\s*on|continue|keep\s*going)[。.!！\s]*$/i,
  /^(现在|目前)?(怎么样了|怎么样|如何|到哪了|做到哪了|进度如何|进展如何|进度|进展|呢)[。.!！?？\s]*$/,
  /^(好了吗|完成了吗|可以了吗|行了吗|结束了吗)[。.!！?？\s]*$/,
  /^(ok|okay|好|好的|行|可以|收到|嗯|对|是|是的|没问题)[。.!！,，\s]*$/i,
  /^(好|可以|行|嗯|ok)[，,。\s]*(继续|接着|往下)/i,
  /^[?？.。…\s]+$/
]

/**
 * "继续" / "现在怎么样了" are control messages, not a new goal. They must not
 * replace the last substantive requirement, otherwise the receiver loses the
 * actual task. Short specific instructions ("改红色") are still substantive.
 */
export function isFollowUpMessage(text: string): boolean {
  const trimmed = (text || '').trim()
  if (!trimmed) return true
  if (trimmed.length > 80) return false
  return FOLLOW_UP_PATTERNS.some((re) => re.test(trimmed))
}

export interface EffectiveGoalSelection {
  goal: TimelineItem | null
  older: TimelineItem[]
  trailing: TimelineItem[]
  goalIsFollowUp: boolean
}

export function selectEffectiveGoal(users: TimelineItem[]): EffectiveGoalSelection {
  if (!users.length) return { goal: null, older: [], trailing: [], goalIsFollowUp: false }
  let index = -1
  for (let i = users.length - 1; i >= 0; i--) {
    if (!isFollowUpMessage(users[i].text || '')) {
      index = i
      break
    }
  }
  const goalIsFollowUp = index < 0
  if (index < 0) index = 0
  return {
    goal: users[index],
    older: users.slice(0, index).filter((u) => !isFollowUpMessage(u.text || '')),
    trailing: users.slice(index + 1),
    goalIsFollowUp
  }
}

export type FailureFamily = 'test' | 'build' | 'lint' | 'typecheck'

export interface FailureRecord {
  item: TimelineItem
  command: string
  normalized: string
  family: FailureFamily | null
  resolvedBy: TimelineItem | null
  afterGoal: boolean
  exploratory: boolean
}

function normalizeCommand(command: string): string {
  return command
    .trim()
    .replace(/\s+/g, ' ')
    .replace(/^cd\s+[^&]+&&\s*/i, '')
}

function oneLine(text: string): string {
  return text.replace(/\s+/g, ' ').trim()
}

function commandFamily(command: string): FailureFamily | null {
  if (/\b(npm|pnpm|yarn|bun)\s+(run\s+)?test\b|\b(vitest|jest|pytest|go\s+test|cargo\s+test|dotnet\s+test)\b/i.test(command)) return 'test'
  if (/\b(npm|pnpm|yarn|bun)\s+(run\s+)?build\b|\b(vite\s+build|cargo\s+build|go\s+build|dotnet\s+build)\b/i.test(command)) return 'build'
  if (/\b(npm|pnpm|yarn|bun)\s+(run\s+)?lint\b|\b(eslint|ruff|flake8|golangci-lint)\b/i.test(command)) return 'lint'
  if (/\b(tsc|typecheck|mypy)\b/i.test(command)) return 'typecheck'
  return null
}

function isExploratoryCommand(command: string): boolean {
  const trimmed = command.trim()
  return (
    /^(python3?|node)\s+-[ce]\b/i.test(trimmed) ||
    /\bsqlite3\b/i.test(trimmed) ||
    /^(grep|rg|find|ls|dir|cat|head|tail|type)\b/i.test(trimmed)
  )
}

/**
 * Classify failed tool calls, but keep "historic" failures separate from the
 * current task. A historic exploratory command must not become the receiver's
 * next action just because it never succeeded.
 */
export function classifyFailures(tools: TimelineItem[], goalTime: number): FailureRecord[] {
  const failures = tools
    .filter((item) => item.status === 'error' || (item.exitCode !== null && item.exitCode !== undefined && item.exitCode !== 0))
    .sort((a, b) => a.time - b.time)
  return failures.map((item) => {
    const command = commandOf(item)
    const normalized = normalizeCommand(command)
    const family = commandFamily(command)
    const targetFile = filePathOf(item)
    const resolvedBy =
      tools.find((later) => {
        if (later.time <= item.time || later.status !== 'completed') return false
        if (later.exitCode !== null && later.exitCode !== undefined && later.exitCode !== 0) return false
        const laterCommand = normalizeCommand(commandOf(later))
        if (normalized && laterCommand === normalized) return true
        if (family && commandFamily(commandOf(later)) === family) return true
        const laterFile = filePathOf(later)
        return Boolean(targetFile && laterFile && targetFile === laterFile)
      }) || null
    return {
      item,
      command,
      normalized,
      family,
      resolvedBy,
      afterGoal: goalTime <= 0 || item.time >= goalTime,
      exploratory: isExploratoryCommand(command)
    }
  })
}

export interface FailureSelectionContext {
  incompleteTodos: TodoItem[]
  changedFiles: string[]
}

export function selectRecommendedFailure(records: FailureRecord[], ctx: FailureSelectionContext): FailureRecord | null {
  const current = records.filter((record) => !record.resolvedBy && record.afterGoal)
  if (!current.length) return null
  const todoText = ctx.incompleteTodos.map((todo) => todo.content).join(' ')
  const score = (record: FailureRecord): number => {
    let value = 100
    if (record.family) value += 20
    if (!record.exploratory) value += 20
    if (ctx.changedFiles.some((file) => record.command.includes(file))) value += 15
    if (todoText && record.command && todoText.includes(record.command.slice(0, 24))) value += 10
    return value
  }
  return [...current].sort((a, b) => score(b) - score(a) || b.item.time - a.item.time)[0] || null
}

export function failureGuidance(record: FailureRecord | null, historicalUnresolved: number): string | null {
  if (record) {
    const ref = `[T:${record.item.callId || record.item.id}]`
    const command = oneLine(record.command)
    if (command.length <= 300) {
      return `- 当前目标内最近一条未解决失败（${iso(record.item.time)}）：\`${command}\` ${ref}；先确认它是否仍与剩余待办有关。`
    }
    return `- 当前目标内最近一条未解决失败的命令较长（${command.length} 字符），不在此处截断；请查看 ${ref} 的完整执行记录。`
  }
  if (historicalUnresolved > 0) {
    return `- 失败路线里有 ${historicalUnresolved} 条早于当前目标的未解决失败；不要直接重跑，先确认是否与当前待办有关。`
  }
  return null
}

export interface ConfidenceInput {
  gitAvailable: boolean
  hasBaseline: boolean
  dangerCount: number
  warnCount: number
  usableGoal: boolean
  verifiedEvidence: boolean
  missingWritten: number
  syncError: boolean
  running: boolean
  staleTodos: boolean
}

export interface ConfidenceResult {
  confidence: RecoveryBrief['confidence']
  score: number
  reasons: string[]
}

/**
 * Confidence is a gate plus a score, not "Git exists". High requires every
 * evidence gate to pass and no warning/danger signal. Reasons are returned so
 * the UI and HANDOFF can say why the label is what it is.
 */
export function computeConfidence(input: ConfidenceInput): ConfidenceResult {
  let score = 100
  const reasons: string[] = []
  const deduct = (amount: number, reason: string): void => {
    score -= amount
    reasons.push(`-${amount} ${reason}`)
  }

  if (!input.gitAvailable) deduct(35, '无法读取 Git 工作区')
  if (!input.hasBaseline) deduct(25, '缺少接入时基线')
  if (!input.usableGoal) deduct(20, '没有找到实质性目标，或目标只是控制指令')
  if (!input.verifiedEvidence) deduct(20, '没有可核对的完成证据（文件变更、完成待办、退出码 0 的验证命令）')
  if (input.dangerCount) deduct(40, `危险信号 ${input.dangerCount} 条`)
  if (input.warnCount) deduct(Math.min(30, input.warnCount * 8), `警告信号 ${input.warnCount} 条`)
  if (input.missingWritten) deduct(25, `工具写过但当前不存在的文件 ${input.missingWritten} 个`)
  if (input.syncError) deduct(25, '最近一次读取失败')
  if (input.running) deduct(10, '会话仍在执行，结果是进行中快照')
  if (input.staleTodos) deduct(15, '未完成待办长时间没有更新，可能已过期')

  score = Math.max(0, score)
  const gatesOk =
    input.gitAvailable &&
    input.hasBaseline &&
    input.usableGoal &&
    input.verifiedEvidence &&
    input.dangerCount === 0 &&
    input.warnCount === 0 &&
    input.missingWritten === 0 &&
    !input.syncError &&
    !input.running &&
    !input.staleTodos
  const confidence = gatesOk && score >= 90 ? 'high' : score >= 60 ? 'medium' : 'low'
  if (confidence === 'high') {
    reasons.unshift('已满足 Git/基线/目标/证据/一致性门槛，且没有警告或危险信号')
  }
  return { confidence, score, reasons }
}

function isIncomplete(todo: TodoItem): boolean {
  return todo.status !== 'completed'
}

function todoRank(todo: TodoItem): number {
  const status = todo.status === 'in_progress' ? 0 : 1
  const priority = todo.priority === 'high' ? 0 : todo.priority === 'medium' ? 1 : 2
  return status * 10 + priority
}

export function buildRecoveryBrief(ctx: PackContext): RecoveryBrief {
  const users = ctx.timeline.filter((i) => i.kind === 'user')
  const assistants = ctx.timeline.filter((i) => i.kind === 'assistant')
  const tools = ctx.timeline.filter((i) => i.kind === 'tool')
  const todos = ctx.todos || []
  const turns = ctx.turns || []
  const incompleteTodos = todos.filter(isIncomplete).sort((a, b) => todoRank(a) - todoRank(b) || a.position - b.position)
  const completedTodos = todos.filter((t) => t.status === 'completed')
  const goalSelection = selectEffectiveGoal(users)

  const signals: RecoverySignal[] = []
  const contextExceeded = turns.filter((t) => t.contextExceeded)
  if (contextExceeded.length) {
    signals.push({
      id: 'context-exceeded',
      level: 'danger',
      title: `上下文超限记录 ${contextExceeded.length} 次`,
      detail: 'Z-Code 记录里出现过 context_exceeded。原会话可能无法继续，恢复材料比继续对话更可靠。'
    })
  }
  const cancelled = turns.filter((t) => t.cancelledByUser)
  if (cancelled.length) {
    signals.push({
      id: 'cancelled',
      level: 'info',
      title: `用户取消过 ${cancelled.length} 个 turn`,
      detail: '取消前的工具结果和文件变更仍可能有效，但需要按证据重新确认。'
    })
  }
  const lastActivity = ctx.row.live.lastActivityAt || 0
  if (ctx.row.live.state === 'running') {
    const stale = lastActivity > 0 && Date.now() - lastActivity > STALE_RUNNING_MS
    signals.push({
      id: stale ? 'stale-running' : 'running',
      level: stale ? 'danger' : 'warn',
      title: stale ? '会话标记为执行中，但已长时间没有新记录' : '会话仍在执行',
      detail: stale
        ? `最后活动在 ${iso(lastActivity)}。可能是卡住、额度耗尽或客户端已关闭；先确认是否还能继续。`
        : '当前生成的是进行中快照；恢复前应确认原会话是否已经停止。'
    })
  }
  const failedTools = tools.filter((t) => t.status === 'error' || (t.exitCode !== null && t.exitCode !== undefined && t.exitCode !== 0))
  if (failedTools.length) {
    signals.push({
      id: 'tool-errors',
      level: failedTools.length >= 3 ? 'danger' : 'warn',
      title: `工具失败 ${failedTools.length} 条`,
      detail: '失败命令不代表任务失败，但重复失败通常意味着路线需要调整。'
    })
  }
  if (incompleteTodos.length) {
    signals.push({
      id: 'todos',
      level: 'warn',
      title: `还有 ${incompleteTodos.length} 项未完成待办`,
      detail: '来自 Z-Code 的 todo 表；这是判断“剩下什么”最直接的信号。'
    })
  }
  if ((ctx.modelErrorCount || 0) > 0) {
    signals.push({
      id: 'model-errors',
      level: 'warn',
      title: `模型调用错误 ${ctx.modelErrorCount} 次`,
      detail: '可能包括额度、鉴权、网络或服务端错误；接手者应避免重复同样的调用路线。'
    })
  }
  if (!ctx.git.available) {
    signals.push({
      id: 'no-git',
      level: 'warn',
      title: '无法核对工作区',
      detail: ctx.git.reason || '所选项目目录不是 Git 工作区。'
    })
  } else if (!ctx.row.baseline.info.hasBaseline) {
    signals.push({
      id: 'no-baseline',
      level: 'warn',
      title: '缺少接入时基线',
      detail: '无法区分哪些修改是接入前已经存在的。'
    })
  }
  if (ctx.row.syncError) {
    signals.push({ id: 'sync-error', level: 'danger', title: '最近一次读取失败', detail: ctx.row.syncError })
  }
  const lastAssistant = assistants[assistants.length - 1]
  if (lastAssistant && !lastAssistant.isFinalStatement) {
    signals.push({
      id: 'no-final',
      level: 'warn',
      title: '最后一条公开回复没有正常收尾',
      detail: '没有捕获到 finish=stop 的收尾陈述；任务可能在中途停止。'
    })
  }

  const gitFiles = allGitFiles(ctx)
  const changedDuring = gitFiles.filter((f) => f.changedSinceBaseline && f.attribution !== 'pre-existing')
  const preExisting = gitFiles.filter((f) => f.preExisting)
  const writtenFiles = new Map<string, string>()
  for (const item of tools) {
    if (!['Write', 'Edit', 'MultiEdit'].includes(item.toolName || '')) continue
    if (item.status !== 'completed') continue
    const raw = filePathOf(item)
    if (!raw) continue
    if (path.isAbsolute(raw) && !isInside(ctx.git.projectRoot, raw)) continue
    const rel = path.isAbsolute(raw) ? path.relative(ctx.git.projectRoot, raw) : raw
    writtenFiles.set(rel.replace(/\\/g, '/'), item.callId || item.id)
  }
  const missingWritten = [...writtenFiles.keys()].filter((rel) => {
    try {
      return !existsSync(safeJoin(ctx.git.projectRoot, rel))
    } catch {
      return true
    }
  })

  const completedEvidence: string[] = []
  if (ctx.git.commitsSinceBaseline.length) {
    completedEvidence.push(
      `- 观察窗口内提交：${ctx.git.commitsSinceBaseline
        .map((c) => `${c.shortHash} ${c.subject} [C:${c.hash}]`)
        .join('；')}`
    )
  }
  if (changedDuring.length) {
    completedEvidence.push(
      `- 观察窗口内变化的文件：${changedDuring
        .slice(0, 20)
        .map((f) => `\`${f.path}\` [F:${f.path}]`)
        .join('、')}${changedDuring.length > 20 ? ` 等 ${changedDuring.length} 个` : ''}`
    )
  }
  if (completedTodos.length) {
    completedEvidence.push(
      `- 执行者标记完成的待办：${completedTodos
        .slice(0, 10)
        .map((t) => t.content)
        .join('；')}（待办勾选，未独立核实）`
    )
  }
  const verifiedCommands = tools.filter(
    (t) => isVerification(commandOf(t)) && t.exitCode === 0 && (t.status === 'completed' || t.status === undefined)
  )
  // The last write/edit in the session must not be newer than the last
  // successful verification, or the verification cannot prove the final state.
  const lastEditAt = Math.max(
    0,
    ...tools
      .filter((t) => ['Write', 'Edit', 'MultiEdit'].includes(t.toolName || '') && t.status === 'completed')
      .map((t) => t.time)
  )
  const lastVerifiedAt = verifiedCommands.length ? verifiedCommands[verifiedCommands.length - 1].time : 0
  const verificationPrecedesEdits = lastEditAt > 0 && lastVerifiedAt > 0 && lastEditAt > lastVerifiedAt
  if (verifiedCommands.length) {
    completedEvidence.push(
      `- 观察到退出码 0 的验证命令：${verifiedCommands
        .slice(-8)
        .map((t) => `\`${cap(oneLine(commandOf(t)), 160)}\` [T:${t.callId || t.id}]`)
        .join('；')}`
    )
  }
  if (verificationPrecedesEdits) {
    completedEvidence.push(
      `- ⚠️ 最后一次成功验证（${iso(lastVerifiedAt)}）早于最后一次文件写入（${iso(lastEditAt)}），不能证明最终状态可用。`
    )
    signals.push({
      id: 'verification-stale',
      level: 'warn',
      title: '最后成功验证早于最后文件写入',
      detail: '退出码 0 的验证发生在后续编辑之前，不能证明当前工作区可用。'
    })
  }
  if (!completedEvidence.length) {
    completedEvidence.push('没有捕获到可核对的文件变更、完成待办或退出码 0 的验证命令。')
  }

  const failureRecords = classifyFailures(tools, goalSelection.goal?.time || 0)
  const byCommand = new Map<string, FailureRecord>()
  for (const record of failureRecords) {
    const key = record.normalized || `${record.item.toolName}|${record.command}`
    byCommand.set(key, record)
  }
  const failedLines: string[] = []
  for (const record of [...byCommand.values()].sort((a, b) => a.item.time - b.item.time)) {
    const item = record.item
    const command = oneLine(record.command)
    const shown =
      command.length > 200
        ? `${command.slice(0, 200)}…（命令已截断，完整见 [T:${item.callId || item.id}]）`
        : command
    const state = record.resolvedBy
      ? `后来同类命令成功 [T:${record.resolvedBy.callId || record.resolvedBy.id}]，疑似已解决`
      : record.afterGoal
        ? '当前目标内失败，仍未解决'
        : '历史失败（早于当前目标），不建议直接重跑'
    failedLines.push(
      `- ${iso(item.time)} \`${shown || item.toolName || ''}\` [T:${item.callId || item.id}]：${
        item.status === 'error' ? '工具报错' : `退出码 ${item.exitCode}`
      }；${state}`
    )
  }
  if ((ctx.modelErrorCount || 0) > 0) {
    failedLines.push(`- 模型调用错误 ${ctx.modelErrorCount} 次；具体错误类型见 model_usage，交接包中不保证完整展开。`)
  }
  if (cancelled.length) {
    failedLines.push(`- 用户取消过 ${cancelled.length} 个 turn；取消前的路线不应默认继续。`)
  }
  if (!failedLines.length) failedLines.push('没有捕获到失败的工具调用、模型错误或用户取消。')
  const historicalUnresolved = failureRecords.filter((record) => !record.resolvedBy && !record.afterGoal).length
  const recommendedFailure = selectRecommendedFailure(failureRecords, {
    incompleteTodos,
    changedFiles: changedDuring.map((file) => file.path)
  })

  const workspaceLines: string[] = []
  if (!ctx.git.available) {
    workspaceLines.push(`- ${ctx.git.reason || 'Git 不可用'}，无法把会话记录与当前文件状态对照。`)
  } else {
    workspaceLines.push(
      `- 分支 ${ctx.git.branch || '未知'}，HEAD ${ctx.git.head ? ctx.git.head.slice(0, 8) : '无'}；暂存 ${
        ctx.git.buckets.staged.length
      }、未暂存 ${ctx.git.buckets.unstaged.length}、未跟踪 ${ctx.git.buckets.untracked.length}。`
    )
    workspaceLines.push(`- ${ctx.git.attributionNote}`)
    if (preExisting.length) {
      workspaceLines.push(`- 接入前已存在的修改：${preExisting.slice(0, 10).map((f) => `\`${f.path}\``).join('、')}`)
    }
    if (changedDuring.length) {
      workspaceLines.push(`- 观察窗口内变化的文件：${changedDuring.slice(0, 10).map((f) => `\`${f.path}\``).join('、')}`)
    }
    if (missingWritten.length) {
      workspaceLines.push(`- 工具写过但当前已不存在的文件：${missingWritten.map((f) => `\`${f}\``).join('、')}`)
    }
    if (ctx.git.snapshotState === 'in_progress') {
      workspaceLines.push('- 会话可能仍在写；当前对照只是进行中快照。')
    }
  }
  if (writtenFiles.size) {
    workspaceLines.push(
      `- 工具写入/编辑过的文件：${[...writtenFiles.keys()].slice(0, 20).map((f) => `\`${f}\``).join('、')}`
    )
  }

  const nextLines: string[] = []
  if (incompleteTodos.length) {
    nextLines.push('未完成待办（按进行中/高优先级排序）：')
    for (const todo of incompleteTodos.slice(0, 8)) {
      nextLines.push(`- [${todo.status}/${todo.priority}] ${todo.content}`)
    }
  } else {
    nextLines.push('- 没有未完成的待办记录；先核对下面的失败路线和工作区对照。')
  }
  const guidance = failureGuidance(recommendedFailure, historicalUnresolved)
  if (guidance) nextLines.push(guidance)
  nextLines.push('- 读 `changes/status.txt` 与 `changes/diff-*.patch`，确认当前工作区与记录是否一致。')
  nextLines.push('- 逐条核查“收尾陈述”，不要把执行者自述当成已验证结果。')

  const lastActivityAt = ctx.row.live.lastActivityAt || 0
  const staleTodos =
    incompleteTodos.length > 0 &&
    lastActivityAt > 0 &&
    incompleteTodos.some((todo) => lastActivityAt - todo.updatedAt > 30 * 60 * 1000)
  const verifiedEvidence =
    ctx.git.commitsSinceBaseline.length > 0 ||
    changedDuring.length > 0 ||
    completedTodos.length > 0 ||
    verifiedCommands.length > 0
  const dangerCount = signals.filter((signal) => signal.level === 'danger').length
  const warnCount = signals.filter((signal) => signal.level === 'warn').length
  const confidenceResult = computeConfidence({
    gitAvailable: ctx.git.available,
    hasBaseline: ctx.row.baseline.info.hasBaseline,
    dangerCount,
    warnCount,
    usableGoal: Boolean(goalSelection.goal) && !goalSelection.goalIsFollowUp,
    verifiedEvidence,
    missingWritten: missingWritten.length,
    syncError: Boolean(ctx.row.syncError),
    running: ctx.row.live.state === 'running',
    staleTodos
  })

  const goal = goalSelection.goal
  const trailingGoalNote = goalSelection.trailing.length
    ? `\n\n末尾还有 ${goalSelection.trailing.length} 条控制/进度消息，未当作新目标：${goalSelection.trailing
        .slice(-3)
        .map((item) => `「${cap(item.text || '', 80)}」`)
        .join('、')}`
    : ''
  const goalPrefix = goalSelection.goalIsFollowUp
    ? '没有找到实质性要求；以下是最早一条用户消息，可能只是控制指令，请人工确认目标。\n\n'
    : ''

  return {
    sessionId: ctx.row.sessionId,
    generatedAt: Date.now(),
    confidence: confidenceResult.confidence,
    confidenceScore: confidenceResult.score,
    confidenceReasons: confidenceResult.reasons,
    signals,
    latestGoal: goal
      ? `${goalPrefix}${cap(goal.text || '', 6000)}\n\n（最后一条实质性用户要求，${iso(
          goal.time
        )}；引用 [M:${goal.messageId}]）${trailingGoalNote}`
      : '没有采集到真实用户要求。',
    olderRequirements: goalSelection.older.length
      ? goalSelection.older
          .slice(-6)
          .map((i, index) => `${index + 1}. ${iso(i.time)}：${cap(i.text || '', 1200)} [M:${i.messageId}]`)
          .join('\n\n') + '\n\n这些是较早的实质性要求，可能仍然有效；请与最新目标一起核对，不要只看最后一句。'
      : '没有更早的实质性要求。',
    completedEvidence: completedEvidence.join('\n'),
    failedAttempts: failedLines.join('\n'),
    workspaceConsistency: workspaceLines.join('\n'),
    nextActions: nextLines.join('\n'),
    incompleteTodos
  }
}

/** Compact markdown used by the "copy recovery brief" button. */
export function recoveryMarkdown(brief: RecoveryBrief): string {
  return [
    '# 恢复简报',
    '',
    `- 生成时间：${iso(brief.generatedAt)}`,
    `- 可信度：${brief.confidence}（${brief.confidenceScore}）`,
    ...(brief.confidenceReasons.length
      ? [`- 可信度依据：${brief.confidenceReasons.slice(0, 5).join('；')}`]
      : []),
    `- 信号：${brief.signals.length ? brief.signals.map((s) => s.title).join('；') : '无'}`,
    '',
    '## 1. 最新目标',
    brief.latestGoal,
    '',
    '## 2. 已完成与可核对证据',
    brief.completedEvidence,
    '',
    '## 3. 失败过的路线',
    brief.failedAttempts,
    '',
    '## 4. 工作区一致性',
    brief.workspaceConsistency,
    '',
    '## 5. 接手后先做什么',
    brief.nextActions,
    ''
  ].join('\n')
}

export function recoveryMarkdownHeadings(): string {
  return '最新目标 / 已完成证据 / 失败路线 / 工作区一致性 / 下一步'
}

export { STALE_RUNNING_MS }

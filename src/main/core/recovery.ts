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
  const latest = users[users.length - 1] || null
  const older = users.slice(0, -1)

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
  if (verifiedCommands.length) {
    completedEvidence.push(
      `- 观察到退出码 0 的验证命令：${verifiedCommands
        .slice(-8)
        .map((t) => `\`${cap(commandOf(t), 160)}\` [T:${t.callId || t.id}]`)
        .join('；')}`
    )
  }
  if (!completedEvidence.length) {
    completedEvidence.push('没有捕获到可核对的文件变更、完成待办或退出码 0 的验证命令。')
  }

  const failed = [...failedTools].sort((a, b) => a.time - b.time)
  const failedLines: string[] = []
  const seen = new Set<string>()
  for (const item of failed) {
    const cmd = commandOf(item)
    const key = `${item.toolName}|${cmd}`
    if (seen.has(key)) continue
    seen.add(key)
    const laterSuccess = tools.some(
      (t) => t.time > item.time && commandOf(t) === cmd && t.exitCode === 0 && t.status === 'completed'
    )
    failedLines.push(
      `- ${iso(item.time)} \`${cap(cmd || item.toolName || '', 200)}\` [T:${item.callId || item.id}]：${
        item.status === 'error' ? '工具报错' : `退出码 ${item.exitCode}`
      }${laterSuccess ? '；同一命令后来出现过退出码 0，疑似已解决' : '；没有观察到后来成功，按未解决处理'}`
    )
  }
  if ((ctx.modelErrorCount || 0) > 0) {
    failedLines.push(`- 模型调用错误 ${ctx.modelErrorCount} 次；具体错误类型见 model_usage，交接包中不保证完整展开。`)
  }
  if (cancelled.length) {
    failedLines.push(`- 用户取消过 ${cancelled.length} 个 turn；取消前的路线不应默认继续。`)
  }
  if (!failedLines.length) failedLines.push('没有捕获到失败的工具调用、模型错误或用户取消。')

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
  const unresolved = failed.find(
    (item) => !tools.some((t) => t.time > item.time && commandOf(t) === commandOf(item) && t.exitCode === 0 && t.status === 'completed')
  )
  if (unresolved) {
    nextLines.push(`- 先复现或绕开最近一条未解决失败：\`${cap(commandOf(unresolved) || unresolved.toolName || '', 160)}\``)
  }
  nextLines.push('- 读 `changes/status.txt` 与 `changes/diff-*.patch`，确认当前工作区与记录是否一致。')
  nextLines.push('- 逐条核查“收尾陈述”，不要把执行者自述当成已验证结果。')

  const confidence: RecoveryBrief['confidence'] =
    ctx.git.available && ctx.row.baseline.info.hasBaseline && !signals.some((s) => s.level === 'danger')
      ? 'high'
      : ctx.git.available || ctx.row.baseline.info.hasBaseline
        ? 'medium'
        : 'low'

  return {
    sessionId: ctx.row.sessionId,
    generatedAt: Date.now(),
    confidence,
    signals,
    latestGoal: latest
      ? `${cap(latest.text || '', 6000)}\n\n（最后一条真实用户要求，${iso(latest.time)}；引用 [M:${latest.messageId}]）`
      : '没有采集到真实用户要求。',
    olderRequirements: older.length
      ? older
          .slice(-4)
          .map((i, index) => `${index + 1}. ${iso(i.time)}：${cap(i.text || '', 1200)} [M:${i.messageId}]`)
          .join('\n\n') + '\n\n以上是较早要求，可能已经失效；以最新一条为准，接手前需要用户确认。'
      : '没有更早的用户要求，或只采集到一条。',
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
    `- 可信度：${brief.confidence}`,
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

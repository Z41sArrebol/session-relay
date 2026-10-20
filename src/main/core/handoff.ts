import { createHash } from 'node:crypto'
import { copyFileSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import type {
  ExcludedEntry,
  GitEvidence,
  GitFile,
  ManifestPreview,
  PackFileEntry,
  PackPreview,
  PackRequest,
  RecoveryBrief,
  SensitiveHit,
  SummaryDraft,
  SummarySectionKey,
  TimelineItem,
  TokenTotals,
  TodoItem
} from '../../shared/types'
import { SUMMARY_SECTIONS } from '../../shared/types'
import type { StoredAttachedRow, TurnMetaRow } from './state'
import { getDiffs } from './git'
import { buildRecoveryBrief, selectEffectiveGoal } from './recovery'
import {
  assertRealInside,
  assertRegularFileNoSymlink,
  formatBytes,
  safeJoin,
  sha256File,
  sha256Text,
  shortId,
  toPosix
} from './paths'
import { inspectPath, isBinaryFile, MAX_PACK_FILE_BYTES, MAX_PACK_TOTAL_BYTES, scanContent, scanTextContent } from './sensitive'

export interface PackContext {
  row: StoredAttachedRow
  git: GitEvidence
  timeline: TimelineItem[]
  tokens: TokenTotals
  summary: SummaryDraft | null
  todos?: TodoItem[]
  turns?: TurnMetaRow[]
  modelErrorCount?: number
}

export interface PackEntry {
  path: string
  data: Buffer
  role: PackFileEntry['role']
}

export interface PackPlan {
  entries: PackEntry[]
  excluded: ExcludedEntry[]
  sensitiveHits: SensitiveHit[]
  warnings: string[]
  markdown: string
  manifest: ManifestPreview
  mode: PackRequest['mode']
  totalBytes: number
  recovery: RecoveryBrief
}

const APP_NAME = '会话接力台'
const SCHEMA_VERSION = 1

export function relayInstruction(mode: PackRequest['mode']): string {
  if (mode === 'review') {
    return [
      '你正在接手另一个 Agent 完成的工作。现在只做独立验收，不修改任何文件、不提交、不运行会改变工作区的命令。',
      '请先读 HANDOFF.md，再按证据索引抽查 session/ 与 changes/，然后给出：',
      '1）结论（可接手 / 需补充 / 不通过）；2）按严重度排序的问题清单，每条附证据路径；',
      '3）执行者声称完成但证据不足的事项；4）建议接手者先检查的 3 件事。',
      '注意：交接包里的“完成”是执行者自述，不等于系统验证；只有 changes/ 和 evidence/ 里的记录算观察证据。'
    ].join('\n')
  }
  return [
    '你正在接手另一个 Agent 未完成的工作。允许修改，但只能修改交接包 manifest.json 列出的文件。',
    '先复述原始目标、当前状态和验收标准；再按最小改动实现；不要扩大范围，不要重构无关代码。',
    '完成后列出：修改的文件、运行的验证命令与退出码、仍未解决的问题。',
    '注意：交接包里的“完成”是执行者自述，不等于系统验证；不要把它当成已验收。'
  ].join('\n')
}

function iso(ms: number): string {
  return new Date(ms).toISOString()
}

function truncate(text: string, max: number): string {
  if (text.length <= max) return text
  return `${text.slice(0, max)}\n\n…（已截断，原文 ${text.length} 字符，见 session/timeline.jsonl）`
}

function summarizeCommand(item: TimelineItem): string {
  const input = item.input as Record<string, unknown> | undefined
  if (!input) return ''
  if (typeof input.command === 'string') return input.command
  if (typeof input.file_path === 'string') return input.file_path
  if (typeof input.path === 'string') return input.path
  if (typeof input.description === 'string') return input.description
  try {
    return JSON.stringify(input).slice(0, 300)
  } catch {
    return ''
  }
}

function isVerificationCommand(command: string): boolean {
  return (
    /\b(npm|pnpm|yarn|bun)\s+(run\s+)?(test|build|lint|typecheck|check)\b/i.test(command) ||
    /\b(vitest|jest|pytest|go\s+test|cargo\s+test|mvn\s+test|gradle\s+test|dotnet\s+test)\b/i.test(command) ||
    /\b(tsc|eslint|prettier|ruff|flake8|mypy)\b/i.test(command)
  )
}

function buildExcerpt(ctx: PackContext, captureIso: string): string {
  const users = ctx.timeline.filter((i) => i.kind === 'user')
  const assistants = ctx.timeline.filter((i) => i.kind === 'assistant')
  const tools = ctx.timeline.filter((i) => i.kind === 'tool')
  const lines: string[] = []
  lines.push(`# 会话摘录 · ${ctx.row.title || '(未命名会话)'}`)
  lines.push('')
  lines.push(`- 会话 ID：\`${ctx.row.sessionId}\``)
  lines.push(`- 工作目录：\`${ctx.row.directory}\``)
  lines.push(`- 采集时间：${captureIso}`)
  lines.push(`- 会话状态：${ctx.git.snapshotState === 'in_progress' ? '进行中快照' : '无进行中的 turn（不代表已完成）'}`)
  lines.push(`- 记录数量：用户 ${users.length} / 回复 ${assistants.length} / 工具 ${tools.length}`)
  lines.push('')
  lines.push('> 只包含真实用户输入与模型公开回复；不包含模型内部思考、系统注入的 model-only 上下文。')
  lines.push('')
  lines.push('## 用户要求')
  lines.push('')
  if (!users.length) lines.push('_没有采集到真实用户输入。_')
  for (const item of users) {
    lines.push(`### ${iso(item.time)}`)
    lines.push('')
    lines.push(truncate(item.text || '', 12000))
    lines.push('')
  }
  lines.push('## 模型公开回复')
  lines.push('')
  if (!assistants.length) lines.push('_没有采集到公开回复。_')
  for (const item of assistants) {
    const model = item.model ? `${item.model.providerId}/${item.model.modelId}` : '未知模型'
    lines.push(`### ${iso(item.time)} · ${model}${item.isFinalStatement ? ' · 收尾陈述（未核实）' : ''}`)
    lines.push('')
    lines.push(truncate(item.text || '', 12000))
    lines.push('')
  }
  lines.push('## 工具调用摘要')
  lines.push('')
  if (!tools.length) lines.push('_没有工具调用。_')
  else {
    lines.push('| 时间 | 工具 | 状态 | 退出码 | 摘要 |')
    lines.push('|---|---|---|---|---|')
    for (const item of tools.slice(0, 300)) {
      const summary = summarizeCommand(item).replace(/\|/g, '\\|').replace(/\n/g, ' ')
      lines.push(
        `| ${iso(item.time)} | ${item.toolName || ''} | ${item.status || ''} | ${item.exitCode ?? ''} | ${truncate(summary, 200)} |`
      )
    }
    if (tools.length > 300) lines.push(`\n_仅列出前 300 条，完整记录见 timeline.jsonl。_`)
  }
  lines.push('')
  return lines.join('\n')
}

function buildStatusDoc(ctx: PackContext): string {
  const lines: string[] = []
  lines.push(`# Git 状态与归属 · ${ctx.row.sessionId}`)
  lines.push('')
  lines.push(`- 采集时间：${iso(ctx.git.capturedAt)}`)
  lines.push(`- 项目目录：\`${ctx.git.projectRoot}\``)
  lines.push(`- Git 根：\`${ctx.git.gitRoot || '无'}\``)
  lines.push(`- 分支：${ctx.git.branch || '未知'}`)
  lines.push(`- HEAD：${ctx.git.head || '未知'}`)
  lines.push(`- 归属判断：${ctx.git.attribution}`)
  lines.push(`- 说明：${ctx.git.attributionNote}`)
  lines.push('')
  lines.push('## 原始 porcelain 状态')
  lines.push('')
  lines.push('```')
  lines.push(ctx.git.statusText || '(无变更)')
  lines.push('```')
  lines.push('')
  const groups: Array<[string, GitFile[]]> = [
    ['暂存', ctx.git.buckets.staged],
    ['未暂存', [...ctx.git.buckets.unstaged, ...ctx.git.buckets.untracked]]
  ]
  for (const [label, files] of groups) {
    lines.push(`## ${label}`)
    lines.push('')
    if (!files.length) lines.push('_无_')
    else {
      lines.push('| 文件 | 状态 | 接入前已存在 | 观察窗口内变化 | 归属 |')
      lines.push('|---|---|---|---|---|')
      for (const f of files) {
        lines.push(
          `| \`${f.path}\` | ${f.indexStatus}${f.worktreeStatus} | ${f.preExisting ? '是' : '否'} | ${
            f.changedSinceBaseline ? '是' : '否'
          } | ${f.attribution} |`
        )
      }
    }
    lines.push('')
  }
  if (ctx.git.commitsSinceBaseline.length) {
    lines.push('## 观察窗口内的提交')
    lines.push('')
    for (const c of ctx.git.commitsSinceBaseline) {
      lines.push(`- \`${c.shortHash}\` ${c.subject} — ${c.author} @ ${iso(c.time)}`)
    }
    lines.push('')
  }
  return lines.join('\n')
}

function buildCommandsDoc(ctx: PackContext): string {
  const tools = ctx.timeline.filter((i) => i.kind === 'tool')
  const candidates = tools.filter((i) => {
    const cmd = summarizeCommand(i)
    return isVerificationCommand(cmd) || (i.toolName === 'Bash' && i.exitCode !== null && i.exitCode !== undefined)
  })
  const lines: string[] = []
  lines.push('# 验证命令记录')
  lines.push('')
  lines.push('> 这是 Z-Code 工具记录的回放，不是独立复验。退出码 0 只代表该命令当时返回 0；')
  lines.push('> “测试通过 / 构建成功”的执行者说法仍属于未核实声明。')
  lines.push('')
  if (!candidates.length) {
    lines.push('_没有捕获到测试、构建、类型检查或 lint 类命令，也没有带退出码的 Bash 调用。_')
    return lines.join('\n')
  }
  lines.push('| 时间 | 工具 | 命令 / 参数 | 状态 | 退出码 | 耗时 |')
  lines.push('|---|---|---|---|---|---|')
  for (const item of candidates.slice(-200)) {
    const cmd = summarizeCommand(item).replace(/\|/g, '\\|').replace(/\n/g, ' ')
    lines.push(
      `| ${iso(item.time)} | ${item.toolName || ''} | \`${truncate(cmd, 400)}\` | ${item.status || ''} | ${
        item.exitCode ?? ''
      } | ${item.durationMs ?? ''} ms |`
    )
  }
  lines.push('')
  lines.push('## 输出尾部')
  lines.push('')
  for (const item of candidates.slice(-20)) {
    lines.push(`### ${iso(item.time)} · ${item.toolName} · ${summarizeCommand(item).slice(0, 160)}`)
    lines.push('')
    lines.push('```text')
    lines.push((item.error || item.output || '(无输出)').slice(-2000))
    lines.push('```')
    lines.push('')
  }
  return lines.join('\n')
}

export function deterministicSections(ctx: PackContext, recovery?: RecoveryBrief): Record<SummarySectionKey, string> {
  const rec = recovery || buildRecoveryBrief(ctx)
  const users = ctx.timeline.filter((i) => i.kind === 'user')
  const assistants = ctx.timeline.filter((i) => i.kind === 'assistant')
  const tools = ctx.timeline.filter((i) => i.kind === 'tool')
  const finalClaims = assistants.filter((i) => i.isFinalStatement)
  const errors = tools.filter((i) => i.status === 'error' || i.exitCode !== null && i.exitCode !== 0)
  // Substantive requirements only; trailing "继续 / 进度" controls are not
  // amendments to the task and must not replace the effective goal.
  const later = selectEffectiveGoal(users).older
  const lastAssistant = assistants[assistants.length - 1]?.text || '(没有公开回复)'
  const allFiles = [...ctx.git.buckets.staged, ...ctx.git.buckets.unstaged, ...ctx.git.buckets.untracked]
  const dedup = new Map<string, GitFile>()
  for (const f of allFiles) dedup.set(f.path, f)
  const fileList = [...dedup.values()]
  const verification = tools.filter((i) => isVerificationCommand(summarizeCommand(i)))
  const sections: Record<SummarySectionKey, string> = {
    goal: rec.latestGoal,
    changes: later.length
      ? later
          .slice(-10)
          .map((i, idx) => `${idx + 1}. ${iso(i.time)}：${truncate(i.text || '', 1500)}`)
          .join('\n\n')
      : '没有观察到用户在首条要求之后追加或修改要求。',
    state: [
      `- 用户消息 ${users.length} 条，公开回复 ${assistants.length} 条，工具调用 ${tools.length} 条。`,
      `- 当前状态：${ctx.git.snapshotState === 'in_progress' ? '会话可能仍在执行（进行中快照）' : '没有检测到运行中的 turn；不等于任务完成'}。`,
      `- 最近一条公开回复：`,
      '',
      truncate(lastAssistant, 4000)
    ].join('\n'),
    files: [
      `- 项目：\`${ctx.git.projectRoot}\``,
      `- 分支 / HEAD：${ctx.git.branch || '未知'} / ${ctx.git.head || '未知'}`,
      `- 暂存 ${ctx.git.buckets.staged.length} 个，未暂存 ${ctx.git.buckets.unstaged.length} 个，未跟踪 ${ctx.git.buckets.untracked.length} 个。`,
      ctx.git.attributionNote,
      '',
      ...fileList.slice(0, 80).map((f) => `- \`${f.path}\`（${f.attribution}）`),
      fileList.length > 80 ? `- …共 ${fileList.length} 个，完整清单见 changes/status.txt` : ''
    ]
      .filter(Boolean)
      .join('\n'),
    verification: verification.length
      ? verification
          .slice(-30)
          .map(
            (i) =>
              `- ${iso(i.time)} \`${summarizeCommand(i).slice(0, 200)}\` → 状态 ${i.status || '未知'}${
                i.exitCode === null || i.exitCode === undefined ? '' : `，退出码 ${i.exitCode}`
              }`
          )
          .join('\n')
      : '没有捕获到测试、构建、类型检查或 lint 类命令。不能据此判断“验证通过”。',
    claims: finalClaims.length
      ? finalClaims
          .slice(-6)
          .map((i) => `- ${iso(i.time)}（执行者原话，未经核实）：${truncate(i.text || '', 2000)}`)
          .join('\n\n')
      : '没有捕获到明确的收尾陈述。',
    open: [
      `- 恢复信号：${rec.signals.length ? rec.signals.map((s) => s.title).join('；') : '无'}`,
      rec.incompleteTodos.length ? `- 未完成待办：${rec.incompleteTodos.slice(0, 6).map((t) => t.content).join('；')}` : '',
      errors.length ? `- 工具错误 ${errors.length} 条，最近一条：${summarizeCommand(errors[errors.length - 1]).slice(0, 300)}` : '',
      ctx.git.snapshotState === 'in_progress' ? '- 会话可能仍在执行，交接包是进行中快照。' : '',
      ctx.git.attribution === 'unknown' ? '- 缺少起始基线，无法确认全部变更归属。' : '',
      ctx.git.attribution === 'partial' ? '- 能区分接入前已有修改，但无法区分观察窗口内是 Agent 还是用户操作。' : '',
      ctx.row.syncError ? `- 最近一次读取错误：${ctx.row.syncError}` : ''
    ]
      .filter(Boolean)
      .join('\n') || '没有记录到明确的未解决问题；这不等于没有问题，接手者仍需自行检查。',
    next: rec.nextActions
  }
  return sections
}

function buildMarkdown(
  ctx: PackContext,
  request: PackRequest,
  captureIso: string,
  sectionsSource: SummaryDraft | null,
  recovery: RecoveryBrief
): string {
  const sections = sectionsSource?.sections || deterministicSections(ctx, recovery)
  const lines: string[] = []
  lines.push(`# 会话接力 · ${ctx.row.title || '(未命名会话)'}`)
  lines.push('')
  lines.push('> 由「会话接力台」只读采集生成。执行者的完成声明未经核实；事实以 session/、changes/、evidence/ 为准。')
  lines.push('')
  lines.push(`- 来源会话：\`${ctx.row.sessionId}\``)
  lines.push(`- 工作目录：\`${ctx.row.directory}\``)
  lines.push(`- 项目目录：\`${ctx.git.projectRoot}\``)
  lines.push(`- 采集时间：${captureIso}`)
  lines.push(`- 会话状态：${ctx.git.snapshotState === 'in_progress' ? '进行中快照' : '无进行中的 turn（不代表已完成）'}`)
  lines.push(`- 归属判断：${ctx.git.attribution === 'unknown' ? '无法确认全部变更归属' : '部分可归属（区分接入前/窗口内，不区分 Agent/用户）'}`)
  lines.push(`- 接力模式：${request.mode === 'review' ? '独立验收（只检查、报告，不授权修改）' : '继续实现（允许修改清单内文件）'}`)
  lines.push('')
  lines.push('## 0. 接力指令')
  lines.push('')
  lines.push('```text')
  lines.push(relayInstruction(request.mode))
  lines.push('```')
  lines.push('')
  if (request.extraNotes.trim()) {
    lines.push('## 0.1 用户补充说明')
    lines.push('')
    lines.push(request.extraNotes.trim())
    lines.push('')
  }
  lines.push('## 0.2 恢复简报（接手先看）')
  lines.push('')
  lines.push(`- 可信度：${recovery.confidence}（${recovery.confidenceScore}）`)
  if (recovery.confidenceReasons.length) {
    lines.push(`- 可信度依据：${recovery.confidenceReasons.slice(0, 5).join('；')}`)
  }
  lines.push(
    `- 信号：${
      recovery.signals.length
        ? recovery.signals.map((s) => `[${s.level}] ${s.title}`).join('；')
        : '没有检测到明确的卡住/交付缺失信号'
    }`
  )
  lines.push('')
  lines.push('### 最新目标')
  lines.push('')
  lines.push(recovery.latestGoal)
  lines.push('')
  lines.push('### 已完成与可核对证据')
  lines.push('')
  lines.push(recovery.completedEvidence)
  lines.push('')
  lines.push('### 失败过的路线')
  lines.push('')
  lines.push(recovery.failedAttempts)
  lines.push('')
  lines.push('### 工作区一致性')
  lines.push('')
  lines.push(recovery.workspaceConsistency)
  lines.push('')
  lines.push('### 接手后先做什么')
  lines.push('')
  lines.push(recovery.nextActions)
  lines.push('')
  if (sectionsSource) {
    lines.push(
      `> 以下 1–8 节来自${sectionsSource.source === 'ai' ? ' AI 总结草稿' : ' 用户编辑后的草稿'}（生成于 ${iso(
        sectionsSource.generatedAt
      )}）${sectionsSource.stale ? '；**生成后又有新记录，草稿可能过期**' : ''}。事实以证据文件为准。`
    )
    lines.push('')
  } else {
    lines.push('> 以下 1–8 节由确定性规则从会话与 Git 证据生成，未调用模型。')
    lines.push('')
  }
  for (const def of SUMMARY_SECTIONS) {
    lines.push(`## ${SUMMARY_SECTIONS.indexOf(def) + 1}. ${def.title}`)
    lines.push('')
    lines.push(sections[def.key] || '_(空)_')
    lines.push('')
  }
  lines.push('## 证据索引')
  lines.push('')
  lines.push('- `session/excerpt.md`：用户要求与模型公开回复摘录')
  lines.push('- `session/timeline.jsonl`：逐条时间线，含消息/工具 ID')
  lines.push('- `changes/status.txt`：Git 状态、归属判断与提交')
  lines.push('- `changes/diff-staged.patch` / `changes/diff-unstaged.patch`：选定的 diff')
  lines.push('- `files/`：选定的未跟踪/新增或用户要求包含的完整文件')
  lines.push('- `evidence/commands.md`：工具记录中的验证命令与退出码')
  lines.push('- `manifest.json`：来源、捕获时间、版本、文件清单与哈希')
  lines.push('')
  lines.push('## 采集限制')
  lines.push('')
  lines.push('- 只读采集 Z-Code 本地数据库；没有修改源会话、源数据库或 WAL。')
  lines.push('- 不包含模型内部思考、系统注入的 model-only 上下文、登录凭据。')
  lines.push('- 不含完整仓库、依赖目录、构建目录；只包含选定文件与 diff。')
  lines.push('- 敏感信息检测是启发式，不能保证 100% 覆盖；请预览后自行排除。')
  lines.push('- 工具退出码 0 只代表命令当时返回 0，不等于业务正确或已独立复验。')
  lines.push('')
  return lines.join('\n')
}

function buildManifestBase(ctx: PackContext, request: PackRequest, captureIso: string): ManifestPreview {
  return {
    schemaVersion: SCHEMA_VERSION,
    app: { name: APP_NAME, version: '0.1.0' },
    source: {
      kind: 'zcode',
      dbPath: ctx.row.sourceDb,
      sessionId: ctx.row.sessionId,
      sessionTitle: ctx.row.title,
      directory: ctx.row.directory
    },
    capturedAt: captureIso,
    sessionState: ctx.git.snapshotState,
    baseline: ctx.row.baseline.info,
    project: {
      root: ctx.git.projectRoot,
      gitRoot: ctx.git.gitRoot,
      head: ctx.git.head,
      branch: ctx.git.branch,
      attribution: ctx.git.attribution
    },
    fileCount: 0,
    totalBytes: 0,
    files: [],
    excluded: [],
    sensitiveHits: [],
    privacyNotice:
      '本包只包含选定文件与 diff。敏感信息检测为启发式，不能保证 100% 覆盖；发送前请预览并排除不应外发的内容。',
    mode: request.mode,
    recovery: { confidence: 'low', confidenceScore: 0, confidenceReasons: [], signals: [] },
    tokenNote:
      'Token 来自 model_usage（按模型调用尝试累计）。input 含 cache_read，output 含 reasoning；缓存与推理单独展示，不重复相加。'
  }
}

function addHit(hits: SensitiveHit[], path: string, reason: string, source: 'path' | 'content', severity: 'high' | 'medium'): void {
  if (hits.some((h) => h.path === path && h.reason === reason)) return
  hits.push({ path, reason, source, severity })
}

export async function preparePack(ctx: PackContext, request: PackRequest): Promise<PackPlan> {
  const captureIso = iso(Date.now())
  const warnings: string[] = []
  const excluded: ExcludedEntry[] = []
  const sensitiveHits: SensitiveHit[] = []
  const entries: PackEntry[] = []
  const allowSensitive = request.allowSensitive === true

  const allFiles = [...ctx.git.buckets.staged, ...ctx.git.buckets.unstaged, ...ctx.git.buckets.untracked]
  const byPath = new Map<string, GitFile>()
  for (const f of allFiles) byPath.set(f.path, f)
  let selected: GitFile[] = []
  if (request.filePaths.length === 0) {
    // No explicit selection: default to the current Git change set. Without
    // this the pack has empty diffs and the receiver cannot see what changed.
    selected = allFiles.filter((f) => f.selectable && !f.sensitive)
    if (selected.length) {
      warnings.push(`未指定交接文件，已默认包含当前 Git 变更的 ${selected.length} 个可交接文件（不含敏感/构建产物）。`)
    }
  } else {
    for (const p of request.filePaths) {
      const f = byPath.get(p)
      if (!f) {
        warnings.push(`选中的文件不在当前 Git 变更中，已跳过：${p}`)
        continue
      }
      selected.push(f)
    }
  }

  // Diffs first: they are the primary evidence for tracked modifications.
  let diffs = { staged: '', unstaged: '' }
  if (ctx.git.available && ctx.git.gitRoot && selected.length) {
    diffs = await getDiffs(ctx.git.gitRoot, selected)
  }

  entries.push({ path: 'session/excerpt.md', data: Buffer.from(buildExcerpt(ctx, captureIso), 'utf8'), role: 'session' })
  const timelineJsonl = ctx.timeline
    .map((item) => JSON.stringify(item))
    .join('\n')
  entries.push({ path: 'session/timeline.jsonl', data: Buffer.from(timelineJsonl + (timelineJsonl ? '\n' : ''), 'utf8'), role: 'session' })
  entries.push({ path: 'changes/status.txt', data: Buffer.from(buildStatusDoc(ctx), 'utf8'), role: 'change' })
  entries.push({ path: 'changes/diff-staged.patch', data: Buffer.from(diffs.staged || '(无暂存 diff)\n', 'utf8'), role: 'change' })
  entries.push({ path: 'changes/diff-unstaged.patch', data: Buffer.from(diffs.unstaged || '(无未暂存 diff)\n', 'utf8'), role: 'change' })
  const commitLines = ctx.git.commitsSinceBaseline.length
    ? ctx.git.commitsSinceBaseline.map((c) => `${c.hash}\t${c.shortHash}\t${c.author}\t${iso(c.time)}\t${c.subject}`).join('\n')
    : '(观察窗口内没有新提交或无基线)\n'
  entries.push({ path: 'changes/commits.txt', data: Buffer.from(commitLines, 'utf8'), role: 'change' })
  entries.push({ path: 'evidence/commands.md', data: Buffer.from(buildCommandsDoc(ctx), 'utf8'), role: 'evidence' })

  for (const diffText of [diffs.staged, diffs.unstaged]) {
    if (!diffText) continue
    const risk = scanTextContent(diffText)
    for (const reason of risk.reasons) {
      addHit(sensitiveHits, 'changes/diff-*.patch', `${reason}（diff 内容）`, 'content', 'high')
    }
  }
  if (sensitiveHits.some((h) => h.source === 'content')) {
    warnings.push('选定的 diff 中检测到疑似密钥/凭据。已保留 diff 以维持证据完整性，但发送前请人工检查。')
  }

  let totalBytes = entries.reduce((n, e) => n + e.data.length, 0)
  let fileCount = 0
  for (const f of selected) {
    const risk = inspectPath(f.path)
    if (risk.buildArtifact) {
      excluded.push({ path: f.path, reason: '构建/依赖目录，默认排除' })
      continue
    }
    if (risk.sensitive) {
      for (const reason of risk.reasons) addHit(sensitiveHits, f.path, reason, 'path', 'high')
      if (!allowSensitive) {
        excluded.push({ path: f.path, reason: `疑似敏感文件：${risk.reasons.join('、')}` })
        continue
      }
      warnings.push(`按用户要求包含疑似敏感文件：${f.path}`)
    }

    let abs: string
    try {
      abs = safeJoin(ctx.git.projectRoot, f.path)
      assertRegularFileNoSymlink(abs)
      assertRealInside(ctx.git.projectRoot, abs)
    } catch (error) {
      excluded.push({ path: f.path, reason: error instanceof Error ? error.message : '路径检查失败' })
      continue
    }
    let st: ReturnType<typeof statSync>
    try {
      st = statSync(abs)
    } catch {
      excluded.push({ path: f.path, reason: '文件不存在或不可读（删除的文件只保留 diff）' })
      continue
    }
    if (!st.isFile()) {
      excluded.push({ path: f.path, reason: '不是普通文件' })
      continue
    }
    if (st.size > MAX_PACK_FILE_BYTES) {
      excluded.push({ path: f.path, reason: `文件超过 ${formatBytes(MAX_PACK_FILE_BYTES)}，默认排除` })
      continue
    }
    const needsFull = f.bucket === 'untracked' || f.indexStatus === 'A' || request.includeFullFiles
    if (!needsFull) continue
    if (isBinaryFile(abs)) {
      excluded.push({ path: f.path, reason: '二进制文件，默认不写入完整内容（diff 仍保留）' })
      continue
    }
    const contentRisk = scanContent(abs)
    if (contentRisk.sensitive) {
      for (const reason of contentRisk.reasons) addHit(sensitiveHits, f.path, reason, 'content', 'high')
      if (!allowSensitive) {
        excluded.push({ path: f.path, reason: `内容疑似包含凭据：${contentRisk.reasons.join('、')}` })
        continue
      }
      warnings.push(`按用户要求包含内容疑似敏感的文件：${f.path}`)
    }
    const data = readFileSync(abs)
    if (totalBytes + data.length > MAX_PACK_TOTAL_BYTES) {
      excluded.push({ path: f.path, reason: `加入后会超过包大小上限 ${formatBytes(MAX_PACK_TOTAL_BYTES)}` })
      continue
    }
    entries.push({ path: `files/${toPosix(f.path)}`, data, role: 'file' })
    totalBytes += data.length
    fileCount++
  }

  // Tool inputs/outputs can contain credentials even when no file is selected.
  // Scan generated session evidence too; this is a warning, not a guarantee.
  for (const entry of entries) {
    if (entry.role === 'file') continue
    const risk = scanTextContent(entry.data.toString('utf8'))
    for (const reason of risk.reasons) addHit(sensitiveHits, entry.path, `${reason}（会话/证据内容）`, 'content', 'high')
  }
  if (sensitiveHits.some((h) => h.path.startsWith('session/') || h.path.startsWith('evidence/'))) {
    warnings.push('会话摘录、时间线或命令证据中检测到疑似密钥/凭据。发送前必须逐项检查，必要时不要外发该包。')
  }

  const recovery = buildRecoveryBrief(ctx)
  const markdown = buildMarkdown(ctx, request, captureIso, ctx.summary, recovery)
  entries.unshift({ path: 'HANDOFF.md', data: Buffer.from(markdown, 'utf8'), role: 'handoff' })
  totalBytes += Buffer.byteLength(markdown, 'utf8')
  const handoffRisk = scanTextContent(markdown)
  for (const reason of handoffRisk.reasons) addHit(sensitiveHits, 'HANDOFF.md', `${reason}（交接正文）`, 'content', 'high')

  if (ctx.git.snapshotState === 'in_progress') warnings.push('会话仍在执行：这是进行中快照，不是最终结果。')
  if (ctx.git.attribution === 'unknown') warnings.push('缺少起始基线：无法确认全部变更归属。')
  if (ctx.timeline.length >= 5000) warnings.push('时间线超过 5000 条，本包只包含最近 5000 条。')

  const manifest = buildManifestBase(ctx, request, captureIso)
  manifest.excluded = excluded
  manifest.sensitiveHits = sensitiveHits
  manifest.recovery = {
    confidence: recovery.confidence,
    confidenceScore: recovery.confidenceScore,
    confidenceReasons: recovery.confidenceReasons,
    signals: recovery.signals
  }
  return { entries, excluded, sensitiveHits, warnings, markdown, manifest, mode: request.mode, totalBytes, recovery }
}

function walkFiles(root: string, prefix = ''): string[] {
  const out: string[] = []
  for (const entry of readdirSync(path.join(root, prefix), { withFileTypes: true })) {
    const rel = prefix ? `${prefix}/${entry.name}` : entry.name
    const abs = path.join(root, rel)
    const st = statSync(abs, { throwIfNoEntry: false })
    if (!st) continue
    if (st.isSymbolicLink()) continue
    if (st.isDirectory()) out.push(...walkFiles(root, rel))
    else if (st.isFile()) out.push(rel)
  }
  return out
}

export function writePack(plan: PackPlan, stagingDir: string): { manifest: ManifestPreview; files: PackFileEntry[] } {
  mkdirSync(stagingDir, { recursive: true })
  for (const entry of plan.entries) {
    const abs = safeJoin(stagingDir, entry.path)
    mkdirSync(path.dirname(abs), { recursive: true })
    writeFileSync(abs, entry.data)
  }
  const roleByPath = new Map(plan.entries.map((e) => [e.path, e.role]))
  const files: PackFileEntry[] = []
  let total = 0
  for (const rel of walkFiles(stagingDir)) {
    if (rel === 'manifest.json') continue
    const abs = path.join(stagingDir, rel)
    assertRegularFileNoSymlink(abs)
    const data = readFileSync(abs)
    const role = roleByPath.get(rel) || 'evidence'
    files.push({ path: rel, bytes: data.length, sha256: createHash('sha256').update(data).digest('hex'), role })
    total += data.length
  }
  const roleOrder: Record<PackFileEntry['role'], number> = { handoff: 0, session: 1, change: 2, file: 3, evidence: 4 }
  files.sort((a, b) => roleOrder[a.role] - roleOrder[b.role] || a.path.localeCompare(b.path))
  const manifest: ManifestPreview = {
    ...plan.manifest,
    files,
    fileCount: files.length,
    totalBytes: total
  }
  writeFileSync(path.join(stagingDir, 'manifest.json'), JSON.stringify(manifest, null, 2), 'utf8')
  return { manifest, files }
}

export function packDirName(sessionId: string): string {
  const stamp = new Date()
    .toISOString()
    .replace(/[-:]/g, '')
    .replace('T', '-')
    .slice(0, 15)
  return `handoff-${shortId(sessionId)}-${stamp}`
}

export function cleanupDir(dir: string): void {
  try {
    rmSync(dir, { recursive: true, force: true })
  } catch {
    // best effort
  }
}

export function copyPackTo(srcDir: string, destDir: string): void {
  mkdirSync(destDir, { recursive: true })
  for (const rel of walkFiles(srcDir)) {
    const from = safeJoin(srcDir, rel)
    const to = safeJoin(destDir, rel)
    mkdirSync(path.dirname(to), { recursive: true })
    copyFileSync(from, to)
  }
}

export function previewFromPlan(plan: PackPlan, manifest: ManifestPreview): PackPreview {
  return {
    sessionId: manifest.source.sessionId,
    generatedAt: Date.parse(manifest.capturedAt) || Date.now(),
    mode: plan.mode,
    markdown: plan.markdown,
    manifest,
    files: manifest.files,
    excluded: plan.excluded,
    sensitiveHits: plan.sensitiveHits,
    totalBytes: manifest.totalBytes,
    warnings: plan.warnings,
    relayInstruction: relayInstruction(plan.mode),
    recovery: plan.recovery
  }
}

export function fileHash(abs: string): string | null {
  return sha256File(abs)
}

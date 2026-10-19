import React, { useEffect, useMemo, useState } from 'react'
import type {
  AttachedSession,
  GitEvidence,
  GitFile,
  RecoveryBrief,
  SummaryDraft,
  SummarySectionKey,
  TimelineResponse,
  TodoItem
} from '../../../shared/types'
import { SUMMARY_SECTIONS } from '../../../shared/types'
import { formatBytes, formatDateTime, formatNumber, relativeTime, truncate } from '../format'
import { IconAlert, IconCheck, IconCopy, IconFile, IconGit, IconRefresh, IconSparkles } from './Icons'

type Tab = 'recovery' | 'summary' | 'changes' | 'issues'

interface Props {
  attached: AttachedSession
  git: GitEvidence | null
  summary: SummaryDraft | null
  recovery: RecoveryBrief | null
  timeline: TimelineResponse | null
  selected: Set<string>
  busy: string | null
  schemaDetail: string
  onToggleFile: (path: string) => void
  onSelectAll: (mode: 'all' | 'none' | 'window') => void
  onGenerateAI: () => void
  onGenerateTemplate: () => void
  onSaveSummary: (sections: Record<string, string>) => void
  onRefreshGit: () => void
  onCopyRecovery: () => void
  onPreview: () => void
}

export function HandoffPanel(props: Props): React.ReactElement {
  const [tab, setTab] = useState<Tab>('recovery')
  const signalCount = props.recovery ? props.recovery.signals.filter((s) => s.level !== 'info').length : 0
  return (
    <aside className="handoff">
      <div className="handoff-head">
        <div className="handoff-kicker">HANDOFF</div>
        <h2>交接摘要与证据</h2>
        <div className="handoff-tabs">
          <button className={tab === 'recovery' ? 'is-on' : ''} onClick={() => setTab('recovery')}>
            恢复 {signalCount > 0 ? <span className="tab-count warn">{signalCount}</span> : null}
          </button>
          <button className={tab === 'summary' ? 'is-on' : ''} onClick={() => setTab('summary')}>
            摘要
          </button>
          <button className={tab === 'changes' ? 'is-on' : ''} onClick={() => setTab('changes')}>
            变更 {props.git ? <span className="tab-count">{countFiles(props.git)}</span> : null}
          </button>
          <button className={tab === 'issues' ? 'is-on' : ''} onClick={() => setTab('issues')}>
            问题 {issueCount(props) > 0 ? <span className="tab-count warn">{issueCount(props)}</span> : null}
          </button>
        </div>
      </div>
      <div className="handoff-body">
        {tab === 'recovery' ? <RecoveryTab {...props} /> : null}
        {tab === 'summary' ? <SummaryTab {...props} /> : null}
        {tab === 'changes' ? <ChangesTab {...props} /> : null}
        {tab === 'issues' ? <IssuesTab {...props} /> : null}
      </div>
      <div className="handoff-foot">
        <button className="btn btn-primary btn-block" onClick={props.onPreview} disabled={Boolean(props.busy)}>
          预览交接包
        </button>
        <p>摘要可编辑；打包前必须预览内容、大小、排除项与隐私提醒。</p>
      </div>
    </aside>
  )
}

function RecoveryTab(props: Props): React.ReactElement {
  const { recovery, busy } = props
  if (!recovery) return <div className="loading-block">正在生成恢复简报…</div>
  const confidence = recovery.confidence === 'high' ? '高' : recovery.confidence === 'medium' ? '中' : '低'
  return (
    <div className="recovery">
      <div className="recovery-top">
        <span className={`conf conf-${recovery.confidence}`}>可信度 {confidence}</span>
        <span className="muted">{formatDateTime(recovery.generatedAt)}</span>
        <button className="text-btn" onClick={props.onCopyRecovery}>
          <IconCopy size={11} /> 复制简报
        </button>
      </div>
      <p className="recovery-lede">
        这份简报回答：最新目标、已完成证据、失败过的路线、工作区是否一致、接手先做什么。由确定性规则生成，未调用模型。
      </p>

      <div className="signal-list">
        {recovery.signals.length === 0 ? (
          <div className="signal signal-info">
            <span className="signal-dot" />
            <div>
              <b>没有检测到明确的卡住/交付缺失信号</b>
              <p>这不等于任务完成；仍需按下面的证据核对。</p>
            </div>
          </div>
        ) : null}
        {recovery.signals.map((signal) => (
          <div className={`signal signal-${signal.level}`} key={signal.id}>
            <span className="signal-dot" />
            <div>
              <b>{signal.title}</b>
              <p>{signal.detail}</p>
            </div>
          </div>
        ))}
      </div>

      <RecoveryBlock index="01" title="最新目标" body={recovery.latestGoal} />
      {recovery.olderRequirements ? (
        <details className="older-req">
          <summary>较早的用户要求（可能已失效）</summary>
          <pre>{recovery.olderRequirements}</pre>
        </details>
      ) : null}
      <RecoveryBlock index="02" title="已完成与可核对证据" body={recovery.completedEvidence} />
      <RecoveryBlock index="03" title="失败过的路线" body={recovery.failedAttempts} />
      <RecoveryBlock index="04" title="工作区一致性" body={recovery.workspaceConsistency} />
      <RecoveryBlock index="05" title="接手后先做什么" body={recovery.nextActions} />

      {recovery.incompleteTodos.length ? (
        <section className="recovery-todos">
          <h4>未完成待办 <span>{recovery.incompleteTodos.length}</span></h4>
          {recovery.incompleteTodos.map((todo) => (
            <TodoRow todo={todo} key={`${todo.position}-${todo.content}`} />
          ))}
        </section>
      ) : (
        <p className="fine">没有未完成的待办记录。</p>
      )}

      <div className="recovery-actions">
        <button className="btn btn-ghost btn-small" onClick={props.onCopyRecovery} disabled={Boolean(busy)}>
          <IconCopy size={12} /> 复制恢复简报
        </button>
        <span className="fine">预览与导出在底部；简报本身不是证据，证据在下方文件里。</span>
      </div>
    </div>
  )
}

function RecoveryBlock({ index, title, body }: { index: string; title: string; body: string }): React.ReactElement {
  return (
    <section className="recovery-block">
      <div className="recovery-block-head">
        <span className="recovery-index">{index}</span>
        <h4>{title}</h4>
      </div>
      <div className="recovery-body">{body}</div>
    </section>
  )
}

function TodoRow({ todo }: { todo: TodoItem }): React.ReactElement {
  const status = todo.status === 'in_progress' ? '进行中' : todo.status === 'pending' ? '待处理' : todo.status
  return (
    <div className={`todo-row todo-${todo.status}`}>
      <span className={`todo-status ${todo.status}`}>{status}</span>
      <span className="todo-content">{todo.content}</span>
      <span className="todo-priority">{todo.priority}</span>
    </div>
  )
}

function SummaryTab(props: Props): React.ReactElement {
  const { summary, busy } = props
  const [draft, setDraft] = useState<Record<SummarySectionKey, string>>(emptySections())
  const [dirty, setDirty] = useState(false)

  useEffect(() => {
    if (summary) {
      setDraft({ ...emptySections(), ...summary.sections })
      setDirty(false)
    }
  }, [summary])

  if (!summary) {
    return (
      <div className="summary-empty">
        <div className="summary-mark"><IconSparkles size={22} /></div>
        <h3>还没有交接摘要</h3>
        <p>AI 总结只在你点击时调用模型，不会因为新增日志自动请求。</p>
        <div className="stack-actions">
          <button className="btn btn-primary" onClick={props.onGenerateAI} disabled={Boolean(busy)}>
            {busy === 'summary' ? '正在生成…' : '生成 AI 总结'}
          </button>
          <button className="btn btn-ghost" onClick={props.onGenerateTemplate} disabled={Boolean(busy)}>
            只生成确定性草稿
          </button>
        </div>
        <p className="fine">没有配置模型时，确定性草稿和交接包仍然可用。</p>
      </div>
    )
  }

  const sourceLabel =
    summary.source === 'ai'
      ? 'AI 草稿'
      : summary.source === 'edited-ai'
        ? 'AI 草稿 · 已编辑'
        : summary.source === 'edited-template'
          ? '确定性草稿 · 已编辑'
          : '确定性草稿'

  return (
    <div className="summary-editor">
      <div className="summary-meta">
        <span className={`tag ${summary.source.includes('ai') ? 'tag-ai' : 'tag-quiet'}`}>{sourceLabel}</span>
        <span className="muted">{formatDateTime(summary.generatedAt)}</span>
        {summary.model ? <span className="muted">· {summary.model}</span> : null}
      </div>
      {summary.stale ? (
        <div className="inline-warn">
          <IconAlert size={13} />
          生成摘要后又有新记录或文件变化，草稿可能过期。建议重新生成，或保存前逐条核对。
        </div>
      ) : null}
      {summary.error ? <div className="inline-note">{summary.error}</div> : null}
      <div className="citation-line">
        <IconCheck size={12} />
        引用核对：{summary.citations.resolved}/{summary.citations.total}
        {summary.citations.unresolved.length ? `，${summary.citations.unresolved.length} 个未匹配` : ''}
        <span className="muted"> · 事实以证据文件为准</span>
      </div>

      <div className="summary-actions">
        <button className="btn btn-ghost btn-small" onClick={props.onGenerateAI} disabled={Boolean(busy)}>
          {busy === 'summary' ? '生成中…' : '重新生成 AI'}
        </button>
        <button className="btn btn-ghost btn-small" onClick={props.onGenerateTemplate} disabled={Boolean(busy)}>
          确定性草稿
        </button>
        <button
          className="btn btn-small"
          disabled={!dirty || Boolean(busy)}
          onClick={() => {
            props.onSaveSummary(draft)
            setDirty(false)
          }}
        >
          保存草稿
        </button>
      </div>

      {SUMMARY_SECTIONS.map((def, index) => (
        <section className="summary-section" key={def.key}>
          <div className="summary-section-head">
            <span className="summary-index">{String(index + 1).padStart(2, '0')}</span>
            <div>
              <h4>{def.title}</h4>
              <p>{def.hint}</p>
            </div>
          </div>
          <textarea
            value={draft[def.key] || ''}
            onChange={(e) => {
              setDraft({ ...draft, [def.key]: e.target.value })
              setDirty(true)
            }}
            spellCheck={false}
            rows={Math.min(14, Math.max(4, Math.ceil((draft[def.key] || '').length / 46)))}
          />
        </section>
      ))}
      {summary.citations.unresolved.length ? (
        <div className="inline-warn">
          <IconAlert size={13} />
          未匹配引用：{summary.citations.unresolved.slice(0, 6).join('、')}
          {summary.citations.unresolved.length > 6 ? '…' : ''}
        </div>
      ) : null}
    </div>
  )
}

function ChangesTab(props: Props): React.ReactElement {
  const { git, attached, selected, busy } = props
  if (!git) return <div className="loading-block">正在读取 Git 状态…</div>
  if (!git.available) {
    return (
      <div className="summary-empty">
        <div className="summary-mark"><IconGit size={22} /></div>
        <h3>Git 不可用</h3>
        <p>{git.reason || '所选目录不是 Git 工作区。'}</p>
        <p className="fine">没有 Git 时仍可生成会话交接包，但无法展示 diff 和变更归属。</p>
        <button className="btn btn-ghost btn-small" onClick={props.onRefreshGit} disabled={Boolean(busy)}>
          重试
        </button>
      </div>
    )
  }

  const all = dedupeFiles(git)
  const selectedBytes = all.filter((f) => selected.has(f.path)).reduce((n, f) => n + (f.size || 0), 0)
  const groups: Array<[string, GitFile[]]> = [
    ['暂存', git.buckets.staged],
    ['未暂存', git.buckets.unstaged],
    ['未跟踪', git.buckets.untracked]
  ]

  return (
    <div className="changes">
      <div className={`attrib attrib-${git.attribution}`}>
        <div className="attrib-head">
          <IconGit size={14} />
          <b>{git.attribution === 'unknown' ? '无法确认全部变更归属' : '变更归属：部分可判断'}</b>
          <button className="icon-btn icon-btn-tiny" title="刷新 Git" onClick={props.onRefreshGit}>
            <IconRefresh size={12} />
          </button>
        </div>
        <p>{git.attributionNote}</p>
        <div className="attrib-meta">
          <span>{git.branch || '未知分支'}</span>
          <span className="dot-sep">·</span>
          <span>{git.head ? git.head.slice(0, 8) : '无 HEAD'}</span>
          <span className="dot-sep">·</span>
          <span>{git.snapshotState === 'in_progress' ? '进行中快照' : '无进行中的 turn'}</span>
        </div>
        <div className="attrib-baseline">
          基线：{attached.baseline.hasBaseline ? `${formatDateTime(attached.baseline.capturedAt)} · ${attached.baseline.head?.slice(0, 8) || '无 HEAD'}` : '未记录（归属未知）'}
        </div>
      </div>

      <div className="select-bar">
        <span>
          已选 {selected.size} / {all.filter((f) => f.selectable).length} 个文件 · 约 {formatBytes(selectedBytes)}
        </span>
        <div className="select-actions">
          <button className="text-btn" onClick={() => props.onSelectAll('all')}>全选可交接</button>
          <button className="text-btn" onClick={() => props.onSelectAll('window')}>只选窗口内变化</button>
          <button className="text-btn" onClick={() => props.onSelectAll('none')}>清空</button>
        </div>
      </div>

      {groups.map(([label, files]) => (
        <section className="file-group" key={label}>
          <h4>
            {label} <span>{files.length}</span>
          </h4>
          {files.length === 0 ? <p className="fine">无</p> : null}
          {files.map((f) => (
            <FileRow
              key={`${label}-${f.path}`}
              file={f}
              checked={selected.has(f.path)}
              onToggle={() => props.onToggleFile(f.path)}
            />
          ))}
        </section>
      ))}

      {git.diffStat.staged || git.diffStat.unstaged ? (
        <details className="diff-stat">
          <summary>Diff 统计</summary>
          <pre>{[git.diffStat.staged, git.diffStat.unstaged].filter(Boolean).join('\n')}</pre>
        </details>
      ) : null}

      {git.commitsSinceBaseline.length ? (
        <section className="file-group">
          <h4>观察窗口内的提交 <span>{git.commitsSinceBaseline.length}</span></h4>
          {git.commitsSinceBaseline.map((c) => (
            <div className="commit-row" key={c.hash}>
              <code>{c.shortHash}</code>
              <span>{truncate(c.subject, 80)}</span>
              <span className="muted">{c.author}</span>
            </div>
          ))}
        </section>
      ) : null}
    </div>
  )
}

function FileRow({ file, checked, onToggle }: { file: GitFile; checked: boolean; onToggle: () => void }): React.ReactElement {
  const disabled = !file.selectable
  return (
    <label className={`file-row ${checked ? 'is-checked' : ''} ${disabled ? 'is-disabled' : ''}`} title={file.excludedReason || file.path}>
      <input type="checkbox" checked={checked} disabled={disabled} onChange={onToggle} />
      <IconFile size={13} />
      <span className="file-path">{file.path}</span>
      <span className="file-tags">
        {file.sensitive ? <span className="tag tag-danger">敏感</span> : null}
        {file.preExisting ? <span className="tag tag-quiet">接入前已有</span> : null}
        {file.changedSinceBaseline ? <span className="tag tag-warn">窗口内变化</span> : null}
        {file.attribution === 'unknown' ? <span className="tag tag-quiet">归属未知</span> : null}
        <span className="file-size">{formatBytes(file.size)}</span>
      </span>
    </label>
  )
}

function IssuesTab(props: Props): React.ReactElement {
  const { attached, git, timeline, summary } = props
  const issues = useMemo(() => buildIssues(props), [props])
  return (
    <div className="issues">
      {issues.length === 0 ? (
        <div className="summary-empty">
          <div className="summary-mark"><IconCheck size={22} /></div>
          <h3>没有检测到明确问题</h3>
          <p>这不等于没有问题：仍未独立复验，执行者的完成声明仍需核查。</p>
        </div>
      ) : null}
      {issues.map((issue) => (
        <div className={`issue issue-${issue.level}`} key={issue.title}>
          <div className="issue-head">
            <IconAlert size={13} />
            <b>{issue.title}</b>
          </div>
          <p>{issue.body}</p>
        </div>
      ))}

      <section className="next-checks">
        <h4>建议接手者先检查</h4>
        <ol>
          <li>读 HANDOFF.md 与 session/excerpt.md，确认目标与后续要求。</li>
          <li>查看 changes/diff-*.patch 与 changes/status.txt，核对变更范围和归属提示。</li>
          <li>重跑 evidence/commands.md 里的关键命令，核对退出码，不采信“测试通过”的自述。</li>
          <li>逐条核查“收尾陈述（未核实）”，确认哪些确实有证据。</li>
        </ol>
      </section>

      <section className="evidence-facts">
        <h4>当前证据</h4>
        <dl>
          <div><dt>记录</dt><dd>{timeline ? `${formatNumber(timeline.totals.user)} / ${formatNumber(timeline.totals.assistant)} / ${formatNumber(timeline.totals.tool)}` : '—'}</dd></div>
          <div><dt>状态</dt><dd>{attached.live.label}</dd></div>
          <div><dt>最后同步</dt><dd>{relativeTime(attached.lastSyncAt)}</dd></div>
          <div><dt>摘要</dt><dd>{summary ? (summary.stale ? '可能过期' : '已生成') : '未生成'}</dd></div>
          <div><dt>Git 归属</dt><dd>{git?.attribution || '—'}</dd></div>
        </dl>
      </section>
    </div>
  )
}

function buildIssues(props: Props): Array<{ level: 'warn' | 'danger' | 'info'; title: string; body: string }> {
  const { attached, git, timeline, summary, schemaDetail } = props
  const issues: Array<{ level: 'warn' | 'danger' | 'info'; title: string; body: string }> = []
  if (!attached.baseline.hasBaseline) {
    issues.push({
      level: 'danger',
      title: '缺少起始基线',
      body: '接入时没有记录 Git 基线，无法判断哪些修改是接入后产生的。所有文件都只能标记为“归属未知”。'
    })
  } else {
    issues.push({
      level: 'info',
      title: '归属只能部分判断',
      body: git?.attributionNote || '可以区分接入前已有修改与观察窗口内变化，但无法区分窗口内是 Agent 还是用户操作。'
    })
  }
  if (attached.live.state === 'running') {
    issues.push({ level: 'warn', title: '会话仍在执行', body: '当前生成的是进行中快照，不是最终结果。' })
  }
  if (attached.syncError) {
    issues.push({ level: 'danger', title: '最近一次读取失败', body: attached.syncError })
  }
  const errors = timeline?.items.filter((i) => i.kind === 'tool' && (i.status === 'error' || (i.exitCode !== null && i.exitCode !== 0))) || []
  if (errors.length) {
    issues.push({ level: 'warn', title: `工具错误 ${errors.length} 条`, body: '失败命令不代表整体失败，但需要接手者确认是否已修复。' })
  }
  const claims = timeline?.items.filter((i) => i.kind === 'assistant' && i.isFinalStatement).length || 0
  if (claims) {
    issues.push({ level: 'warn', title: `${claims} 条收尾陈述未经核实`, body: '这些是执行者原话，不是系统验证结果。' })
  }
  const sensitive = git ? dedupeFiles(git).filter((f) => f.sensitive).length : 0
  if (sensitive) {
    issues.push({ level: 'warn', title: `${sensitive} 个疑似敏感文件`, body: '默认不会写入交接包；预览时仍应人工检查 diff 和已选文件。' })
  }
  if (!summary) {
    issues.push({ level: 'info', title: '尚未生成摘要', body: '可以直接使用确定性交接包；AI 总结只是可编辑草稿，不取代原始证据。' })
  } else if (summary.stale) {
    issues.push({ level: 'warn', title: '摘要可能过期', body: '生成摘要后又有新记录或文件变化，发送前建议重新生成或核对。' })
  }
  if (props.timeline?.hasMore) {
    issues.push({ level: 'info', title: '时间线已截断', body: '只载入了最近 5000 条记录，更早记录未包含在本次交接包。' })
  }
  if (/降级|缺列|缺少可选表/.test(schemaDetail)) {
    issues.push({ level: 'info', title: 'Z-Code 数据结构降级', body: schemaDetail })
  }
  return issues
}

function issueCount(props: Props): number {
  return buildIssues({ ...props, summary: props.summary }).filter((i) => i.level !== 'info').length
}

function dedupeFiles(git: GitEvidence): GitFile[] {
  const map = new Map<string, GitFile>()
  for (const f of [...git.buckets.staged, ...git.buckets.unstaged, ...git.buckets.untracked]) map.set(f.path, f)
  return [...map.values()]
}

function countFiles(git: GitEvidence): number {
  return dedupeFiles(git).length
}

function emptySections(): Record<SummarySectionKey, string> {
  return {
    goal: '',
    changes: '',
    state: '',
    files: '',
    verification: '',
    claims: '',
    open: '',
    next: ''
  }
}

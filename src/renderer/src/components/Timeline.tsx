import React, { useMemo, useState } from 'react'
import type { TimelineItem, TimelineResponse } from '../../../shared/types'
import { formatNumber, formatTime, statusLabel, tokenSummary, toolSummary, truncate } from '../format'
import { IconAlert, IconChevron, IconCopy, IconRefresh, IconTerminal } from './Icons'

type Filter = 'all' | 'user' | 'assistant' | 'tool' | 'system'

interface Props {
  timeline: TimelineResponse | null
  loading: boolean
  onRefresh: () => void
  onCopy: (text: string) => void
}

export function TimelinePane({ timeline, loading, onRefresh, onCopy }: Props): React.ReactElement {
  const [filter, setFilter] = useState<Filter>('all')
  const [expanded, setExpanded] = useState<Set<string>>(new Set())

  const filtered = useMemo(() => {
    if (!timeline) return []
    if (filter === 'all') return timeline.items
    return timeline.items.filter((item) => item.kind === filter)
  }, [timeline, filter])

  const groups = useMemo(() => groupItems(filtered), [filtered])

  const toggle = (id: string): void => {
    setExpanded((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  if (!timeline) {
    return (
      <section className="timeline-pane">
        <div className="pane-empty">
          <div className="empty-mark">◌</div>
          <h3>{loading ? '正在读取会话…' : '选择一个已接入会话'}</h3>
          <p>左侧接入后，这里会按时间显示用户要求、模型公开回复、工具调用与执行结果。</p>
          <p className="muted">模型内部思考、系统注入内容不会出现在这里。</p>
        </div>
      </section>
    )
  }

  return (
    <section className="timeline-pane">
      <header className="timeline-head">
        <div className="timeline-stats">
          <span><b>{formatNumber(timeline.totals.user)}</b> 用户</span>
          <span><b>{formatNumber(timeline.totals.assistant)}</b> 回复</span>
          <span><b>{formatNumber(timeline.totals.tool)}</b> 工具</span>
          <span className="timeline-token" title={timeline.tokenNote}>
            ↑ {formatNumber(timeline.tokens.input)} ↓ {formatNumber(timeline.tokens.output)}
            {timeline.tokens.cacheRead ? ` · 缓存 ${formatNumber(timeline.tokens.cacheRead)}` : ''}
          </span>
        </div>
        <div className="timeline-tools">
          <div className="segmented">
            {([
              ['all', '全部'],
              ['user', '用户'],
              ['assistant', '回复'],
              ['tool', '工具'],
              ['system', '运行时']
            ] as Array<[Filter, string]>).map(([key, label]) => (
              <button key={key} className={filter === key ? 'is-on' : ''} onClick={() => setFilter(key)}>
                {label}
              </button>
            ))}
          </div>
          <button className="icon-btn" onClick={onRefresh} title="手动刷新">
            <IconRefresh size={15} />
          </button>
        </div>
      </header>

      <div className="timeline-scroll">
        {timeline.hasMore ? (
          <div className="timeline-note">仅显示最近 5000 条记录；更早内容未载入。</div>
        ) : null}
        {groups.length === 0 ? (
          <div className="timeline-blank">当前筛选下没有记录。</div>
        ) : null}
        {groups.map((group, index) => {
          const user = group.items.find((i) => i.kind === 'user')
          const usage = group.items.reduce(
            (acc, i) => {
              if (i.usage) {
                acc.input += i.usage.input
                acc.output += i.usage.output
                acc.cache += i.usage.cacheRead
              }
              return acc
            },
            { input: 0, output: 0, cache: 0 }
          )
          const running = group.items.some((i) => i.status === 'running')
          return (
            <div className="turn" key={group.key}>
              <div className="turn-head">
                <span className="turn-index">TURN {String(index + 1).padStart(2, '0')}</span>
                <span className="turn-time">{formatTime(group.time)}</span>
                {user?.model ? <span className="turn-model">{user.model.modelId}</span> : null}
                {usage.input || usage.output ? (
                  <span className="turn-usage">{tokenSummary(usage.input, usage.output, usage.cache)}</span>
                ) : null}
                {running ? <span className="tag tag-live">执行中</span> : null}
              </div>
              {group.items.map((item) => {
                if (item.kind === 'tool') {
                  return (
                    <ToolRow
                      key={item.id}
                      item={item}
                      open={expanded.has(item.id)}
                      onToggle={() => toggle(item.id)}
                      onCopy={onCopy}
                    />
                  )
                }
                if (item.kind === 'system') {
                  return (
                    <div className="system-row" key={item.id}>
                      <span className="system-rule" />
                      <span>{item.text}</span>
                      <span className="system-note">{item.note}</span>
                    </div>
                  )
                }
                return (
                  <MessageRow
                    key={item.id}
                    item={item}
                    open={expanded.has(item.id)}
                    onToggle={() => toggle(item.id)}
                    onCopy={onCopy}
                  />
                )
              })}
            </div>
          )
        })}
      </div>
    </section>
  )
}

function groupItems(items: TimelineItem[]): Array<{ key: string; turnId: string | null; time: number; items: TimelineItem[] }> {
  const groups: Array<{ key: string; turnId: string | null; time: number; items: TimelineItem[] }> = []
  let current: (typeof groups)[number] | null = null
  for (const item of items) {
    const startsNew = !current || item.kind === 'user' || (item.turnId && current.turnId && item.turnId !== current.turnId)
    if (startsNew) {
      current = { key: `${item.turnId || item.messageId}-${item.id}`, turnId: item.turnId, time: item.time, items: [] }
      groups.push(current)
    }
    current!.items.push(item)
  }
  return groups
}

function MessageRow({
  item,
  open,
  onToggle,
  onCopy
}: {
  item: TimelineItem
  open: boolean
  onToggle: () => void
  onCopy: (text: string) => void
}): React.ReactElement {
  const text = item.text || ''
  const long = text.length > 1400
  const shown = open || !long ? text : truncate(text, 1400)
  const isUser = item.kind === 'user'
  return (
    <article className={`msg ${isUser ? 'msg-user' : 'msg-assistant'}`}>
      <div className="msg-head">
        <span className={`msg-label ${isUser ? 'is-user' : 'is-assistant'}`}>{isUser ? '用户要求' : '模型公开回复'}</span>
        <span className="msg-time">{formatTime(item.time)}</span>
        {!isUser && item.model ? <span className="msg-model">{item.model.modelId}</span> : null}
        {!isUser && item.usage ? (
          <span className="msg-usage" title="输入含缓存读取；输出含推理 Token">
            {tokenSummary(item.usage.input, item.usage.output, item.usage.cacheRead)}
          </span>
        ) : null}
        {item.isFinalStatement ? <span className="tag tag-claim">收尾陈述 · 未核实</span> : null}
        <button className="icon-btn icon-btn-tiny" title="复制原文" onClick={() => onCopy(text)}>
          <IconCopy size={12} />
        </button>
      </div>
      <div className={`msg-body ${long && !open ? 'is-clipped' : ''}`}>{shown}</div>
      {long ? (
        <button className="text-btn" onClick={onToggle}>
          {open ? '收起' : `展开全文（${formatNumber(text.length)} 字符）`}
        </button>
      ) : null}
    </article>
  )
}

function ToolRow({
  item,
  open,
  onToggle,
  onCopy
}: {
  item: TimelineItem
  open: boolean
  onToggle: () => void
  onCopy: (text: string) => void
}): React.ReactElement {
  const summary = toolSummary(item.input)
  const status = item.status || 'pending'
  const hasDetail = Boolean(item.input || item.output || item.error)
  return (
    <article className={`tool ${status === 'error' ? 'tool-error' : ''}`}>
      <button className="tool-line" onClick={hasDetail ? onToggle : undefined}>
        <span className={`tool-dot tool-${status}`} />
        <span className="tool-name">{item.toolName || 'tool'}</span>
        <span className="tool-call-tag">调用</span>
        <span className="tool-summary" title={summary}>
          {summary || '(无参数摘要)'}
        </span>
        <span className="tool-meta">
          {[
            item.readOnly ? '只读' : null,
            item.destructive ? '破坏性' : null,
            item.exitCode !== null && item.exitCode !== undefined ? `退出 ${item.exitCode}` : null,
            item.durationMs !== null && item.durationMs !== undefined ? `${item.durationMs} ms` : null
          ]
            .filter(Boolean)
            .join(' · ')}
          {item.readOnly || item.destructive || item.exitCode !== null || item.durationMs !== null ? ' · ' : ''}
          <span className={`status status-${status}`}>{statusLabel(status)}</span>
        </span>
        {hasDetail ? <IconChevron size={12} className={open ? 'chev open' : 'chev'} /> : null}
      </button>
      {open ? (
        <div className="tool-detail">
          <div className="tool-section">
            <div className="tool-section-head">
              <span>调用参数</span>
              <button className="text-btn" onClick={() => onCopy(JSON.stringify(item.input, null, 2))}>
                复制
              </button>
            </div>
            <pre>{JSON.stringify(item.input, null, 2) || '(无)'}</pre>
          </div>
          <div className="tool-section">
            <div className="tool-section-head">
              <span>执行结果</span>
              <span className="tool-result-meta">
                {item.outputBytes ? `${formatNumber(item.outputBytes)} bytes` : ''}
                {item.truncated ? ' · 已截断' : ''}
              </span>
              <button className="text-btn" onClick={() => onCopy(item.error || item.output || '')}>
                复制
              </button>
            </div>
            {item.error ? (
              <pre className="pre-error">{item.error}</pre>
            ) : (
              <pre>{item.output || '(无输出)'}</pre>
            )}
          </div>
        </div>
      ) : null}
    </article>
  )
}

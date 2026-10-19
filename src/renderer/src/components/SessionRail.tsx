import React, { useState } from 'react'
import type { AttachedSession } from '../../../shared/types'
import { basename, formatNumber, relativeTime } from '../format'
import { IconDot, IconLock, IconPause, IconPlay, IconPlus, IconX } from './Icons'

interface Props {
  attached: AttachedSession[]
  activeId: string | null
  schemaOk: boolean
  schemaDetail: string
  onSelect: (id: string) => void
  onAttach: () => void
  onPause: (id: string, paused: boolean) => void
  onDetach: (id: string) => void
}

export function SessionRail({ attached, activeId, schemaOk, schemaDetail, onSelect, onAttach, onPause, onDetach }: Props): React.ReactElement {
  const [confirming, setConfirming] = useState<string | null>(null)

  return (
    <aside className="rail">
      <div className="rail-head">
        <div>
          <div className="rail-kicker">OBSERVED</div>
          <h2>已接入会话</h2>
        </div>
        <button className="rail-add" onClick={onAttach} title="接入一个 Z-Code 会话">
          <IconPlus />
        </button>
      </div>

      <div className="rail-list">
        {attached.length === 0 ? (
          <div className="rail-empty">
            <p>还没有接入会话。</p>
            <p className="muted">选择一个 Z-Code 会话后，接力台只读采集它的新记录。</p>
            <button className="btn btn-ghost btn-small" onClick={onAttach}>
              接入第一个会话
            </button>
          </div>
        ) : null}
        {attached.map((session) => {
          const active = session.sessionId === activeId
          const live = session.live
          return (
            <article
              key={session.sessionId}
              className={`rail-card ${active ? 'is-active' : ''}`}
              onClick={() => onSelect(session.sessionId)}
            >
              <div className="rail-card-top">
                <span className={`live-dot live-${live.state}`}>
                  <IconDot size={7} />
                </span>
                <span className="rail-title">{session.title || '未命名会话'}</span>
                {session.paused ? <span className="tag tag-quiet">已暂停</span> : null}
              </div>
              <div className="rail-path" title={session.projectRoot}>
                {basename(session.projectRoot)}
                {session.projectRoot !== session.directory ? <span className="rail-sub"> · 项目目录已改</span> : null}
              </div>
              <div className="rail-meta">
                <span>{relativeTime(session.lastSyncAt || session.attachedAt)}</span>
                <span className="dot-sep">·</span>
                <span>{formatNumber(session.eventCount)} 条记录</span>
              </div>
              {session.model ? (
                <div className="rail-model" title={`${session.model.providerId}/${session.model.modelId}`}>
                  {session.model.modelId}
                  {session.model.variant ? ` · ${session.model.variant}` : ''}
                </div>
              ) : null}
              <div className="rail-actions" onClick={(e) => e.stopPropagation()}>
                <button
                  className="icon-btn icon-btn-small"
                  title={session.paused ? '恢复观察' : '暂停观察'}
                  onClick={() => onPause(session.sessionId, !session.paused)}
                >
                  {session.paused ? <IconPlay size={13} /> : <IconPause size={13} />}
                </button>
                {confirming === session.sessionId ? (
                  <button
                    className="rail-confirm"
                    onClick={() => {
                      setConfirming(null)
                      onDetach(session.sessionId)
                    }}
                  >
                    确认移除
                  </button>
                ) : (
                  <button
                    className="icon-btn icon-btn-small"
                    title="移除接入（不删除源会话与记录）"
                    onClick={() => setConfirming(session.sessionId)}
                  >
                    <IconX size={13} />
                  </button>
                )}
              </div>
            </article>
          )
        })}
      </div>

      <div className="rail-foot">
        <div className={`schema-line ${schemaOk ? 'ok' : 'bad'}`}>
          <IconLock size={12} />
          <span>{schemaOk ? '只读连接正常' : 'Z-Code 结构不可用'}</span>
        </div>
        <p className="rail-foot-note" title={schemaDetail}>
          {schemaOk ? '不修改源会话、数据库与 WAL' : schemaDetail}
        </p>
      </div>
    </aside>
  )
}

import React, { useEffect, useMemo, useState } from 'react'
import type { AttachedSession, SessionSummary } from '../../../shared/types'
import { formatDateTime, relativeTime } from '../format'
import { Modal } from './Modal'
import { IconFolder, IconLock } from './Icons'

interface Props {
  attached: AttachedSession[]
  onClose: () => void
  onAttached: (session: AttachedSession) => void
  onError: (message: string) => void
}

export function AttachDialog({ attached, onClose, onAttached, onError }: Props): React.ReactElement {
  const [sessions, setSessions] = useState<SessionSummary[]>([])
  const [loading, setLoading] = useState(true)
  const [query, setQuery] = useState('')
  const [selected, setSelected] = useState<SessionSummary | null>(null)
  const [projectRoot, setProjectRoot] = useState('')
  const [attaching, setAttaching] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let alive = true
    window.relay
      .listSessions()
      .then((result) => {
        if (!alive) return
        setSessions(result.sessions)
        if (result.error) setError(result.error)
      })
      .finally(() => alive && setLoading(false))
    return () => {
      alive = false
    }
  }, [])

  const attachedIds = useMemo(() => new Set(attached.map((a) => a.sessionId)), [attached])
  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase()
    if (!q) return sessions
    return sessions.filter((s) => s.title.toLowerCase().includes(q) || s.directory.toLowerCase().includes(q))
  }, [sessions, query])

  const choose = (session: SessionSummary): void => {
    setSelected(session)
    setProjectRoot(session.directory)
    setError(null)
  }

  const chooseProject = async (): Promise<void> => {
    const chosen = await window.relay.chooseProjectRoot(projectRoot)
    if (chosen) setProjectRoot(chosen)
  }

  const attach = async (): Promise<void> => {
    if (!selected) return
    setAttaching(true)
    setError(null)
    try {
      const session = await window.relay.attachSession({ sessionId: selected.id, projectRoot })
      onAttached(session)
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e)
      setError(message)
      onError(message)
    } finally {
      setAttaching(false)
    }
  }

  return (
    <Modal
      title="接入 Z-Code 会话"
      subtitle="只读采集；不会修改源会话、数据库或 WAL。不会自动扫描全部历史会话。"
      width={920}
      onClose={onClose}
      footer={
        <>
          <div className="foot-note">
            {selected ? `已选：${selected.title || '未命名会话'}` : '先选择一个会话'}
          </div>
          <div className="foot-actions">
            <button className="btn btn-ghost" onClick={onClose}>取消</button>
            <button className="btn btn-primary" onClick={attach} disabled={!selected || attaching || attachedIds.has(selected?.id || '')}>
              {attaching ? '接入中…' : attachedIds.has(selected?.id || '') ? '已接入' : '接入并开始观察'}
            </button>
          </div>
        </>
      }
    >
      <div className="attach-layout">
        <div className="attach-list-wrap">
          <div className="search-row">
            <input
              className="input"
              placeholder="搜索标题或目录…"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              autoFocus
            />
            <span className="muted">{filtered.length} 个顶层会话</span>
          </div>
          <div className="attach-list">
            {loading ? <div className="loading-block">正在读取 Z-Code 会话列表…</div> : null}
            {!loading && filtered.length === 0 ? <div className="loading-block">没有匹配的会话。</div> : null}
            {filtered.map((session) => {
              const isAttached = attachedIds.has(session.id)
              return (
                <button
                  key={session.id}
                  className={`attach-item ${selected?.id === session.id ? 'is-on' : ''}`}
                  onClick={() => choose(session)}
                >
                  <div className="attach-item-top">
                    <span className="attach-title">{session.title || '(未命名会话)'}</span>
                    {isAttached ? <span className="tag tag-ok">已接入</span> : null}
                    {session.archived ? <span className="tag tag-quiet">已归档</span> : null}
                    {session.taskType !== 'interactive' ? <span className="tag tag-quiet">{session.taskType}</span> : null}
                  </div>
                  <div className="attach-dir" title={session.directory}>{session.directory}</div>
                  <div className="attach-meta">
                    <span>{relativeTime(session.updatedAt)}</span>
                    <span className="dot-sep">·</span>
                    <span>{session.model ? `${session.model.modelId}` : '模型未知'}</span>
                    {session.childSessionCount ? (
                      <>
                        <span className="dot-sep">·</span>
                        <span>{session.childSessionCount} 个子 Agent 会话</span>
                      </>
                    ) : null}
                  </div>
                </button>
              )
            })}
          </div>
        </div>

        <div className="attach-detail">
          <div className="detail-head">
            <IconLock size={14} />
            <span>接入设置</span>
          </div>
          {selected ? (
            <>
              <dl className="kv">
                <div><dt>会话 ID</dt><dd className="mono">{selected.id}</dd></div>
                <div><dt>工作目录</dt><dd className="mono break">{selected.directory}</dd></div>
                <div><dt>最后更新</dt><dd>{formatDateTime(selected.updatedAt)}</dd></div>
                <div><dt>创建时间</dt><dd>{formatDateTime(selected.createdAt)}</dd></div>
                <div><dt>Z-Code 版本</dt><dd>{selected.version || '未知'}</dd></div>
              </dl>
              <label className="field-label">项目目录（用于 Git 变更与打包）</label>
              <div className="path-picker">
                <input className="input mono" value={projectRoot} onChange={(e) => setProjectRoot(e.target.value)} />
                <button className="btn btn-ghost btn-small" onClick={chooseProject}>
                  <IconFolder size={13} /> 选择
                </button>
              </div>
              {projectRoot !== selected.directory ? (
                <div className="inline-warn">
                  项目目录与会话工作目录不同。Git 证据以项目目录为准；请确认这是本次交接涉及的项目。
                </div>
              ) : null}
              <div className="inline-note">
                接入时会记录一次 Git 基线。此后能区分“接入前已有修改”和“观察窗口内变化”，但无法区分窗口内修改来自 Agent 还是用户。
              </div>
            </>
          ) : (
            <div className="detail-placeholder">
              <p>从左侧选择一个会话。</p>
              <p className="muted">只会读取你明确选择的会话，不会自动导入其他历史会话。</p>
            </div>
          )}
          {error ? <div className="inline-error">{error}</div> : null}
        </div>
      </div>
    </Modal>
  )
}

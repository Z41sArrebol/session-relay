import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type {
  AppBootstrap,
  AttachedSession,
  ConnectorInfo,
  GitEvidence,
  GitFile,
  PublicSettings,
  RecoveryBrief,
  SummaryDraft,
  TimelineResponse
} from '../../shared/types'
import { basename, formatNumber, relativeTime } from './format'
import { SessionRail } from './components/SessionRail'
import { TimelinePane } from './components/Timeline'
import { HandoffPanel } from './components/HandoffPanel'
import { AttachDialog } from './components/AttachDialog'
import { SettingsDialog } from './components/SettingsDialog'
import { PackDialog } from './components/PackDialog'
import { Toast } from './components/Modal'
import { IconAlert, IconLock, IconPause, IconPlay, IconRefresh, IconSettings } from './components/Icons'

type Dialog = 'attach' | 'settings' | 'pack' | null
type ToastState = { kind: 'info' | 'error' | 'success'; text: string } | null

export default function App(): React.ReactElement {
  const [boot, setBoot] = useState<AppBootstrap | null>(null)
  const [bootError, setBootError] = useState<string | null>(null)
  const [activeId, setActiveId] = useState<string | null>(null)
  const [timeline, setTimeline] = useState<TimelineResponse | null>(null)
  const [git, setGit] = useState<GitEvidence | null>(null)
  const [summary, setSummary] = useState<SummaryDraft | null>(null)
  const [recovery, setRecovery] = useState<RecoveryBrief | null>(null)
  const [selectedFiles, setSelectedFiles] = useState<Set<string>>(new Set())
  const [loadingSession, setLoadingSession] = useState(false)
  const [busy, setBusy] = useState<string | null>(null)
  const [dialog, setDialog] = useState<Dialog>(null)
  const [toast, setToast] = useState<ToastState>(null)
  const selectionTouched = useRef(false)
  const saveTimer = useRef<number | null>(null)
  const activeIdRef = useRef<string | null>(null)
  const reloadTimer = useRef<number | null>(null)

  const showToast = useCallback((kind: 'info' | 'error' | 'success', text: string) => {
    setToast({ kind, text })
  }, [])

  const active: AttachedSession | null = useMemo(
    () => boot?.attached.find((a) => a.sessionId === activeId) || null,
    [boot, activeId]
  )

  useEffect(() => {
    activeIdRef.current = activeId
  }, [activeId])

  useEffect(() => {
    let alive = true
    window.relay
      .bootstrap()
      .then((b) => {
        if (!alive) return
        setBoot(b)
        setActiveId((current) => current || b.attached[0]?.sessionId || null)
      })
      .catch((e) => alive && setBootError(e instanceof Error ? e.message : String(e)))
    return () => {
      alive = false
    }
  }, [])

  const updateAttached = useCallback((updated: AttachedSession) => {
    setBoot((prev) =>
      prev
        ? {
            ...prev,
            attached: prev.attached.map((a) => (a.sessionId === updated.sessionId ? updated : a))
          }
        : prev
    )
  }, [])

  const loadSession = useCallback(
    async (sessionId: string, includeGit = true) => {
      setLoadingSession(true)
      try {
        const [tl, s, rec] = await Promise.all([
          window.relay.timeline(sessionId),
          window.relay.getSummary(sessionId),
          window.relay.recovery(sessionId)
        ])
        setTimeline(tl)
        setSummary(s)
        setRecovery(rec)
        if (includeGit) {
          const g = await window.relay.gitEvidence(sessionId)
          setGit(g)
          selectionTouched.current = false
          setSelectedFiles(defaultSelection(g))
        }
      } catch (e) {
        showToast('error', e instanceof Error ? e.message : String(e))
      } finally {
        setLoadingSession(false)
      }
    },
    [showToast]
  )

  useEffect(() => {
    if (!activeId) {
      setTimeline(null)
      setGit(null)
      setSummary(null)
      setRecovery(null)
      setSelectedFiles(new Set())
      return
    }
    void loadSession(activeId, true)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeId])

  useEffect(() => {
    const off = window.relay.onEvent((event) => {
      if (event.type === 'session-updated') {
        setBoot((prev) =>
          prev
            ? {
                ...prev,
                attached: prev.attached.map((a) =>
                  a.sessionId === event.sessionId
                    ? {
                        ...a,
                        live: event.live,
                        lastSyncAt: event.lastSyncAt,
                        eventCount: event.eventCount,
                        syncError: null
                      }
                    : a
                )
              }
            : prev
        )
        if (event.sessionId === activeIdRef.current) {
          if (reloadTimer.current) window.clearTimeout(reloadTimer.current)
          reloadTimer.current = window.setTimeout(() => {
            void loadSession(event.sessionId, false)
          }, 450)
        }
      } else if (event.type === 'sync-error') {
        setBoot((prev) =>
          prev
            ? {
                ...prev,
                attached: prev.attached.map((a) =>
                  a.sessionId === event.sessionId ? { ...a, syncError: event.message, live: { ...a.live, state: 'error', label: '读取失败', detail: event.message } } : a
                )
              }
            : prev
        )
        showToast('error', `读取失败：${event.message}`)
      } else if (event.type === 'session-detached') {
        setBoot((prev) => (prev ? { ...prev, attached: prev.attached.filter((a) => a.sessionId !== event.sessionId) } : prev))
      }
    })
    return off
  }, [loadSession, showToast])

  useEffect(() => {
    if (!active || !selectionTouched.current) return
    if (saveTimer.current) window.clearTimeout(saveTimer.current)
    saveTimer.current = window.setTimeout(() => {
      window.relay
        .saveSelectedFiles(active.sessionId, [...selectedFiles])
        .then(updateAttached)
        .catch((e) => showToast('error', e instanceof Error ? e.message : String(e)))
    }, 450)
    return () => {
      if (saveTimer.current) window.clearTimeout(saveTimer.current)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedFiles])

  const toggleFile = (path: string): void => {
    selectionTouched.current = true
    setSelectedFiles((prev) => {
      const next = new Set(prev)
      if (next.has(path)) next.delete(path)
      else next.add(path)
      return next
    })
  }

  const selectAll = (mode: 'all' | 'none' | 'window'): void => {
    selectionTouched.current = true
    if (!git) return
    const files = dedupeFiles(git)
    if (mode === 'none') {
      setSelectedFiles(new Set())
      return
    }
    if (mode === 'all') {
      setSelectedFiles(new Set(files.filter((f) => f.selectable).map((f) => f.path)))
      return
    }
    setSelectedFiles(new Set(files.filter((f) => f.selectable && f.changedSinceBaseline).map((f) => f.path)))
  }

  const refresh = async (): Promise<void> => {
    if (!activeId) return
    setBusy('refresh')
    try {
      const result = await window.relay.refresh(activeId)
      if (!result.ok) showToast('error', result.error || '刷新失败')
      else showToast('success', result.newEvents ? `新增 ${result.newEvents} 条记录` : '没有新增记录')
      await loadSession(activeId, true)
      const updated = await window.relay.bootstrap()
      setBoot((prev) => (prev ? { ...prev, attached: updated.attached, connectors: updated.connectors } : updated))
    } catch (e) {
      showToast('error', e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(null)
    }
  }

  const togglePause = async (): Promise<void> => {
    if (!active) return
    try {
      const updated = await window.relay.setPaused(active.sessionId, !active.paused)
      updateAttached(updated)
      showToast('info', updated.paused ? '已暂停观察；已读记录保留' : '已恢复观察；会从上次水位补读')
    } catch (e) {
      showToast('error', e instanceof Error ? e.message : String(e))
    }
  }

  const detach = async (sessionId: string): Promise<void> => {
    try {
      await window.relay.detachSession(sessionId)
      const remaining = (boot?.attached || []).filter((a) => a.sessionId !== sessionId)
      setBoot((prev) => (prev ? { ...prev, attached: remaining } : prev))
      if (activeId === sessionId) {
        setActiveId(remaining[0]?.sessionId || null)
        setTimeline(null)
        setGit(null)
        setSummary(null)
      }
      showToast('info', '已移除接入；源会话与本地采集记录已删除')
    } catch (e) {
      showToast('error', e instanceof Error ? e.message : String(e))
    }
  }

  const generateSummary = async (forceTemplate = false): Promise<void> => {
    if (!active) return
    setBusy('summary')
    try {
      const draft = await window.relay.generateSummary(active.sessionId, forceTemplate)
      setSummary(draft)
      if (draft.error) showToast('error', draft.error)
      else showToast('success', forceTemplate ? '已生成确定性草稿' : 'AI 总结已生成')
    } catch (e) {
      showToast('error', e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(null)
    }
  }

  const saveSummary = async (sections: Record<string, string>): Promise<void> => {
    if (!active) return
    setBusy('summary-save')
    try {
      const draft = await window.relay.saveSummary(active.sessionId, sections)
      setSummary(draft)
      showToast('success', '摘要草稿已保存')
    } catch (e) {
      showToast('error', e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(null)
    }
  }

  const refreshGit = async (): Promise<void> => {
    if (!active) return
    try {
      const [g, rec] = await Promise.all([
        window.relay.gitEvidence(active.sessionId),
        window.relay.recovery(active.sessionId)
      ])
      setGit(g)
      setRecovery(rec)
      showToast('info', 'Git 状态与恢复简报已刷新')
    } catch (e) {
      showToast('error', e instanceof Error ? e.message : String(e))
    }
  }

  const onAttached = (session: AttachedSession): void => {
    setBoot((prev) =>
      prev
        ? { ...prev, attached: [...prev.attached.filter((a) => a.sessionId !== session.sessionId), session] }
        : prev
    )
    setActiveId(session.sessionId)
    setDialog(null)
    showToast('success', '会话已接入，开始只读观察')
  }

  const onSettingsSaved = (settings: PublicSettings): void => {
    setBoot((prev) => (prev ? { ...prev, settings } : prev))
    void refreshConnectors()
  }

  const refreshConnectors = async (): Promise<void> => {
    try {
      const connectors = await window.relay.connectors()
      setBoot((prev) => (prev ? { ...prev, connectors } : prev))
    } catch {
      // connectors are advisory; ignore transient detection errors
    }
  }

  if (!boot) {
    return (
      <div className="boot-screen">
        <div className="boot-mark">◐</div>
        <h1>会话接力台</h1>
        <p>{bootError || '正在连接 Z-Code 本地数据…'}</p>
        {bootError ? <div className="inline-error">{bootError}</div> : null}
      </div>
    )
  }

  return (
    <div className="app">
      <header className="topbar">
        <div className="brand">
          <div className="brand-mark">◐</div>
          <div>
            <h1>会话接力台</h1>
            <span className="brand-sub">SESSION RELAY · 只读采集</span>
          </div>
        </div>

        {active ? (
          <div className="top-center">
            <div className="top-title">
              <span className="top-session">{active.title || '未命名会话'}</span>
              <span className={`live-pill live-${active.live.state}`}>
                <span className="live-dot"><span className="dot" /></span>
                {active.live.label}
              </span>
            </div>
            <div className="top-path" title={active.projectRoot}>
              {basename(active.projectRoot)} <span className="muted">· {active.live.detail}</span>
            </div>
          </div>
        ) : (
          <div className="top-center top-center-empty">
            <span className="muted">从左侧接入一个 Z-Code 会话，或先在设置里配置模型接口。</span>
          </div>
        )}

        <div className="top-actions">
          {active ? (
            <>
              <button className="icon-btn" title={active.paused ? '恢复观察' : '暂停观察'} onClick={togglePause}>
                {active.paused ? <IconPlay size={15} /> : <IconPause size={15} />}
              </button>
              <button className="icon-btn" title="手动刷新" onClick={refresh} disabled={Boolean(busy)}>
                <IconRefresh size={15} className={busy === 'refresh' ? 'spin' : ''} />
              </button>
              <span className="top-meta" title={active.live.detail}>
                {active.live.state === 'error' ? '读取异常' : active.live.state === 'running' ? '执行中' : '空闲'}
                <span className="dot-sep">·</span>
                {relativeTime(active.lastSyncAt)}
              </span>
            </>
          ) : null}
          <button className="icon-btn" title="设置" onClick={() => setDialog('settings')}>
            <IconSettings size={16} />
          </button>
        </div>
      </header>

      {!boot.zcodeReadable ? (
        <div className="schema-banner">
          <IconAlert size={14} />
          <span>Z-Code 数据结构不可用：{boot.zcodeError}</span>
        </div>
      ) : null}

      <main className="workspace">
        <SessionRail
          attached={boot.attached}
          activeId={activeId}
          schemaOk={boot.zcodeReadable}
          schemaDetail={boot.schema.detail}
          onSelect={setActiveId}
          onAttach={() => setDialog('attach')}
          onPause={(id, paused) => {
            void window.relay
              .setPaused(id, paused)
              .then((updated) => {
                updateAttached(updated)
                if (id === activeId) void loadSession(id, false)
              })
              .catch((e) => showToast('error', e instanceof Error ? e.message : String(e)))
          }}
          onDetach={detach}
        />

        <TimelinePane
          timeline={timeline}
          loading={loadingSession}
          onRefresh={refresh}
          onCopy={(text) => {
            void window.relay.copyText(text)
            showToast('success', '已复制')
          }}
        />

        {active ? (
          <HandoffPanel
            attached={active}
            git={git}
            summary={summary}
            recovery={recovery}
            timeline={timeline}
            selected={selectedFiles}
            busy={busy}
            schemaDetail={boot.schema.detail}
            onToggleFile={toggleFile}
            onSelectAll={selectAll}
            onGenerateAI={() => generateSummary(false)}
            onGenerateTemplate={() => generateSummary(true)}
            onSaveSummary={saveSummary}
            onRefreshGit={refreshGit}
            onCopyRecovery={async () => {
              const text = await window.relay.recoveryMarkdown(active.sessionId)
              await window.relay.copyText(text)
              showToast('success', '恢复简报已复制')
            }}
            onPreview={() => setDialog('pack')}
          />
        ) : (
          <aside className="handoff handoff-empty">
            <div className="handoff-kicker">HANDOFF</div>
            <h2>交接摘要与证据</h2>
            <p>接入会话后，这里会显示可编辑摘要、Git 变更和证据问题。</p>
            <ul>
              <li>用户明确选择会话与项目</li>
              <li>只读采集，不修改源库</li>
              <li>没有模型接口也能导出基础交接包</li>
            </ul>
          </aside>
        )}
      </main>

      {dialog === 'attach' ? (
        <AttachDialog attached={boot.attached} onClose={() => setDialog(null)} onAttached={onAttached} onError={(m) => showToast('error', m)} />
      ) : null}
      {dialog === 'settings' ? (
        <SettingsDialog
          settings={boot.settings}
          schemaDetail={boot.schema.detail}
          onClose={() => setDialog(null)}
          onSaved={onSettingsSaved}
          onToast={showToast}
        />
      ) : null}
      {dialog === 'pack' && active ? (
        <PackDialog
          attached={active}
          git={git}
          selectedFiles={selectedFiles}
          connectors={boot.connectors}
          onClose={() => setDialog(null)}
          onToast={showToast}
          onConnectorsChanged={() => void refreshConnectors()}
        />
      ) : null}

      {toast ? <Toast kind={toast.kind} text={toast.text} onClose={() => setToast(null)} /> : null}
    </div>
  )
}

function dedupeFiles(git: GitEvidence): GitFile[] {
  const map = new Map<string, GitFile>()
  for (const f of [...git.buckets.staged, ...git.buckets.unstaged, ...git.buckets.untracked]) map.set(f.path, f)
  return [...map.values()]
}

function defaultSelection(git: GitEvidence): Set<string> {
  return new Set(
    dedupeFiles(git)
      .filter((f) => f.selectable && !f.sensitive)
      .map((f) => f.path)
  )
}

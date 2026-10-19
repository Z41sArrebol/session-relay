import React, { useEffect, useMemo, useRef, useState } from 'react'
import type {
  AttachedSession,
  ConnectorInfo,
  ExportResult,
  GitEvidence,
  PackPreview,
  PackRequest,
  RelayMode,
  SendResult
} from '../../../shared/types'
import { formatBytes, formatNumber } from '../format'
import { Modal } from './Modal'
import { IconAlert, IconCopy, IconFolder, IconPackage, IconSend } from './Icons'

interface Props {
  attached: AttachedSession
  git: GitEvidence | null
  selectedFiles: Set<string>
  connectors: ConnectorInfo[]
  onClose: () => void
  onToast: (kind: 'info' | 'error' | 'success', text: string) => void
  onConnectorsChanged: () => void
}

export function PackDialog({ attached, git, selectedFiles, connectors, onClose, onToast, onConnectorsChanged }: Props): React.ReactElement {
  const [mode, setMode] = useState<RelayMode>('review')
  const [includeFullFiles, setIncludeFullFiles] = useState(false)
  const [allowSensitive, setAllowSensitive] = useState(false)
  const [extraNotes, setExtraNotes] = useState('')
  const [preview, setPreview] = useState<PackPreview | null>(null)
  const [loading, setLoading] = useState(true)
  const [exporting, setExporting] = useState<string | null>(null)
  const [result, setResult] = useState<ExportResult | null>(null)
  const [showMarkdown, setShowMarkdown] = useState(false)
  const [sending, setSending] = useState(false)
  const [sendResult, setSendResult] = useState<SendResult | null>(null)
  const [target, setTarget] = useState('claude-cli')
  const [confirmed, setConfirmed] = useState(false)
  const [verifyConfirmed, setVerifyConfirmed] = useState(false)
  const [verifying, setVerifying] = useState(false)
  const [verificationNote, setVerificationNote] = useState<string | null>(null)
  const timer = useRef<number | null>(null)

  const request: PackRequest = useMemo(
    () => ({
      sessionId: attached.sessionId,
      mode,
      filePaths: [...selectedFiles],
      includeFullFiles,
      extraNotes,
      allowSensitive
    }),
    [attached.sessionId, mode, selectedFiles, includeFullFiles, extraNotes, allowSensitive]
  )

  const buildPreview = async (): Promise<void> => {
    setLoading(true)
    try {
      const p = await window.relay.previewPack(request)
      setPreview(p)
    } catch (e) {
      onToast('error', e instanceof Error ? e.message : String(e))
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    void buildPreview()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  useEffect(() => {
    if (timer.current) window.clearTimeout(timer.current)
    timer.current = window.setTimeout(() => {
      void buildPreview()
    }, 650)
    return () => {
      if (timer.current) window.clearTimeout(timer.current)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mode, includeFullFiles, allowSensitive, extraNotes, selectedFiles])

  const exportPack = async (format: 'folder' | 'zip'): Promise<void> => {
    setExporting(format)
    setResult(null)
    try {
      const r = await window.relay.exportPack(request, format)
      setResult(r)
      if (r.ok) onToast('success', `已导出 ${r.fileCount} 个文件（${formatBytes(r.totalBytes)}）`)
      else if (r.error === '已取消') onToast('info', '已取消导出')
      else onToast('error', r.error || '导出失败')
    } catch (e) {
      onToast('error', e instanceof Error ? e.message : String(e))
    } finally {
      setExporting(null)
    }
  }

  const copyInstruction = async (): Promise<void> => {
    if (!preview) return
    await window.relay.copyText(preview.relayInstruction)
    onToast('success', '接力指令已复制')
  }

  const claude = connectors.find((c) => c.id === 'claude-cli')
  const zcode = connectors.find((c) => c.id === 'zcode-session')

  const verify = async (): Promise<void> => {
    if (!verifyConfirmed) {
      onToast('error', '请先确认自检任务不含敏感内容')
      return
    }
    setVerifying(true)
    setVerificationNote(null)
    try {
      const v = await window.relay.verifyConnector('claude-cli', true)
      setVerificationNote(v.detail)
      onToast(v.verified ? 'success' : 'error', v.verified ? '连接器自检通过' : v.error || '自检未通过')
      onConnectorsChanged()
    } catch (e) {
      onToast('error', e instanceof Error ? e.message : String(e))
    } finally {
      setVerifying(false)
    }
  }

  const send = async (): Promise<void> => {
    if (!confirmed) {
      onToast('error', '请先勾选确认')
      return
    }
    setSending(true)
    setSendResult(null)
    try {
      const r = await window.relay.sendToAgent({
        ...request,
        connectorId: target,
        confirmed: true,
        relayInstruction: preview?.relayInstruction || ''
      })
      setSendResult(r)
      onToast(r.sent ? 'success' : 'error', r.sent ? '已发送，目标 Agent 已返回确认' : `未发送：${r.message}`)
    } catch (e) {
      onToast('error', e instanceof Error ? e.message : String(e))
    } finally {
      setSending(false)
    }
  }

  return (
    <Modal
      title="预览交接包"
      subtitle="打包前核对内容、大小、排除项和隐私提醒。导出与发送是两条明确分开的出口。"
      width={1040}
      onClose={onClose}
      footer={
        <>
          <div className="foot-note">
            {preview ? `${preview.files.length} 个文件 · ${formatBytes(preview.totalBytes)}` : loading ? '正在生成预览…' : ''}
          </div>
          <div className="foot-actions">
            <button className="btn btn-ghost" onClick={copyInstruction} disabled={!preview}>
              <IconCopy size={13} /> 复制接力指令
            </button>
            <button className="btn btn-ghost" onClick={() => exportPack('zip')} disabled={!preview || Boolean(exporting)}>
              <IconPackage size={13} /> {exporting === 'zip' ? '打包中…' : '导出 ZIP'}
            </button>
            <button className="btn btn-primary" onClick={() => exportPack('folder')} disabled={!preview || Boolean(exporting)}>
              <IconFolder size={13} /> {exporting === 'folder' ? '导出中…' : '导出文件夹'}
            </button>
          </div>
        </>
      }
    >
      <div className="pack-layout">
        <div className="pack-main">
          <div className="pack-options">
            <div className="option-row">
              <span className="field-label">接力模式</span>
              <div className="segmented">
                <button className={mode === 'review' ? 'is-on' : ''} onClick={() => setMode('review')}>
                  独立验收
                </button>
                <button className={mode === 'implement' ? 'is-on' : ''} onClick={() => setMode('implement')}>
                  继续实现
                </button>
              </div>
              <span className="muted">
                {mode === 'review' ? '默认：只检查、报告，不授权修改' : '允许修改清单内文件'}
              </span>
            </div>
            <label className="checkline">
              <input type="checkbox" checked={includeFullFiles} onChange={(e) => setIncludeFullFiles(e.target.checked)} />
              同时包含已选文件的完整内容（默认只含未跟踪/新增文件和 diff）
            </label>
            <label className="checkline checkline-danger">
              <input type="checkbox" checked={allowSensitive} onChange={(e) => setAllowSensitive(e.target.checked)} />
              允许包含疑似敏感文件（默认排除；勾选后仍会在清单中标记风险）
            </label>
            <label className="field-label">用户补充说明（写入 HANDOFF.md）</label>
            <textarea
              className="input"
              rows={3}
              value={extraNotes}
              onChange={(e) => setExtraNotes(e.target.value)}
              placeholder="例如：这次只验收登录流程，不要改样式；或指出已知的环境限制。"
            />
          </div>

          {loading ? <div className="loading-block">正在生成交接包预览…</div> : null}

          {preview ? (
            <>
              {preview.warnings.length ? (
                <div className="inline-warn">
                  <IconAlert size={13} />
                  <div>
                    {preview.warnings.map((w, i) => (
                      <div key={i}>{w}</div>
                    ))}
                  </div>
                </div>
              ) : null}

              {preview.sensitiveHits.length ? (
                <div className="inline-error">
                  <IconAlert size={13} />
                  <div>
                    <b>检测到 {preview.sensitiveHits.length} 处疑似敏感内容（启发式，不保证 100%）</b>
                    {preview.sensitiveHits.slice(0, 6).map((h, i) => (
                      <div key={i} className="mono small">{h.path}：{h.reason}</div>
                    ))}
                  </div>
                </div>
              ) : null}

              <div className="pack-grid">
                <section className="pack-block">
                  <h4>文件清单 <span>{preview.files.length}</span></h4>
                  <div className="pack-file-list">
                    {preview.files.map((f) => (
                      <div className="pack-file" key={f.path}>
                        <span className="mono">{f.path}</span>
                        <span className="muted">{formatBytes(f.bytes)}</span>
                      </div>
                    ))}
                  </div>
                  <p className="fine" style={{ marginTop: 6 }}>
                    另有 <span className="mono">manifest.json</span>：来源、捕获时间、版本与文件哈希清单。
                  </p>
                </section>
                <section className="pack-block">
                  <h4>排除项 <span>{preview.excluded.length}</span></h4>
                  {preview.excluded.length === 0 ? <p className="fine">没有排除项。</p> : null}
                  <div className="pack-file-list">
                    {preview.excluded.map((e, i) => (
                      <div className="pack-file" key={`${e.path}-${i}`}>
                        <span className="mono">{e.path}</span>
                        <span className="muted">{e.reason}</span>
                      </div>
                    ))}
                  </div>
                </section>
              </div>

              <section className="pack-block">
                <h4>
                  HANDOFF.md
                  <button className="text-btn" onClick={() => setShowMarkdown(!showMarkdown)}>
                    {showMarkdown ? '收起' : '展开'}
                  </button>
                </h4>
                {showMarkdown ? <pre className="handoff-preview">{preview.markdown}</pre> : <p className="fine">默认折叠；展开可核对正文。</p>}
              </section>

              <div className="privacy-note">
                隐私提醒：交接包只应包含你愿意发给另一个 Agent 的内容。敏感信息检测是启发式，diff 中也可能包含凭据；发送前请人工检查。
              </div>
            </>
          ) : null}

          {result ? (
            <div className={result.ok ? 'inline-ok' : 'inline-error'}>
              {result.ok ? (
                <>
                  已导出：<span className="mono break">{result.directory || result.zipPath}</span>
                  <button
                    className="text-btn"
                    onClick={() => window.relay.openPath(result.directory || result.zipPath || '')}
                  >
                    打开
                  </button>
                </>
              ) : (
                result.error || '导出失败'
              )}
            </div>
          ) : null}
        </div>

        <aside className="pack-side">
          <section className="send-box">
            <div className="send-head">
              <IconSend size={15} />
              <h3>交给另一个 Agent</h3>
            </div>
            <p className="fine">发送前必须预览并确认接收目标与内容。不会自动进入审查—修复循环。</p>

            <label className="field-label">接收目标</label>
            <div className="target-list">
              <label className={`target ${target === 'claude-cli' ? 'is-on' : ''}`}>
                <input type="radio" checked={target === 'claude-cli'} onChange={() => setTarget('claude-cli')} />
                <div>
                  <b>{claude?.label || 'Claude Code CLI'}</b>
                  <span className={`tag ${claude?.verified ? 'tag-ok' : 'tag-warn'}`}>
                    {claude?.verified ? '已自检' : '候选 · 未验证'}
                  </span>
                  <p>{claude?.detail}</p>
                  {claude?.reason ? <p className="warn-text">{claude.reason}</p> : null}
                  <p className="fine">它不一定沿用 Z-Code 的模型额度，不能当作默认主出口。</p>
                </div>
              </label>

              <label className={`target ${target === 'zcode-session' ? 'is-on' : ''}`}>
                <input type="radio" checked={target === 'zcode-session'} onChange={() => setTarget('zcode-session')} />
                <div>
                  <b>{zcode?.label || '另一个 Z-Code 会话'}</b>
                  <span className="tag tag-quiet">仅支持导出</span>
                  <p>{zcode?.reason}</p>
                  <p className="fine">请导出交接包并复制接力指令，到目标会话手动粘贴。</p>
                </div>
              </label>
            </div>

            {target === 'claude-cli' ? (
              <>
                {!claude?.verified ? (
                  <div className="verify-box">
                    <b>先做连接器自检</b>
                    <p>发送一个不含敏感内容的固定任务，收到 RELAY_CONNECTOR_OK 后才算已验证。</p>
                    <label className="checkline">
                      <input type="checkbox" checked={verifyConfirmed} onChange={(e) => setVerifyConfirmed(e.target.checked)} />
                      我确认发送自检任务（不含敏感内容）
                    </label>
                    <button className="btn btn-ghost btn-small" onClick={verify} disabled={verifying || Boolean(loading)}>
                      {verifying ? '自检中…' : '运行连接器自检'}
                    </button>
                    {verificationNote ? <p className="fine">{verificationNote}</p> : null}
                  </div>
                ) : (
                  <div className="inline-ok">连接器已验证：{claude.verifiedAt ? new Date(claude.verifiedAt).toLocaleString() : ''}</div>
                )}

                <label className="checkline">
                  <input type="checkbox" checked={confirmed} onChange={(e) => setConfirmed(e.target.checked)} />
                  我已预览交接包，确认发送到 Claude Code CLI
                </label>
                <button
                  className="btn btn-primary btn-block"
                  onClick={send}
                  disabled={!confirmed || sending || !claude?.verified || !preview}
                >
                  {sending ? '发送中…' : '发送任务'}
                </button>
              </>
            ) : (
              <button className="btn btn-ghost btn-block" onClick={copyInstruction} disabled={!preview}>
                <IconCopy size={13} /> 复制接力指令
              </button>
            )}

            {sendResult ? (
              <div className={sendResult.sent ? 'inline-ok' : 'inline-error'}>
                <b>{sendResult.sent ? '已发送' : '未发送'}</b>
                <p>{sendResult.message}</p>
                {sendResult.output ? <pre className="send-output">{sendResult.output}</pre> : null}
                {sendResult.packDirectory ? (
                  <button className="text-btn" onClick={() => window.relay.openPath(sendResult.packDirectory!)}>
                    打开本次发送的交接包
                  </button>
                ) : null}
              </div>
            ) : null}
          </section>

          <section className="pack-facts">
            <h4>本次快照</h4>
            <dl>
              <div><dt>会话</dt><dd className="mono">{attached.sessionId.slice(-8)}</dd></div>
              <div><dt>状态</dt><dd>{attached.live.label}</dd></div>
              <div><dt>归属</dt><dd>{git?.attribution || '未知'}</dd></div>
              <div><dt>文件</dt><dd>{preview ? formatNumber(preview.files.length) : '—'}</dd></div>
              <div><dt>大小</dt><dd>{preview ? formatBytes(preview.totalBytes) : '—'}</dd></div>
            </dl>
          </section>
        </aside>
      </div>
    </Modal>
  )
}

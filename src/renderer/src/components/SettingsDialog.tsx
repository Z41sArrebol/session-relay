import React, { useEffect, useState } from 'react'
import type { PublicSettings } from '../../../shared/types'
import { Modal } from './Modal'
import { IconLock } from './Icons'

interface Props {
  settings: PublicSettings
  schemaDetail: string
  onClose: () => void
  onSaved: (settings: PublicSettings) => void
  onToast: (kind: 'info' | 'error' | 'success', text: string) => void
}

export function SettingsDialog({ settings, schemaDetail, onClose, onSaved, onToast }: Props): React.ReactElement {
  const [baseUrl, setBaseUrl] = useState(settings.model.baseUrl)
  const [model, setModel] = useState(settings.model.model)
  const [temperature, setTemperature] = useState(settings.model.temperature)
  const [apiKey, setApiKey] = useState('')
  const [keepKey, setKeepKey] = useState(settings.model.apiKeyConfigured)
  const [busy, setBusy] = useState<string | null>(null)
  const [test, setTest] = useState<{ ok: boolean; message: string; latencyMs: number | null } | null>(null)

  useEffect(() => {
    setBaseUrl(settings.model.baseUrl)
    setModel(settings.model.model)
    setTemperature(settings.model.temperature)
    setKeepKey(settings.model.apiKeyConfigured)
  }, [settings])

  const save = async (): Promise<PublicSettings | null> => {
    setBusy('save')
    try {
      const saved = await window.relay.saveSettings({
        baseUrl,
        model,
        temperature,
        apiKey: apiKey || undefined,
        keepKey: keepKey && !apiKey
      })
      onSaved(saved)
      setApiKey('')
      onToast('success', '模型设置已保存')
      return saved
    } catch (e) {
      onToast('error', e instanceof Error ? e.message : String(e))
      return null
    } finally {
      setBusy(null)
    }
  }

  const runTest = async (): Promise<void> => {
    setBusy('test')
    setTest(null)
    try {
      const result = await window.relay.testModel()
      setTest(result)
      onToast(result.ok ? 'success' : 'error', result.message)
    } catch (e) {
      onToast('error', e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(null)
    }
  }

  return (
    <Modal
      title="设置"
      subtitle="AI 总结使用你明确配置的兼容服务。不会复用或导出 Z-Code 登录凭据。"
      width={680}
      onClose={onClose}
      footer={
        <>
          <div className="foot-note">
            <IconLock size={12} /> {settings.model.keyStorage === 'dpapi' ? 'Key 由 Windows DPAPI 加密保存' : settings.model.keyStorage === 'basic' ? '系统安全存储不可用，Key 仅受文件权限保护' : '尚未保存 Key'}
          </div>
          <div className="foot-actions">
            <button className="btn btn-ghost" onClick={onClose}>关闭</button>
            <button className="btn btn-ghost" onClick={runTest} disabled={Boolean(busy)}>
              {busy === 'test' ? '测试中…' : '测试连接'}
            </button>
            <button className="btn btn-primary" onClick={save} disabled={Boolean(busy)}>
              {busy === 'save' ? '保存中…' : '保存'}
            </button>
          </div>
        </>
      }
    >
      <div className="settings">
        <section>
          <h3>模型接口（OpenAI 兼容）</h3>
          <label className="field-label">服务地址</label>
          <input
            className="input mono"
            placeholder="https://api.example.com/v1"
            value={baseUrl}
            onChange={(e) => setBaseUrl(e.target.value)}
          />
          <p className="field-hint">填到 /v1 为止；程序会自动追加 /chat/completions。也可以直接填完整的 /chat/completions 地址。</p>

          <div className="form-grid">
            <div>
              <label className="field-label">模型名称</label>
              <input className="input mono" placeholder="gpt-4.1 / deepseek-chat …" value={model} onChange={(e) => setModel(e.target.value)} />
            </div>
            <div>
              <label className="field-label">温度</label>
              <input
                className="input"
                type="number"
                min={0}
                max={2}
                step={0.1}
                value={temperature}
                onChange={(e) => setTemperature(Number(e.target.value))}
              />
            </div>
          </div>

          <label className="field-label">API Key</label>
          <input
            className="input mono"
            type="password"
            placeholder={settings.model.apiKeyConfigured ? '已保存；留空则保持不变' : '输入 API Key'}
            value={apiKey}
            onChange={(e) => {
              setApiKey(e.target.value)
              setKeepKey(true)
            }}
          />
          <label className="checkline">
            <input type="checkbox" checked={keepKey} onChange={(e) => setKeepKey(e.target.checked)} />
            保留已保存的 Key（不勾选且留空会清除）
          </label>
          {test ? (
            <div className={test.ok ? 'inline-ok' : 'inline-error'}>
              {test.message}
              {test.latencyMs !== null ? ` · ${test.latencyMs} ms` : ''}
            </div>
          ) : null}
        </section>

        <section>
          <h3>数据来源</h3>
          <dl className="kv">
            <div><dt>Z-Code 数据库</dt><dd className="mono break">{settings.zcodeDbPath}</dd></div>
            <div><dt>结构状态</dt><dd>{schemaDetail}</dd></div>
            <div><dt>应用数据目录</dt><dd className="mono break">{settings.userDataPath}</dd></div>
            <div><dt>应用版本</dt><dd>{settings.appVersion}</dd></div>
          </dl>
          <p className="fine">源数据库以只读方式打开，并设置 query_only；不会 checkpoint、修改 WAL 或写入源库。</p>
        </section>
      </div>
    </Modal>
  )
}

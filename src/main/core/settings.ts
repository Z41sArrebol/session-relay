import { app, safeStorage } from 'electron'
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import path from 'node:path'
import type { PublicSettings } from '../../shared/types'

interface StoredSettings {
  model: {
    baseUrl: string
    model: string
    temperature: number
  }
  apiKey: string | null
  apiKeyStorage: 'dpapi' | 'basic' | 'unavailable'
}

const DEFAULT: StoredSettings = {
  model: { baseUrl: '', model: '', temperature: 0.2 },
  apiKey: null,
  apiKeyStorage: 'unavailable'
}

export class SettingsService {
  private file: string
  private data: StoredSettings

  constructor() {
    const dir = app.getPath('userData')
    mkdirSync(dir, { recursive: true })
    this.file = path.join(dir, 'settings.json')
    this.data = this.load()
  }

  private load(): StoredSettings {
    try {
      if (!existsSync(this.file)) return { ...DEFAULT, model: { ...DEFAULT.model } }
      const parsed = JSON.parse(readFileSync(this.file, 'utf8')) as Partial<StoredSettings>
      return {
        model: {
          baseUrl: String(parsed.model?.baseUrl || ''),
          model: String(parsed.model?.model || ''),
          temperature: Number.isFinite(parsed.model?.temperature) ? Number(parsed.model?.temperature) : 0.2
        },
        apiKey: typeof parsed.apiKey === 'string' && parsed.apiKey ? parsed.apiKey : null,
        apiKeyStorage: parsed.apiKeyStorage === 'dpapi' || parsed.apiKeyStorage === 'basic' ? parsed.apiKeyStorage : 'unavailable'
      }
    } catch {
      return { ...DEFAULT, model: { ...DEFAULT.model } }
    }
  }

  private persist(): void {
    writeFileSync(this.file, JSON.stringify(this.data, null, 2), 'utf8')
  }

  private encryptionAvailable(): boolean {
    try {
      return safeStorage.isEncryptionAvailable()
    } catch {
      return false
    }
  }

  publicView(): PublicSettings {
    return {
      model: {
        baseUrl: this.data.model.baseUrl,
        model: this.data.model.model,
        temperature: this.data.model.temperature,
        apiKeyConfigured: Boolean(this.data.apiKey),
        keyStorage: this.data.apiKey
          ? this.data.apiKeyStorage
          : this.encryptionAvailable()
            ? 'dpapi'
            : 'unavailable'
      },
      zcodeDbPath: '',
      appVersion: app.getVersion(),
      userDataPath: app.getPath('userData')
    }
  }

  save(input: { baseUrl: string; model: string; temperature: number; apiKey?: string; keepKey?: boolean }): PublicSettings {
    const baseUrl = input.baseUrl.trim().replace(/\/+$/, '')
    if (baseUrl && !/^https?:\/\//i.test(baseUrl)) {
      throw new Error('模型服务地址必须以 http:// 或 https:// 开头')
    }
    this.data.model.baseUrl = baseUrl
    this.data.model.model = input.model.trim()
    this.data.model.temperature = Number.isFinite(input.temperature)
      ? Math.min(2, Math.max(0, input.temperature))
      : 0.2

    if (input.apiKey !== undefined && input.apiKey.trim() !== '') {
      const key = input.apiKey.trim()
      if (this.encryptionAvailable()) {
        this.data.apiKey = safeStorage.encryptString(key).toString('base64')
        this.data.apiKeyStorage = 'dpapi'
      } else {
        // Last resort: no OS key store. We keep the key out of the renderer
        // either way, but tell the user it is only protected by file ACLs.
        this.data.apiKey = Buffer.from(key, 'utf8').toString('base64')
        this.data.apiKeyStorage = 'basic'
      }
    } else if (!input.keepKey) {
      this.data.apiKey = null
      this.data.apiKeyStorage = 'unavailable'
    }
    this.persist()
    return this.publicView()
  }

  getApiKey(): string | null {
    if (!this.data.apiKey) return null
    try {
      const buf = Buffer.from(this.data.apiKey, 'base64')
      if (this.data.apiKeyStorage === 'dpapi') {
        return safeStorage.decryptString(buf)
      }
      return buf.toString('utf8')
    } catch {
      return null
    }
  }

  getModelConfig(): { baseUrl: string; model: string; temperature: number; apiKey: string | null } {
    return { ...this.data.model, apiKey: this.getApiKey() }
  }
}

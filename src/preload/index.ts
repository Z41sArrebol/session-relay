import { contextBridge, ipcRenderer } from 'electron'
import type {
  AppBootstrap,
  AttachRequest,
  AttachedSession,
  ConnectorInfo,
  ConnectorVerification,
  ExportResult,
  GitEvidence,
  PackPreview,
  PackRequest,
  PublicSettings,
  RelayApi,
  RelayEvent,
  SendRequest,
  SendResult,
  SessionSummary,
  SummaryDraft,
  SyncResult,
  TimelineResponse
} from '../shared/types'

const api: RelayApi = {
  bootstrap: () => ipcRenderer.invoke('relay:bootstrap') as Promise<AppBootstrap>,
  listSessions: (query?: string) =>
    ipcRenderer.invoke('relay:list-sessions', query) as Promise<{ sessions: SessionSummary[]; error: string | null }>,
  attachSession: (request: AttachRequest) => ipcRenderer.invoke('relay:attach', request) as Promise<AttachedSession>,
  detachSession: (sessionId: string) => ipcRenderer.invoke('relay:detach', sessionId) as Promise<void>,
  setPaused: (sessionId: string, paused: boolean) =>
    ipcRenderer.invoke('relay:set-paused', sessionId, paused) as Promise<AttachedSession>,
  refresh: (sessionId: string) => ipcRenderer.invoke('relay:refresh', sessionId) as Promise<SyncResult>,
  timeline: (sessionId: string, limit?: number) =>
    ipcRenderer.invoke('relay:timeline', sessionId, limit) as Promise<TimelineResponse>,
  recovery: (sessionId: string) => ipcRenderer.invoke('relay:recovery', sessionId) as Promise<import('../shared/types').RecoveryBrief>,
  recoveryMarkdown: (sessionId: string) => ipcRenderer.invoke('relay:recovery-markdown', sessionId) as Promise<string>,
  gitEvidence: (sessionId: string) => ipcRenderer.invoke('relay:git-evidence', sessionId) as Promise<GitEvidence>,
  refreshGit: (sessionId: string) => ipcRenderer.invoke('relay:refresh-git', sessionId) as Promise<GitEvidence>,
  chooseProjectRoot: (defaultPath: string) =>
    ipcRenderer.invoke('relay:choose-project-root', defaultPath) as Promise<string | null>,
  previewPack: (request: PackRequest) => ipcRenderer.invoke('relay:preview-pack', request) as Promise<PackPreview>,
  exportPack: (request: PackRequest, format?: 'folder' | 'zip') =>
    ipcRenderer.invoke('relay:export-pack', request, format) as Promise<ExportResult>,
  getSummary: (sessionId: string) => ipcRenderer.invoke('relay:get-summary', sessionId) as Promise<SummaryDraft | null>,
  generateSummary: (sessionId: string, forceTemplate?: boolean) =>
    ipcRenderer.invoke('relay:generate-summary', sessionId, forceTemplate) as Promise<SummaryDraft>,
  saveSummary: (sessionId: string, sections: Record<string, string>) =>
    ipcRenderer.invoke('relay:save-summary', sessionId, sections) as Promise<SummaryDraft>,
  settings: () => ipcRenderer.invoke('relay:settings') as Promise<PublicSettings>,
  saveSettings: (input: { baseUrl: string; model: string; temperature: number; apiKey?: string; keepKey?: boolean }) =>
    ipcRenderer.invoke('relay:save-settings', input) as Promise<PublicSettings>,
  testModel: () =>
    ipcRenderer.invoke('relay:test-model') as Promise<{ ok: boolean; message: string; latencyMs: number | null }>,
  connectors: () => ipcRenderer.invoke('relay:connectors') as Promise<ConnectorInfo[]>,
  sendToAgent: (request: SendRequest) => ipcRenderer.invoke('relay:send', request) as Promise<SendResult>,
  saveSelectedFiles: (sessionId: string, files: string[] | null) =>
    ipcRenderer.invoke('relay:save-selected-files', sessionId, files) as Promise<AttachedSession>,
  verifyConnector: (connectorId: string, confirmed: boolean) =>
    ipcRenderer.invoke('relay:verify-connector', connectorId, confirmed) as Promise<ConnectorVerification>,
  copyText: (text: string) => ipcRenderer.invoke('relay:copy-text', text) as Promise<{ ok: boolean }>,
  openPath: (target: string) =>
    ipcRenderer.invoke('relay:open-path', target) as Promise<{ ok: boolean; error: string | null }>,
  revealPath: (target: string) => ipcRenderer.invoke('relay:reveal-path', target) as Promise<void>,
  onEvent: (listener: (event: RelayEvent) => void) => {
    const handler = (_event: Electron.IpcRendererEvent, payload: RelayEvent): void => listener(payload)
    ipcRenderer.on('relay:event', handler)
    return () => ipcRenderer.removeListener('relay:event', handler)
  }
}

contextBridge.exposeInMainWorld('relay', api)

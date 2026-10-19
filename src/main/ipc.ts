import { app, BrowserWindow, clipboard, dialog, ipcMain, shell } from 'electron'
import { createWriteStream, existsSync, mkdirSync, renameSync, rmSync } from 'node:fs'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import * as archiverNs from 'archiver'
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
  RelayEvent,
  SendRequest,
  SendResult,
  SessionSummary,
  SummaryDraft,
  SyncResult,
  TimelineResponse
} from '../shared/types'
import { SUMMARY_SECTIONS } from '../shared/types'
import type { Logger } from './core/log'
import type { Observer } from './core/observer'
import type { RelayStore } from './core/state'
import type { ZcodeReader } from './core/zcode/reader'
import type { SettingsService } from './core/settings'
import { ConnectorService } from './core/connectors'
import { SummaryService, buildEvidenceBundle, checkCitations, computeEvidenceHash, markStale } from './core/summary'
import { buildRecoveryBrief, recoveryMarkdown } from './core/recovery'
import { getGitEvidence } from './core/git'
import {
  copyPackTo,
  packDirName,
  preparePack,
  previewFromPlan,
  writePack,
  type PackContext,
  type PackPlan
} from './core/handoff'
import { assertInside, safeJoin } from './core/paths'

interface IpcDeps {
  store: RelayStore
  reader: ZcodeReader
  observer: Observer
  settings: SettingsService
  logger: Logger
  connectors: ConnectorService
  summaries: SummaryService
  zcodeDbPath: string
  getWindow: () => BrowserWindow | null
}

const allowedOpenPaths = new Set<string>()

export function registerIpc(deps: IpcDeps): void {
  const { store, reader, observer, settings, logger, connectors, summaries } = deps

  const emit = (event: RelayEvent): void => {
    deps.getWindow()?.webContents.send('relay:event', event)
  }

  const publicSettings = (): PublicSettings => {
    const view = settings.publicView()
    view.zcodeDbPath = deps.zcodeDbPath
    return view
  }

  const ctxFor = async (sessionId: string, includeGit = true): Promise<PackContext> => {
    const row = observer.getRow(sessionId)
    const timeline = observer.getTimeline(sessionId)
    const git = includeGit
      ? await getGitEvidence({
          sessionId,
          projectRoot: row.projectRoot,
          baseline: row.baseline,
          live: row.live
        })
      : null
    return {
      row,
      git: git as GitEvidence,
      timeline: timeline.items,
      tokens: timeline.tokens,
      summary: row.summary,
      todos: store.getTodos(sessionId),
      turns: store.getTurns(sessionId),
      modelErrorCount: store.countModelErrors(sessionId)
    }
  }

  const previewPlan = async (request: PackRequest): Promise<{ plan: PackPlan; preview: PackPreview }> => {
    const ctx = await ctxFor(request.sessionId)
    const plan = await preparePack(ctx, request)
    const temp = path.join(app.getPath('userData'), 'tmp', `preview-${randomUUID()}`)
    try {
      const { manifest } = writePack(plan, temp)
      return { plan, preview: previewFromPlan(plan, manifest) }
    } finally {
      try {
        rmSync(temp, { recursive: true, force: true })
      } catch {
        // ignore
      }
    }
  }

  const uniqueDir = (parent: string, name: string): string => {
    let candidate = path.join(parent, name)
    let i = 2
    while (existsSync(candidate)) {
      candidate = path.join(parent, `${name}-${i}`)
      i++
    }
    return candidate
  }

  const zipDirectory = (src: string, dest: string): Promise<void> =>
    new Promise((resolve, reject) => {
      mkdirSync(path.dirname(dest), { recursive: true })
      const output = createWriteStream(dest)
      const createArchive = archiverNs as unknown as (
        format: string,
        options?: Record<string, unknown>
      ) => import('archiver').Archiver
      const archive = createArchive('zip', { zlib: { level: 9 } })
      output.on('close', () => resolve())
      output.on('error', reject)
      archive.on('error', reject)
      archive.pipe(output)
      archive.directory(src, false)
      void archive.finalize()
    })

  ipcMain.handle('relay:bootstrap', async (): Promise<AppBootstrap> => {
    const schema = reader.getSchema()
    return {
      appVersion: app.getVersion(),
      zcodeDbPath: deps.zcodeDbPath,
      zcodeReadable: schema.compatible,
      zcodeError: schema.compatible ? null : schema.detail,
      schema: { compatible: schema.compatible, missing: schema.missing, detail: schema.detail },
      attached: observer.listAttached(),
      settings: publicSettings(),
      connectors: await connectors.list(),
      demoMode: false
    }
  })

  ipcMain.handle('relay:list-sessions', async (_event, query?: string): Promise<{ sessions: SessionSummary[]; error: string | null }> => {
    try {
      const all = reader.listSessions(500)
      const q = (query || '').trim().toLowerCase().slice(0, 200)
      const sessions = q
        ? all.filter(
            (s) =>
              s.title.toLowerCase().includes(q) ||
              s.directory.toLowerCase().includes(q) ||
              s.id.toLowerCase().includes(q)
          )
        : all
      return { sessions, error: null }
    } catch (error) {
      return { sessions: [], error: error instanceof Error ? error.message : String(error) }
    }
  })

  ipcMain.handle('relay:attach', async (_event, request: AttachRequest): Promise<AttachedSession> => {
    // The renderer adds the returned session (with its real eventCount) to its
    // list. sync() already emitted inserted records, so no extra event here.
    return observer.attach(request.sessionId, request.projectRoot)
  })

  ipcMain.handle('relay:detach', async (_event, sessionId: string): Promise<void> => {
    observer.detach(sessionId)
  })

  ipcMain.handle('relay:set-paused', async (_event, sessionId: string, paused: boolean): Promise<AttachedSession> => {
    const session = observer.setPaused(sessionId, paused)
    if (!paused) void observer.sync(sessionId, true).catch(() => undefined)
    return session
  })

  ipcMain.handle('relay:refresh', async (_event, sessionId: string): Promise<SyncResult> => {
    return observer.sync(sessionId, true)
  })

  ipcMain.handle('relay:timeline', async (_event, sessionId: string, limit?: number): Promise<TimelineResponse> => {
    return observer.getTimeline(sessionId, Math.min(Math.max(limit || 5000, 50), 20_000))
  })

  ipcMain.handle('relay:recovery', async (_event, sessionId: string) => {
    const ctx = await ctxFor(sessionId)
    return buildRecoveryBrief(ctx)
  })

  ipcMain.handle('relay:recovery-markdown', async (_event, sessionId: string): Promise<string> => {
    const ctx = await ctxFor(sessionId)
    return recoveryMarkdown(buildRecoveryBrief(ctx))
  })

  ipcMain.handle('relay:git-evidence', async (_event, sessionId: string): Promise<GitEvidence> => {
    const ctx = await ctxFor(sessionId)
    return ctx.git
  })

  ipcMain.handle('relay:refresh-git', async (_event, sessionId: string): Promise<GitEvidence> => {
    const ctx = await ctxFor(sessionId)
    return ctx.git
  })

  ipcMain.handle('relay:choose-project-root', async (_event, defaultPath: string): Promise<string | null> => {
    const win = deps.getWindow()
    const result = await dialog.showOpenDialog(win!, {
      title: '选择要交接的项目目录',
      defaultPath: defaultPath || undefined,
      properties: ['openDirectory']
    })
    return result.canceled || !result.filePaths.length ? null : result.filePaths[0]
  })

  ipcMain.handle('relay:save-selected-files', async (_event, sessionId: string, files: string[] | null): Promise<AttachedSession> => {
    if (files !== null) {
      if (!Array.isArray(files) || files.length > 5000) throw new Error('文件选择数量不合法')
      for (const f of files) {
        if (typeof f !== 'string' || !f || path.isAbsolute(f) || f.includes('\0')) throw new Error('文件路径不合法')
        const normalised = f.replace(/\\/g, '/')
        if (normalised.split('/').some((seg) => seg === '..')) throw new Error('文件路径包含 ..')
      }
    }
    return observer.saveSelectedFiles(sessionId, files)
  })

  ipcMain.handle('relay:preview-pack', async (_event, request: PackRequest): Promise<PackPreview> => {
    validatePackRequest(request)
    const { preview } = await previewPlan(request)
    return preview
  })

  ipcMain.handle('relay:export-pack', async (_event, request: PackRequest, format?: 'folder' | 'zip'): Promise<ExportResult> => {
    validatePackRequest(request)
    const ctx = await ctxFor(request.sessionId)
    const plan = await preparePack(ctx, request)
    const staging = path.join(app.getPath('userData'), 'tmp', `export-${randomUUID()}`)
    try {
      const { manifest } = writePack(plan, staging)
      const name = packDirName(request.sessionId)
      if (format === 'zip') {
        const win = deps.getWindow()
        const result = await dialog.showSaveDialog(win!, {
          title: '保存交接包 ZIP',
          defaultPath: path.join(app.getPath('downloads'), `${name}.zip`),
          filters: [{ name: 'ZIP', extensions: ['zip'] }]
        })
        if (result.canceled || !result.filePath) {
          return { ok: false, directory: null, zipPath: null, manifestPath: null, fileCount: 0, totalBytes: 0, error: '已取消' }
        }
        const dest = result.filePath.toLowerCase().endsWith('.zip') ? result.filePath : `${result.filePath}.zip`
        const tempZip = `${dest}.part`
        await zipDirectory(staging, tempZip)
        try {
          renameSync(tempZip, dest)
        } catch {
          rmSync(tempZip, { force: true })
          await zipDirectory(staging, dest)
        }
        allowedOpenPaths.add(dest)
        logger.info(`export-zip session=${request.sessionId} files=${manifest.fileCount}`)
        return {
          ok: true,
          directory: null,
          zipPath: dest,
          manifestPath: null,
          fileCount: manifest.fileCount,
          totalBytes: manifest.totalBytes,
          error: null
        }
      }
      const win = deps.getWindow()
      const result = await dialog.showOpenDialog(win!, {
        title: '选择交接包保存位置',
        defaultPath: app.getPath('downloads'),
        properties: ['openDirectory', 'createDirectory']
      })
      if (result.canceled || !result.filePaths.length) {
        return { ok: false, directory: null, zipPath: null, manifestPath: null, fileCount: 0, totalBytes: 0, error: '已取消' }
      }
      const dest = uniqueDir(result.filePaths[0], name)
      copyPackTo(staging, dest)
      allowedOpenPaths.add(dest)
      logger.info(`export-folder session=${request.sessionId} files=${manifest.fileCount}`)
      return {
        ok: true,
        directory: dest,
        zipPath: null,
        manifestPath: path.join(dest, 'manifest.json'),
        fileCount: manifest.fileCount,
        totalBytes: manifest.totalBytes,
        error: null
      }
    } finally {
      try {
        rmSync(staging, { recursive: true, force: true })
      } catch {
        // ignore
      }
    }
  })

  ipcMain.handle('relay:get-summary', async (_event, sessionId: string): Promise<SummaryDraft | null> => {
    const ctx = await ctxFor(sessionId)
    return markStale(ctx.summary, ctx)
  })

  ipcMain.handle('relay:generate-summary', async (_event, sessionId: string, forceTemplate?: boolean): Promise<SummaryDraft> => {
    const ctx = await ctxFor(sessionId)
    const draft = await summaries.generate(ctx, forceTemplate === true)
    observer.saveSummary(sessionId, draft)
    return draft
  })

  ipcMain.handle('relay:save-summary', async (_event, sessionId: string, input: Record<string, string>): Promise<SummaryDraft> => {
    const ctx = await ctxFor(sessionId)
    const existing = ctx.summary
    const sections = { ...(existing?.sections || summaries.templateDraft(ctx).sections) }
    for (const def of SUMMARY_SECTIONS) {
      if (typeof input[def.key] === 'string') sections[def.key] = input[def.key]
    }
    const text = SUMMARY_SECTIONS.map((d) => sections[d.key] || '').join('\n\n')
    const valid = new Set(buildEvidenceBundle(ctx).ids)
    const draft: SummaryDraft = {
      sessionId,
      sections,
      generatedAt: existing?.generatedAt || Date.now(),
      source: existing?.source === 'ai' ? 'edited-ai' : 'edited-template',
      model: existing?.model || null,
      evidenceHash: computeEvidenceHash(ctx),
      citations: checkCitations(text, valid),
      error: null,
      stale: false
    }
    observer.saveSummary(sessionId, draft)
    return draft
  })

  ipcMain.handle('relay:settings', async (): Promise<PublicSettings> => publicSettings())

  ipcMain.handle(
    'relay:save-settings',
    async (
      _event,
      input: { baseUrl: string; model: string; temperature: number; apiKey?: string; keepKey?: boolean }
    ): Promise<PublicSettings> => {
      settings.save(input)
      return publicSettings()
    }
  )

  ipcMain.handle('relay:test-model', async (): Promise<{ ok: boolean; message: string; latencyMs: number | null }> => {
    return summaries.test()
  })

  ipcMain.handle('relay:connectors', async (): Promise<ConnectorInfo[]> => connectors.list())

  ipcMain.handle('relay:verify-connector', async (_event, connectorId: string, confirmed: boolean): Promise<ConnectorVerification> => {
    return connectors.verify(connectorId, confirmed)
  })

  ipcMain.handle('relay:send', async (_event, request: SendRequest): Promise<SendResult> => {
    validatePackRequest(request)
    if (!request.confirmed) {
      return {
        sent: false,
        connectorId: request.connectorId,
        verified: false,
        reason: 'not-confirmed',
        message: '发送前必须由用户确认接收目标和内容。',
        output: null,
        exitCode: null,
        durationMs: null,
        packDirectory: null
      }
    }
    if (request.connectorId === 'zcode-session') {
      return {
        sent: false,
        connectorId: request.connectorId,
        verified: false,
        reason: 'unsupported',
        message: 'Z-Code 没有公开的外部发送入口。请导出交接包，再在目标会话里手动粘贴接力指令。',
        output: null,
        exitCode: null,
        durationMs: null,
        packDirectory: null
      }
    }
    const ctx = await ctxFor(request.sessionId)
    const plan = await preparePack(ctx, request)
    const pendingRoot = path.join(app.getPath('userData'), 'pending')
    mkdirSync(pendingRoot, { recursive: true })
    const packDir = uniqueDir(pendingRoot, packDirName(request.sessionId))
    writePack(plan, packDir)
    allowedOpenPaths.add(packDir)
    const result = await connectors.send(request, packDir, ctx.row.projectRoot)
    return { ...result, packDirectory: packDir }
  })

  ipcMain.handle('relay:copy-text', async (_event, text: string): Promise<{ ok: boolean }> => {
    if (typeof text !== 'string' || text.length > 2_000_000) throw new Error('复制内容不合法')
    clipboard.writeText(text)
    return { ok: true }
  })

  ipcMain.handle('relay:open-path', async (_event, target: string): Promise<{ ok: boolean; error: string | null }> => {
    if (!allowedOpenPaths.has(target)) {
      return { ok: false, error: '只能打开本次导出或发送生成的交接包' }
    }
    const error = await shell.openPath(target)
    return { ok: !error, error: error || null }
  })

  ipcMain.handle('relay:reveal-path', async (_event, target: string): Promise<void> => {
    if (!allowedOpenPaths.has(target)) return
    shell.showItemInFolder(target)
  })

  // Keep the compiler honest about unused imports that are part of the public surface.
  void assertInside
  void safeJoin
  void store
}

function validatePackRequest(request: PackRequest): void {
  if (!request || typeof request.sessionId !== 'string' || !request.sessionId.startsWith('sess_')) {
    throw new Error('会话 ID 不合法')
  }
  if (request.mode !== 'review' && request.mode !== 'implement') throw new Error('接力模式不合法')
  if (!Array.isArray(request.filePaths) || request.filePaths.length > 5000) throw new Error('文件列表不合法')
  for (const f of request.filePaths) {
    if (typeof f !== 'string' || !f || path.isAbsolute(f) || f.includes('\0')) throw new Error('文件路径不合法')
    if (f.replace(/\\/g, '/').split('/').some((seg) => seg === '..')) throw new Error('文件路径包含 ..')
  }
  if (typeof request.extraNotes !== 'string' || request.extraNotes.length > 20_000) throw new Error('补充说明过长')
}

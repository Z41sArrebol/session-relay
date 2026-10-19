import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { Logger } from '../../src/main/core/log'
import { RelayStore } from '../../src/main/core/state'
import { ZcodeReader } from '../../src/main/core/zcode/reader'
import { Observer } from '../../src/main/core/observer'
import { getGitEvidence } from '../../src/main/core/git'
import { preparePack, writePack } from '../../src/main/core/handoff'
import { defaultZcodeDbPath, formatBytes, shortId } from '../../src/main/core/paths'
import { scanTextContent } from '../../src/main/core/sensitive'

const logger = { info: () => undefined, warn: () => undefined, error: () => undefined } as unknown as Logger

async function main(): Promise<void> {
  const dbPath = defaultZcodeDbPath()
  const reader = new ZcodeReader(dbPath)
  if (!reader.getSchema().compatible) throw new Error(reader.getSchema().detail)
  const explicit = process.env.SESSION_RELAY_REAL_SESSION
  const target =
    (explicit ? reader.getSession(explicit) : null) ||
    reader
      .listSessions(400)
      .find((s) => s.directory.includes('Desktop') && /会话接力台/.test(s.title)) ||
    reader.listSessions(400)[0]
  if (!target) throw new Error('没有可用的真实会话')
  const session = reader.getSession(target.id)
  if (!session) throw new Error('会话不存在')

  const work = mkdtempSync(path.join(os.tmpdir(), 'session-relay-real-demo-'))
  const store = new RelayStore(path.join(work, 'relay.sqlite'))
  const observer = new Observer({ store, reader, logger, emit: () => undefined })
  const projectRoot = process.cwd()
  await observer.attach(session.id, projectRoot)
  const row = observer.getRow(session.id)
  const timeline = observer.getTimeline(session.id)
  const git = await getGitEvidence({
    sessionId: session.id,
    projectRoot,
    baseline: row.baseline,
    live: row.live
  })
  const request = {
    sessionId: session.id,
    mode: 'review' as const,
    filePaths: [] as string[],
    includeFullFiles: false,
    extraNotes: '真实 Z-Code 会话的只读探测演示；未发送给任何外部 Agent。'
  }
  const plan = await preparePack(
    {
      row,
      git,
      timeline: timeline.items,
      tokens: timeline.tokens,
      summary: row.summary,
      todos: store.getTodos(session.id),
      turns: store.getTurns(session.id),
      modelErrorCount: store.countModelErrors(session.id)
    },
    request
  )
  const stamp = new Date().toISOString().replace(/[-:]/g, '').slice(0, 13)
  const outDir = path.join(process.cwd(), 'docs', 'demo', `real-handoff-${stamp}`)
  mkdirSync(outDir, { recursive: true })
  const { manifest } = writePack(plan, outDir)

  const checker = checkPack(outDir, manifest)
  const checkPath = path.join(process.cwd(), 'docs', 'demo', 'real-handoff-check.json')
  mkdirSync(path.dirname(checkPath), { recursive: true })
  writeFileSync(
    checkPath,
    JSON.stringify(
      {
        capturedAt: new Date().toISOString(),
        sessionId: session.id,
        sessionTitle: session.title,
        directory: session.directory,
        live: row.live,
        gitAvailable: git.available,
        eventCounts: timeline.totals,
        tokens: timeline.tokens,
        pack: {
          directory: outDir,
          files: manifest.fileCount,
          bytes: manifest.totalBytes,
          sessionState: manifest.sessionState,
          attribution: manifest.project.attribution,
          sensitiveHits: manifest.sensitiveHits.length
        },
        checker,
        sent: false,
        note: '真实会话只读接入与导出已完成；按用户要求未把真实内容发送给外部 Agent。'
      },
      null,
      2
    ),
    'utf8'
  )

  console.log(
    JSON.stringify(
      {
        ok: true,
        sessionId: session.id,
        title: session.title,
        eventCounts: timeline.totals,
        tokens: timeline.tokens,
        gitAvailable: git.available,
        packDir: outDir,
        files: manifest.fileCount,
        bytes: manifest.totalBytes,
        sensitiveHits: manifest.sensitiveHits.length,
        checker
      },
      null,
      2
    )
  )
  reader.close()
  store.close()
  rmSync(work, { recursive: true, force: true })
}

function checkPack(dir: string, manifest: { files: Array<{ path: string; bytes: number; sha256: string }> }): {
  manifestHashesMatch: boolean
  checkedFiles: number
  handoffSections: number
  timelineLines: number
  reasoningLeaked: boolean
  hasEvidenceIndex: boolean
  secretHits: string[]
} {
  let manifestHashesMatch = true
  let checkedFiles = 0
  const all = walk(dir)
  for (const f of manifest.files) {
    const abs = path.join(dir, f.path)
    if (!existsSync(abs)) {
      manifestHashesMatch = false
      continue
    }
    const data = readFileSync(abs)
    if (data.length !== f.bytes) manifestHashesMatch = false
    if (createHash('sha256').update(data).digest('hex') !== f.sha256) manifestHashesMatch = false
    checkedFiles++
  }
  if (all.filter((p) => p !== 'manifest.json').length !== manifest.files.length) manifestHashesMatch = false
  const handoff = readFileSync(path.join(dir, 'HANDOFF.md'), 'utf8')
  const handoffSections = (handoff.match(/^## \d+\. /gm) || []).length
  const hasEvidenceIndex = handoff.includes('## 证据索引')
  const timelineText = readFileSync(path.join(dir, 'session', 'timeline.jsonl'), 'utf8')
  const timelineLines = timelineText.split('\n').filter(Boolean).length
  const reasoningLeaked = timelineText.includes('"kind":"reasoning"')
  const secretHits: string[] = []
  for (const f of all) {
    if (['manifest.json'].includes(f)) continue
    const abs = path.join(dir, f)
    if (statSync(abs).size > 2 * 1024 * 1024) continue
    const text = readFileSync(abs, 'utf8')
    for (const reason of scanTextContent(text).reasons) secretHits.push(`${f}: ${reason}`)
  }
  return {
    manifestHashesMatch,
    checkedFiles,
    handoffSections,
    timelineLines,
    reasoningLeaked,
    hasEvidenceIndex,
    secretHits
  }
}

function walk(root: string, prefix = ''): string[] {
  const out: string[] = []
  for (const entry of readdirSync(path.join(root, prefix), { withFileTypes: true })) {
    const rel = prefix ? `${prefix}/${entry.name}` : entry.name
    const abs = path.join(root, rel)
    if (statSync(abs).isDirectory()) out.push(...walk(root, rel))
    else out.push(rel)
  }
  return out
}

void formatBytes
void shortId

main().catch((error) => {
  console.error(error)
  process.exit(1)
})

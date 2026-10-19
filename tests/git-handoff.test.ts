import type { Logger } from '../src/main/core/log'
import { describe, expect, it, beforeAll, afterAll } from 'vitest'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync, symlinkSync } from 'node:fs'
import path from 'node:path'
import { RelayStore } from '../src/main/core/state'
import { ZcodeReader } from '../src/main/core/zcode/reader'
import { Observer } from '../src/main/core/observer'
import { captureBaseline, getGitEvidence } from '../src/main/core/git'
import { preparePack, writePack, type PackContext } from '../src/main/core/handoff'
import { createZcodeFixture, git, type Fixture } from './fixtures/zcode'

const silentLogger = { info: () => undefined, warn: () => undefined, error: () => undefined } as unknown as Logger

describe('Git evidence and handoff pack', () => {
  let fixture: Fixture
  let reader: ZcodeReader
  let store: RelayStore
  let observer: Observer
  let ctx: PackContext

  beforeAll(async () => {
    fixture = createZcodeFixture()
    reader = new ZcodeReader(fixture.dbPath)
    store = new RelayStore(fixture.storePath)
    observer = new Observer({ store, reader, logger: silentLogger, emit: () => undefined })
    await observer.attach(fixture.sessionA, fixture.projectRoot)
    const row = observer.getRow(fixture.sessionA)
    const gitEvidence = await getGitEvidence({
      sessionId: fixture.sessionA,
      projectRoot: fixture.projectRoot,
      baseline: row.baseline,
      live: row.live
    })
    const timeline = observer.getTimeline(fixture.sessionA)
    ctx = { row, git: gitEvidence, timeline: timeline.items, tokens: timeline.tokens, summary: null }
  })

  afterAll(() => {
    reader.close()
    store.close()
    fixture.cleanup()
  })

  it('records a baseline and distinguishes pre-existing changes from changes during observation', async () => {
    expect(ctx.row.baseline.info.hasBaseline).toBe(true)
    const before = new Map([...ctx.git.buckets.unstaged, ...ctx.git.buckets.untracked].map((f) => [f.path, f]))
    expect(before.get('README.md')?.preExisting).toBe(true)
    expect(before.get('notes.txt')?.preExisting).toBe(true)
    expect(before.get('later.txt')?.changedSinceBaseline).toBe(false)

    writeFileSync(path.join(fixture.projectRoot, 'later.txt'), 'after observation\n', 'utf8')
    const updated = await getGitEvidence({
      sessionId: fixture.sessionA,
      projectRoot: fixture.projectRoot,
      baseline: ctx.row.baseline,
      live: ctx.row.live
    })
    const later = [...updated.buckets.unstaged, ...updated.buckets.untracked].find((f) => f.path === 'later.txt')!
    expect(later.preExisting).toBe(true)
    expect(later.changedSinceBaseline).toBe(true)
    expect(updated.attribution).toBe('partial')
  })

  it('marks attribution unknown without a baseline', async () => {
    const empty = {
      info: {
        id: 'none',
        capturedAt: 0,
        hasBaseline: false,
        head: null,
        gitRoot: null,
        note: 'no baseline'
      },
      files: {},
      statusText: ''
    }
    const evidence = await getGitEvidence({
      sessionId: fixture.sessionA,
      projectRoot: fixture.projectRoot,
      baseline: empty,
      live: ctx.row.live
    })
    expect(evidence.attribution).toBe('unknown')
    expect(evidence.attributionNote).toContain('无法确认')
  })

  it('builds a pack whose manifest matches every written file', async () => {
    const plan = await preparePack(ctx, {
      sessionId: fixture.sessionA,
      mode: 'review',
      filePaths: ['README.md', 'notes.txt', 'later.txt'],
      includeFullFiles: false,
      extraNotes: '只验收登录流程。'
    })
    const dir = path.join(fixture.root, 'pack-test')
    const { manifest, files } = writePack(plan, dir)
    expect(files.some((f) => f.path === 'HANDOFF.md')).toBe(true)
    expect(files.some((f) => f.path === 'session/excerpt.md')).toBe(true)
    expect(files.some((f) => f.path === 'changes/diff-unstaged.patch')).toBe(true)
    expect(manifest.fileCount).toBe(manifest.files.length)
    expect(manifest.totalBytes).toBe(manifest.files.reduce((n, f) => n + f.bytes, 0))
    for (const f of manifest.files) {
      const abs = path.join(dir, f.path)
      expect(existsSync(abs)).toBe(true)
      const data = readFileSync(abs)
      expect(createHash('sha256').update(data).digest('hex')).toBe(f.sha256)
    }
    const walked = walk(dir).filter((p) => p !== 'manifest.json')
    expect(walked.sort()).toEqual(manifest.files.map((f) => f.path).sort())
    expect(plan.markdown).toContain('独立验收')
    expect(plan.markdown).toContain('只验收登录流程')
    expect(plan.markdown).toContain('未经核实')
  })

  it('excludes sensitive files by default and reports the hit', async () => {
    const envPath = path.join(fixture.projectRoot, '.env')
    writeFileSync(envPath, 'api_key = "fixture-placeholder-not-a-real-secret"\n', 'utf8')
    const evidence = await getGitEvidence({
      sessionId: fixture.sessionA,
      projectRoot: fixture.projectRoot,
      baseline: ctx.row.baseline,
      live: ctx.row.live
    })
    const localCtx: PackContext = { ...ctx, git: evidence }
    const plan = await preparePack(localCtx, {
      sessionId: fixture.sessionA,
      mode: 'review',
      filePaths: ['.env'],
      includeFullFiles: true,
      extraNotes: ''
    })
    expect(plan.entries.some((e) => e.path.includes('.env'))).toBe(false)
    expect(plan.excluded.some((e) => e.path === '.env')).toBe(true)
    expect(plan.sensitiveHits.some((h) => h.path === '.env')).toBe(true)
  })

  it('excludes oversized files', async () => {
    const big = path.join(fixture.projectRoot, 'big.bin')
    writeFileSync(big, Buffer.alloc(5 * 1024 * 1024, 7))
    const evidence = await getGitEvidence({
      sessionId: fixture.sessionA,
      projectRoot: fixture.projectRoot,
      baseline: ctx.row.baseline,
      live: ctx.row.live
    })
    const plan = await preparePack(
      { ...ctx, git: evidence },
      {
        sessionId: fixture.sessionA,
        mode: 'review',
        filePaths: ['big.bin'],
        includeFullFiles: true,
        extraNotes: ''
      }
    )
    expect(plan.entries.some((e) => e.path.includes('big.bin'))).toBe(false)
    expect(plan.excluded.find((e) => e.path === 'big.bin')?.reason).toContain('超过')
  })

  it('skips unknown and traversal-like paths instead of reading them', async () => {
    const plan = await preparePack(ctx, {
      sessionId: fixture.sessionA,
      mode: 'review',
      filePaths: ['../outside.txt', 'not-in-git.txt'],
      includeFullFiles: true,
      extraNotes: ''
    })
    expect(plan.warnings.join(' ')).toContain('不在当前 Git 变更中')
    expect(plan.entries.every((e) => !e.path.includes('outside'))).toBe(true)
  })

  it('never follows a symlink out of the project', async () => {
    const outside = path.join(fixture.root, 'outside-secret.txt')
    writeFileSync(outside, 'outside secret\n', 'utf8')
    const link = path.join(fixture.projectRoot, 'linked-secret.txt')
    try {
      symlinkSync(outside, link, 'file')
    } catch {
      return // Windows without symlink privilege: covered by the path check in code
    }
    const evidence = await getGitEvidence({
      sessionId: fixture.sessionA,
      projectRoot: fixture.projectRoot,
      baseline: ctx.row.baseline,
      live: ctx.row.live
    })
    const plan = await preparePack(
      { ...ctx, git: evidence },
      {
        sessionId: fixture.sessionA,
        mode: 'review',
        filePaths: ['linked-secret.txt'],
        includeFullFiles: true,
        extraNotes: ''
      }
    )
    expect(plan.entries.some((e) => e.path.includes('linked-secret'))).toBe(false)
    expect(plan.excluded.some((e) => e.path === 'linked-secret.txt')).toBe(true)
  })

  it('warns when session evidence itself contains a secret-like value', async () => {
    const leaked = {
      ...ctx.timeline[0],
      id: 'leak-event',
      messageId: 'leak-message',
      kind: 'assistant' as const,
      text: '配置示例：api_key = "fixture-placeholder-not-a-real-secret"'
    }
    const plan = await preparePack(
      { ...ctx, timeline: [...ctx.timeline, leaked] },
      {
        sessionId: fixture.sessionA,
        mode: 'review',
        filePaths: [],
        includeFullFiles: false,
        extraNotes: ''
      }
    )
    expect(plan.sensitiveHits.some((h) => h.path.startsWith('session/'))).toBe(true)
    expect(plan.warnings.join(' ')).toContain('会话摘录')
  })

  it('marks an in-progress session snapshot', async () => {
    const runningLive = { ...ctx.row.live, state: 'running' as const }
    const evidence = await getGitEvidence({
      sessionId: fixture.sessionA,
      projectRoot: fixture.projectRoot,
      baseline: ctx.row.baseline,
      live: runningLive
    })
    expect(evidence.snapshotState).toBe('in_progress')
    const plan = await preparePack({ ...ctx, git: evidence }, {
      sessionId: fixture.sessionA,
      mode: 'review',
      filePaths: [],
      includeFullFiles: false,
      extraNotes: ''
    })
    expect(plan.warnings.join(' ')).toContain('进行中快照')
    expect(plan.markdown).toContain('进行中快照')
  })
})

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

import { execFile } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import path from 'node:path'
import { promisify } from 'node:util'
import type { BaselineInfo, GitCommit, GitEvidence, GitFile, LiveState } from '../../shared/types'
import type { BaselineFileSnapshot, BaselineSnapshot } from './state'
import { sha256File, fileSize, safeJoin, toPosix, isInside, sha256Text, dirExists } from './paths'
import { inspectPath } from './sensitive'

const execFileAsync = promisify(execFile)
const MAX_HASH_BYTES = 8 * 1024 * 1024

export interface GitRunResult {
  ok: boolean
  stdout: string
  stderr: string
  code: number
}

export async function runGit(cwd: string, args: string[], maxBuffer = 24 * 1024 * 1024): Promise<GitRunResult> {
  try {
    const { stdout, stderr } = await execFileAsync('git', ['-C', cwd, ...args], {
      encoding: 'utf8',
      maxBuffer,
      windowsHide: true,
      env: {
        ...process.env,
        GIT_OPTIONAL_LOCKS: '0',
        LC_ALL: 'C',
        GIT_TERMINAL_PROMPT: '0'
      }
    })
    return { ok: true, stdout, stderr, code: 0 }
  } catch (error) {
    const e = error as { stdout?: string; stderr?: string; code?: number; message?: string }
    return { ok: false, stdout: e.stdout || '', stderr: e.stderr || e.message || '', code: typeof e.code === 'number' ? e.code : 1 }
  }
}

export async function detectGitRoot(projectRoot: string): Promise<string | null> {
  if (!dirExists(projectRoot)) return null
  const inside = await runGit(projectRoot, ['rev-parse', '--is-inside-work-tree'])
  if (!inside.ok || inside.stdout.trim() !== 'true') return null
  const top = await runGit(projectRoot, ['rev-parse', '--show-toplevel'])
  if (!top.ok) return null
  const root = top.stdout.trim()
  return root ? path.resolve(root) : null
}

export async function currentHead(gitRoot: string): Promise<string | null> {
  const r = await runGit(gitRoot, ['rev-parse', 'HEAD'])
  return r.ok ? r.stdout.trim() || null : null
}

interface PorcelainEntry {
  xy: string
  path: string
  origPath?: string
  kind: 'tracked' | 'untracked' | 'unmerged' | 'renamed'
}

interface ParsedStatus {
  branch: string | null
  head: string | null
  entries: PorcelainEntry[]
  raw: string
}

export function parsePorcelainV2(raw: string): ParsedStatus {
  const records = raw.split('\0')
  const entries: PorcelainEntry[] = []
  let branch: string | null = null
  let head: string | null = null
  for (let i = 0; i < records.length; i++) {
    const rec = records[i]
    if (!rec) continue
    if (rec.startsWith('# branch.head ')) {
      branch = rec.slice('# branch.head '.length)
      continue
    }
    if (rec.startsWith('# branch.oid ')) {
      head = rec.slice('# branch.oid '.length)
      continue
    }
    if (rec.startsWith('# ')) continue
    const type = rec[0]
    if (type === '1') {
      const fields = rec.slice(2).split(' ')
      const xy = fields[0] || '..'
      const filePath = fields.slice(7).join(' ')
      if (filePath) entries.push({ xy, path: filePath, kind: 'tracked' })
    } else if (type === '2') {
      const fields = rec.slice(2).split(' ')
      const xy = fields[0] || '..'
      const filePath = fields.slice(8).join(' ')
      const origPath = records[i + 1]
      if (origPath !== undefined) i++
      if (filePath) entries.push({ xy, path: filePath, origPath, kind: 'renamed' })
    } else if (type === '?') {
      const filePath = rec.slice(2)
      if (filePath) entries.push({ xy: '??', path: filePath, kind: 'untracked' })
    } else if (type === 'u') {
      const fields = rec.slice(2).split(' ')
      const xy = fields[0] || 'UU'
      const filePath = fields.slice(9).join(' ')
      if (filePath) entries.push({ xy, path: filePath, kind: 'unmerged' })
    }
  }
  return { branch, head, entries, raw }
}

async function readStatus(projectRoot: string): Promise<{ parsed: ParsedStatus | null; gitRoot: string | null; error: string | null }> {
  const gitRoot = await detectGitRoot(projectRoot)
  if (!gitRoot) return { parsed: null, gitRoot: null, error: '所选目录不是 Git 工作区' }
  const r = await runGit(gitRoot, ['status', '--porcelain=v2', '-z', '--untracked-files=all', '--branch'])
  if (!r.ok) return { parsed: null, gitRoot, error: r.stderr || 'git status 失败' }
  return { parsed: parsePorcelainV2(r.stdout), gitRoot, error: null }
}

function baselineFile(gitRoot: string, pathFromRepo: string): BaselineFileSnapshot | null {
  let abs: string
  try {
    abs = safeJoin(gitRoot, pathFromRepo)
  } catch {
    return null
  }
  const size = fileSize(abs)
  const hash = size !== null && size <= MAX_HASH_BYTES ? sha256File(abs) : null
  return { sha256: hash, size, status: '' }
}

export async function captureBaseline(projectRoot: string): Promise<BaselineSnapshot> {
  const capturedAt = Date.now()
  const { parsed, gitRoot, error } = await readStatus(projectRoot)
  if (!parsed || !gitRoot) {
    const info: BaselineInfo = {
      id: `bl-${randomUUID().slice(0, 8)}`,
      capturedAt,
      hasBaseline: false,
      head: null,
      gitRoot: null,
      note: error || '不是 Git 工作区，缺少起始基线',
      reason: error || undefined
    }
    return { info, files: {}, statusText: '' }
  }
  const head = await currentHead(gitRoot)
  const files: Record<string, BaselineFileSnapshot> = {}
  const statusLines: string[] = []
  let count = 0
  for (const entry of parsed.entries) {
    if (count >= 2000) break
    const relToProject = toPosix(path.relative(projectRoot, safeJoin(gitRoot, entry.path)))
    if (relToProject.startsWith('..')) continue
    const risk = inspectPath(relToProject)
    if (risk.buildArtifact) continue
    const snap = baselineFile(gitRoot, entry.path)
    if (!snap) continue
    snap.status = entry.xy
    files[relToProject] = snap
    statusLines.push(`${entry.xy} ${relToProject}`)
    count++
  }
  const headShort = head ? head.slice(0, 8) : 'no-head'
  const info: BaselineInfo = {
    id: `bl-${capturedAt.toString(36)}-${sha256Text(`${head || ''}|${parsed.raw}`).slice(0, 8)}`,
    capturedAt,
    hasBaseline: true,
    head,
    gitRoot,
    note: `接入时已记录基线：HEAD ${headShort}，工作区已有 ${Object.keys(files).length} 个变更文件。`
  }
  return { info, files, statusText: statusLines.join('\n') }
}

function bucketOf(xy: string, kind: PorcelainEntry['kind']): GitFile['bucket'] {
  if (kind === 'untracked' || xy === '??') return 'untracked'
  const x = xy[0] || '.'
  const y = xy[1] || '.'
  const staged = x !== '.' && x !== '?' && x !== ' '
  const unstaged = y !== '.' && y !== '?' && y !== ' '
  if (staged && unstaged) return 'both'
  if (staged) return 'staged'
  return 'unstaged'
}

export async function getGitEvidence(input: {
  sessionId: string
  projectRoot: string
  baseline: BaselineSnapshot
  live: LiveState
}): Promise<GitEvidence> {
  const capturedAt = Date.now()
  const { parsed, gitRoot, error } = await readStatus(input.projectRoot)
  const snapshotState = input.live.state === 'running' ? 'in_progress' : 'idle'
  if (!parsed || !gitRoot) {
    return {
      sessionId: input.sessionId,
      available: false,
      reason: error || 'Git 不可用',
      capturedAt,
      projectRoot: input.projectRoot,
      gitRoot: null,
      branch: null,
      head: null,
      baseline: input.baseline.info,
      attribution: 'unknown',
      attributionNote: '没有 Git 基线，无法确认项目变更归属。',
      buckets: { staged: [], unstaged: [], untracked: [] },
      commitsSinceBaseline: [],
      statusText: '',
      diffStat: { staged: '', unstaged: '' },
      snapshotState
    }
  }

  const head = await currentHead(gitRoot)
  const files: GitFile[] = []
  for (const entry of parsed.entries) {
    let abs: string
    try {
      abs = safeJoin(gitRoot, entry.path)
    } catch {
      continue
    }
    if (!isInside(input.projectRoot, abs)) continue
    const rel = toPosix(path.relative(input.projectRoot, abs))
    if (!rel || rel.startsWith('..')) continue
    const risk = inspectPath(rel)
    if (risk.buildArtifact) continue
    const base = input.baseline.files[rel]
    const size = fileSize(abs)
    const hash = base && size !== null && size <= MAX_HASH_BYTES ? sha256File(abs) : null
    const exists = size !== null
    const preExisting = Boolean(base)
    let changedSinceBaseline = false
    if (input.baseline.info.hasBaseline) {
      changedSinceBaseline = !base || (hash !== null && base.sha256 !== null && hash !== base.sha256)
    }
    let attribution: GitFile['attribution'] = 'unknown'
    if (input.baseline.info.hasBaseline) {
      if (!base) attribution = 'changed-during-observation'
      else if (hash !== null && base.sha256 !== null && hash !== base.sha256) attribution = 'changed-during-observation'
      else if (base) attribution = 'pre-existing'
    }
    const selectable = !risk.buildArtifact && !risk.sensitive && exists
    files.push({
      path: rel,
      bucket: bucketOf(entry.xy, entry.kind),
      indexStatus: entry.xy[0] || '.',
      worktreeStatus: entry.xy[1] || '.',
      size,
      sha256: hash,
      preExisting,
      changedSinceBaseline,
      attribution,
      sensitive: risk.sensitive,
      sensitiveReasons: risk.reasons,
      selectable,
      excludedReason: risk.buildArtifact
        ? '构建/依赖目录，默认排除'
        : risk.sensitive
          ? '疑似敏感文件，默认排除'
          : !exists
            ? '文件已删除，仅保留 diff'
            : null
    })
  }

  const stagedPaths = files.filter((f) => f.bucket === 'staged' || f.bucket === 'both').map((f) => f.path)
  const unstagedPaths = files.filter((f) => f.bucket === 'unstaged' || f.bucket === 'both').map((f) => f.path)
  const statArgs = (args: string[]) => runGit(gitRoot, args)
  const [stagedStat, unstagedStat] = await Promise.all([
    stagedPaths.length ? statArgs(['diff', '--cached', '--stat', '--', ...stagedPaths]) : Promise.resolve({ ok: true, stdout: '', stderr: '', code: 0 }),
    unstagedPaths.length ? statArgs(['diff', '--stat', '--', ...unstagedPaths]) : Promise.resolve({ ok: true, stdout: '', stderr: '', code: 0 })
  ])

  let commits: GitCommit[] = []
  if (input.baseline.info.hasBaseline && input.baseline.info.head && head && input.baseline.info.head !== head) {
    const r = await runGit(gitRoot, [
      'log',
      '--format=%H%x1f%h%x1f%an%x1f%at%x1f%s',
      `${input.baseline.info.head}..${head}`
    ])
    if (r.ok) {
      commits = r.stdout
        .split('\n')
        .filter(Boolean)
        .map((line) => {
          const [hash, shortHash, author, at, ...rest] = line.split('\x1f')
          return {
            hash: hash || '',
            shortHash: shortHash || '',
            author: author || '',
            time: Number(at) * 1000 || 0,
            subject: rest.join('\x1f')
          }
        })
    }
  }

  const statusLines = files.map((f) => `${f.indexStatus}${f.worktreeStatus} ${f.path}`)
  const attribution = input.baseline.info.hasBaseline ? 'partial' : 'unknown'
  const attributionNote = input.baseline.info.hasBaseline
    ? '已记录接入时基线：可区分接入前已有修改与观察窗口内新增修改；但无法区分窗口内修改来自 Agent 还是用户操作。'
    : '缺少起始基线：无法确认全部变更归属，所有文件均标记为“归属未知”。'

  return {
    sessionId: input.sessionId,
    available: true,
    reason: null,
    capturedAt,
    projectRoot: input.projectRoot,
    gitRoot,
    branch: parsed.branch,
    head,
    baseline: input.baseline.info,
    attribution,
    attributionNote,
    buckets: {
      staged: files.filter((f) => f.bucket === 'staged' || f.bucket === 'both'),
      unstaged: files.filter((f) => f.bucket === 'unstaged' || f.bucket === 'both'),
      untracked: files.filter((f) => f.bucket === 'untracked')
    },
    commitsSinceBaseline: commits,
    statusText: statusLines.join('\n'),
    diffStat: { staged: stagedStat.stdout.trim(), unstaged: unstagedStat.stdout.trim() },
    snapshotState
  }
}

export async function getDiffs(
  gitRoot: string,
  files: Array<{ path: string; bucket: GitFile['bucket'] }>
): Promise<{ unstaged: string; staged: string }> {
  const staged = files.filter((f) => f.bucket === 'staged' || f.bucket === 'both')
  const unstaged = files.filter((f) => f.bucket === 'unstaged' || f.bucket === 'both')
  const [a, b] = await Promise.all([
    staged.length
      ? runGit(gitRoot, ['diff', '--cached', '--no-color', '--', ...staged.map((f) => f.path)])
      : Promise.resolve({ ok: true, stdout: '', stderr: '', code: 0 }),
    unstaged.length
      ? runGit(gitRoot, ['diff', '--no-color', '--', ...unstaged.map((f) => f.path)])
      : Promise.resolve({ ok: true, stdout: '', stderr: '', code: 0 })
  ])
  return { staged: a.ok ? a.stdout : `git diff --cached 失败：${a.stderr}`, unstaged: b.ok ? b.stdout : `git diff 失败：${b.stderr}` }
}

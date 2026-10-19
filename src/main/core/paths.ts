import { createHash } from 'node:crypto'
import { existsSync, lstatSync, readFileSync, realpathSync, statSync } from 'node:fs'
import path from 'node:path'

export class RelayError extends Error {
  code: string
  constructor(code: string, message: string) {
    super(message)
    this.code = code
  }
}

export function expandHome(input: string): string {
  if (input === '~') return process.env.USERPROFILE || process.env.HOME || input
  if (input.startsWith('~/') || input.startsWith('~\\')) {
    return path.join(process.env.USERPROFILE || process.env.HOME || '', input.slice(2))
  }
  return input
}

export function defaultZcodeDbPath(): string {
  const override = process.env.SESSION_RELAY_ZCODE_DB
  if (override && override.trim()) return path.resolve(expandHome(override.trim()))
  const home = process.env.USERPROFILE || process.env.HOME || ''
  return path.join(home, '.zcode', 'cli', 'db', 'db.sqlite')
}

export function toPosix(p: string): string {
  return p.replace(/\\/g, '/')
}

export function isInside(root: string, target: string): boolean {
  const rel = path.relative(path.resolve(root), path.resolve(target))
  if (rel === '') return true
  if (rel.startsWith('..') || path.isAbsolute(rel)) {
    // Windows paths are case-insensitive; retry with normalised case.
    const a = path.resolve(root).toLowerCase()
    const b = path.resolve(target).toLowerCase()
    const rel2 = path.relative(a, b)
    return rel2 === '' || (!rel2.startsWith('..') && !path.isAbsolute(rel2))
  }
  return true
}

export function assertInside(root: string, target: string): string {
  if (!isInside(root, target)) {
    throw new RelayError('path-outside-root', `路径越界：${target}`)
  }
  return path.resolve(target)
}

/** Join a repo-relative path to a root, rejecting absolute paths and traversal. */
export function safeJoin(root: string, relativePath: string): string {
  if (!relativePath || path.isAbsolute(relativePath)) {
    throw new RelayError('path-invalid', `非法路径：${relativePath}`)
  }
  const normalised = relativePath.replace(/\//g, path.sep)
  if (normalised.split(path.sep).some((segment) => segment === '..')) {
    throw new RelayError('path-traversal', `路径包含 ..：${relativePath}`)
  }
  const abs = path.resolve(root, normalised)
  assertInside(root, abs)
  return abs
}

export function assertRegularFileNoSymlink(abs: string): void {
  const st = lstatSync(abs)
  if (st.isSymbolicLink()) throw new RelayError('symlink', `拒绝打包符号链接：${abs}`)
  if (!st.isFile()) throw new RelayError('not-file', `不是普通文件：${abs}`)
}

/** Resolve a real path and make sure it stays inside the real root (symlink escape). */
export function assertRealInside(root: string, abs: string): void {
  const realRoot = realpathSync.native(root)
  const real = realpathSync.native(abs)
  if (!isInside(realRoot, real)) throw new RelayError('symlink-escape', `符号链接越界：${abs}`)
}

export function sha256Text(input: string): string {
  return createHash('sha256').update(input, 'utf8').digest('hex')
}

export function sha256File(abs: string): string | null {
  try {
    return createHash('sha256').update(readFileSync(abs)).digest('hex')
  } catch {
    return null
  }
}

export function fileSize(abs: string): number | null {
  try {
    const st = statSync(abs)
    return st.isFile() ? st.size : null
  } catch {
    return null
  }
}

export function existsAsFile(abs: string): boolean {
  try {
    return statSync(abs).isFile()
  } catch {
    return false
  }
}

export function dirExists(abs: string): boolean {
  try {
    return statSync(abs).isDirectory()
  } catch {
    return false
  }
}

export function fileExists(abs: string): boolean {
  return existsSync(abs)
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / 1024 / 1024).toFixed(2)} MB`
}

export function shortId(id: string): string {
  return id.replace(/^sess_/, '').slice(0, 8)
}

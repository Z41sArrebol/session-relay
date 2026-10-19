import path from 'node:path'
import { readFileSync, statSync } from 'node:fs'

/**
 * Path and content heuristics for "don't put secrets in the handoff pack".
 * These are heuristics, not a guarantee; the UI says so explicitly.
 */

const SENSITIVE_DIRS = [
  '.ssh',
  '.aws',
  '.gnupg',
  '.kube',
  '.docker',
  '.config/gcloud',
  '.azure',
  '.terraform'
]

const SENSITIVE_NAMES = [
  /^\.env$/i,
  /^\.env\./i,
  /^\.npmrc$/i,
  /^\.pypirc$/i,
  /^\.netrc$/i,
  /^\.git-credentials$/i,
  /^id_(rsa|dsa|ecdsa|ed25519)(\.pub)?$/i,
  /^credentials(\..*)?$/i,
  /^secrets?(\..*)?$/i,
  /\.(pem|key|p12|pfx|keystore|jks|asc|gpg)$/i,
  /^service[-_]?account.*\.json$/i,
  /^firebase[-_]?adminsdk.*\.json$/i
]

const BUILD_DIRS = new Set([
  '.git',
  'node_modules',
  'dist',
  'build',
  'out',
  'coverage',
  '.next',
  '.nuxt',
  '.svelte-kit',
  '.cache',
  '.parcel-cache',
  '.turbo',
  '.output',
  '__pycache__',
  '.venv',
  'venv',
  'target',
  'vendor',
  '.gradle',
  '.idea',
  '.vscode',
  '.DS_Store'
])

export interface PathRisk {
  sensitive: boolean
  reasons: string[]
  buildArtifact: boolean
}

export function inspectPath(relativePath: string): PathRisk {
  const posix = relativePath.replace(/\\/g, '/').replace(/^\.\//, '')
  const segments = posix.split('/')
  const base = segments[segments.length - 1] || ''
  const reasons: string[] = []
  let buildArtifact = false

  for (const seg of segments.slice(0, -1)) {
    if (SENSITIVE_DIRS.some((d) => posix.toLowerCase().includes(`/${d}/`) || posix.toLowerCase().startsWith(`${d}/`))) {
      reasons.push(`敏感目录 ${seg}`)
      break
    }
    if (BUILD_DIRS.has(seg)) {
      buildArtifact = true
      reasons.push(`构建/依赖目录 ${seg}`)
    }
  }
  if (BUILD_DIRS.has(base)) buildArtifact = true
  if (SENSITIVE_NAMES.some((re) => re.test(base))) reasons.push(`敏感文件名 ${base}`)
  if (/\.(pem|key|p12|pfx|keystore|jks)$/i.test(base)) reasons.push('密钥/证书文件')
  if (/^\.env(\.|$)/i.test(base)) reasons.push('.env 配置文件')

  return { sensitive: reasons.length > 0 && !buildArtifact, reasons, buildArtifact }
}

export function isBuildArtifact(relativePath: string): boolean {
  return inspectPath(relativePath).buildArtifact
}

export interface ContentRisk {
  sensitive: boolean
  reasons: string[]
}

const CONTENT_PATTERNS: Array<{ re: RegExp; reason: string }> = [
  { re: /-----BEGIN (RSA |EC |OPENSSH |PGP |DSA )?PRIVATE KEY-----/, reason: '私钥块' },
  { re: /\bAKIA[0-9A-Z]{16}\b/, reason: 'AWS Access Key' },
  { re: /\bgh[pousr]_[A-Za-z0-9]{20,}\b/, reason: 'GitHub Token' },
  { re: /\bsk-(?:proj-|live-)?[A-Za-z0-9_-]{16,}\b/, reason: 'API Secret Key' },
  { re: /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/, reason: 'Slack Token' },
  { re: /\bAIza[0-9A-Za-z_-]{30,}\b/, reason: 'Google API Key' },
  { re: /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/, reason: 'JWT' },
  {
    re: /(?:api[_-]?key|secret|passwd|password|access[_-]?token|client[_-]?secret)\s*[:=]\s*['"][^'"\n]{12,}['"]/i,
    reason: '疑似硬编码凭据'
  }
]

export function scanTextContent(text: string): ContentRisk {
  const reasons: string[] = []
  for (const pattern of CONTENT_PATTERNS) {
    if (pattern.re.test(text)) reasons.push(pattern.reason)
  }
  return { sensitive: reasons.length > 0, reasons }
}

export function scanContent(abs: string): ContentRisk {
  let size = 0
  try {
    size = statSync(abs).size
  } catch {
    return { sensitive: false, reasons: [] }
  }
  if (size > 1024 * 1024) return { sensitive: false, reasons: [] }
  let buf: Buffer
  try {
    buf = readFileSync(abs)
  } catch {
    return { sensitive: false, reasons: [] }
  }
  if (buf.subarray(0, 8192).includes(0)) return { sensitive: false, reasons: [] }
  return scanTextContent(buf.toString('utf8'))
}

export function isBinaryFile(abs: string): boolean {
  try {
    const fd = readFileSync(abs, { encoding: null })
    return fd.subarray(0, 8192).includes(0)
  } catch {
    return false
  }
}

export const EXCLUDED_DIR_NAMES = BUILD_DIRS
export const MAX_PACK_FILE_BYTES = 4 * 1024 * 1024
export const MAX_PACK_TOTAL_BYTES = 60 * 1024 * 1024

export function formatDateTime(ms: number | null | undefined): string {
  if (!ms) return '—'
  const d = new Date(ms)
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`
}

export function formatTime(ms: number | null | undefined): string {
  if (!ms) return '—'
  const d = new Date(ms)
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`
}

export function relativeTime(ms: number | null | undefined): string {
  if (!ms) return '—'
  const diff = Date.now() - ms
  if (diff < 0) return '刚刚'
  if (diff < 60_000) return `${Math.max(1, Math.floor(diff / 1000))} 秒前`
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)} 分钟前`
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)} 小时前`
  if (diff < 30 * 86_400_000) return `${Math.floor(diff / 86_400_000)} 天前`
  return formatDateTime(ms)
}

export function formatNumber(n: number | null | undefined): string {
  if (n === null || n === undefined || !Number.isFinite(n)) return '—'
  if (n < 1000) return String(n)
  if (n < 1_000_000) return `${(n / 1000).toFixed(n < 10_000 ? 1 : 0)}k`
  return `${(n / 1_000_000).toFixed(2)}M`
}

export function formatBytes(bytes: number | null | undefined): string {
  if (bytes === null || bytes === undefined) return '—'
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / 1024 / 1024).toFixed(2)} MB`
}

export function basename(p: string): string {
  const parts = p.replace(/[\\/]+$/, '').split(/[\\/]/)
  return parts[parts.length - 1] || p
}

export function truncate(text: string, max: number): string {
  if (text.length <= max) return text
  return `${text.slice(0, max)}…`
}

export function statusLabel(status: string | undefined): string {
  switch (status) {
    case 'running':
      return '运行中'
    case 'completed':
      return '完成'
    case 'error':
      return '失败'
    case 'cancelled':
      return '取消'
    case 'pending':
      return '等待'
    default:
      return status || '未知'
  }
}

export function tokenSummary(input: number, output: number, cacheRead: number): string {
  return `↑ ${formatNumber(input)} ↓ ${formatNumber(output)}${cacheRead ? ` · 缓存 ${formatNumber(cacheRead)}` : ''}`
}

export function toolSummary(input: unknown): string {
  if (!input || typeof input !== 'object') return ''
  const obj = input as Record<string, unknown>
  if (typeof obj.command === 'string') return obj.command
  if (typeof obj.file_path === 'string') return obj.file_path
  if (typeof obj.path === 'string') return obj.path
  if (typeof obj.description === 'string') return obj.description
  if (typeof obj.pattern === 'string') return obj.pattern
  if (typeof obj.query === 'string') return obj.query
  try {
    return JSON.stringify(obj)
  } catch {
    return ''
  }
}

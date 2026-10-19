import type { CitationCheck, SummaryDraft, SummarySectionKey, TimelineItem } from '../../shared/types'
import { SUMMARY_SECTIONS } from '../../shared/types'
import type { PackContext } from './handoff'
import { deterministicSections } from './handoff'
import { sha256Text } from './paths'
import type { SettingsService } from './settings'
import type { Logger } from './log'

const MAX_EVIDENCE_CHARS = 140_000

export function computeEvidenceHash(ctx: PackContext): string {
  const material = JSON.stringify({
    items: ctx.timeline.map((i) => [i.id, i.time, i.kind, i.status || '', i.text?.length || 0, i.output?.length || 0]),
    tokens: ctx.tokens,
    git: {
      head: ctx.git.head,
      branch: ctx.git.branch,
      status: ctx.git.statusText,
      files: [...ctx.git.buckets.staged, ...ctx.git.buckets.unstaged, ...ctx.git.buckets.untracked].map((f) => [
        f.path,
        f.sha256,
        f.size,
        f.attribution
      ]),
      commits: ctx.git.commitsSinceBaseline.map((c) => c.hash)
    },
    baseline: ctx.row.baseline.info
  })
  return sha256Text(material)
}

function iso(ms: number): string {
  return new Date(ms).toISOString()
}

function cap(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max)}…[截断]`
}

function commandOf(item: TimelineItem): string {
  const input = item.input as Record<string, unknown> | undefined
  if (!input) return ''
  if (typeof input.command === 'string') return input.command
  if (typeof input.file_path === 'string') return input.file_path
  if (typeof input.path === 'string') return input.path
  try {
    return JSON.stringify(input).slice(0, 300)
  } catch {
    return ''
  }
}

export function buildEvidenceBundle(ctx: PackContext): { text: string; validCitations: Set<string>; ids: string[] } {
  const parts: string[] = []
  const valid = new Set<string>()
  parts.push('## 会话元数据')
  parts.push(`- sessionId: ${ctx.row.sessionId}`)
  parts.push(`- 标题: ${ctx.row.title || '(未命名)'}`)
  parts.push(`- 工作目录: ${ctx.row.directory}`)
  parts.push(`- 项目目录: ${ctx.git.projectRoot}`)
  parts.push(`- 采集时间: ${iso(ctx.git.capturedAt)}`)
  parts.push(`- 会话状态: ${ctx.git.snapshotState}`)
  parts.push(`- 归属: ${ctx.git.attribution}；${ctx.git.attributionNote}`)
  parts.push(`- Token: input=${ctx.tokens.input} output=${ctx.tokens.output} reasoning=${ctx.tokens.reasoning} cacheRead=${ctx.tokens.cacheRead} calls=${ctx.tokens.calls}`)
  parts.push('')
  parts.push('## 用户要求（按时间）')
  for (const item of ctx.timeline.filter((i) => i.kind === 'user')) {
    valid.add(`M:${item.messageId}`)
    parts.push(`[M:${item.messageId}] ${iso(item.time)} ${cap(item.text || '', 6000)}`)
    parts.push('')
  }
  parts.push('## 模型公开回复（最后陈述，未经核实）')
  for (const item of ctx.timeline.filter((i) => i.kind === 'assistant')) {
    valid.add(`M:${item.messageId}`)
    const flag = item.isFinalStatement ? ' [收尾陈述]' : ''
    parts.push(`[M:${item.messageId}] ${iso(item.time)}${flag} ${cap(item.text || '', 3500)}`)
    parts.push('')
  }
  parts.push('## 工具调用与结果（观察记录）')
  for (const item of ctx.timeline.filter((i) => i.kind === 'tool')) {
    valid.add(`T:${item.callId || item.id}`)
    parts.push(
      `[T:${item.callId || item.id}] ${iso(item.time)} ${item.toolName} status=${item.status} exit=${
        item.exitCode ?? ''
      } cmd=${cap(commandOf(item), 300)} out=${cap((item.error || item.output || '').slice(-800), 800)}`
    )
  }
  parts.push('')
  parts.push('## Git 变更与归属')
  const files = [...ctx.git.buckets.staged, ...ctx.git.buckets.unstaged, ...ctx.git.buckets.untracked]
  const dedup = new Map<string, (typeof files)[number]>()
  for (const f of files) dedup.set(f.path, f)
  for (const f of dedup.values()) {
    valid.add(`F:${f.path}`)
    parts.push(
      `[F:${f.path}] bucket=${f.bucket} preExisting=${f.preExisting} changedDuringObservation=${
        f.changedSinceBaseline
      } attribution=${f.attribution}`
    )
  }
  for (const c of ctx.git.commitsSinceBaseline) {
    valid.add(`C:${c.hash}`)
    parts.push(`[C:${c.hash}] ${c.shortHash} ${c.author} ${c.subject}`)
  }
  parts.push('')
  parts.push('## 规则生成的参考草稿（可用于校对，不是事实源）')
  const template = deterministicSections(ctx)
  for (const def of SUMMARY_SECTIONS) {
    parts.push(`### ${def.title}`)
    parts.push(template[def.key])
  }
  let text = parts.join('\n')
  if (text.length > MAX_EVIDENCE_CHARS) {
    text = `${text.slice(0, MAX_EVIDENCE_CHARS)}\n\n…（证据包已截断，完整内容见 session/timeline.jsonl 与 changes/）`
  }
  return { text, validCitations: valid, ids: [...valid] }
}

const SYSTEM_PROMPT = `你是代码交接摘要器。只根据给定证据写交接摘要，不补充未出现的事实。
必须区分：
- 观察到的证据（消息、工具记录、Git 状态）；
- 执行者的声称（模型说“完成了/测试通过”），必须标注“未经核实”；
- 你的推断（如果必须写，明确标注“推测”）。
每条关键事实后附引用：[M:消息ID]、[T:工具callID]、[F:文件路径] 或 [C:提交hash]。没有证据就写“证据不足”。
不要输出模型内部思考，不要复述大段日志。
输出一个 JSON 对象，且只输出 JSON。键必须是：goal, changes, state, files, verification, claims, open, next。
每个值是 markdown 字符串，对应：
goal=原始目标与约束；changes=用户后来变更的要求；state=当前状态与关键决策；
files=实际观察到的文件变更；verification=已执行的验证和结果；
claims=执行者声称完成但尚未核实；open=未解决问题；next=建议接手者首先检查什么。
中文写作，简洁。`

function endpointOf(baseUrl: string): string {
  const base = baseUrl.replace(/\/+$/, '')
  return /\/chat\/completions$/i.test(base) ? base : `${base}/chat/completions`
}

async function callModel(
  cfg: { baseUrl: string; model: string; temperature: number; apiKey: string | null },
  messages: Array<{ role: string; content: string }>
): Promise<{ content: string; latencyMs: number }> {
  if (!cfg.apiKey) throw new Error('尚未配置模型 API Key')
  if (!cfg.baseUrl) throw new Error('尚未配置模型服务地址')
  if (!cfg.model) throw new Error('尚未配置模型名称')
  const started = Date.now()
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), 120_000)
  try {
    const res = await fetch(endpointOf(cfg.baseUrl), {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${cfg.apiKey}`
      },
      body: JSON.stringify({
        model: cfg.model,
        temperature: cfg.temperature,
        max_tokens: 4500,
        messages
      }),
      signal: controller.signal
    })
    const bodyText = await res.text()
    if (!res.ok) {
      const hint = bodyText.slice(0, 400).replace(/\s+/g, ' ')
      throw new Error(`模型接口返回 HTTP ${res.status}：${hint}`)
    }
    let data: unknown
    try {
      data = JSON.parse(bodyText)
    } catch {
      throw new Error('模型接口返回的不是 JSON')
    }
    const choices = (data as { choices?: Array<{ message?: { content?: unknown } }> }).choices
    let content = choices?.[0]?.message?.content
    if (Array.isArray(content)) {
      content = content
        .map((p) => (typeof p === 'string' ? p : typeof p === 'object' && p && 'text' in p ? String((p as { text: unknown }).text) : ''))
        .join('')
    }
    if (typeof content !== 'string' || !content.trim()) {
      throw new Error('模型返回了空内容')
    }
    return { content, latencyMs: Date.now() - started }
  } finally {
    clearTimeout(timer)
  }
}

function extractJson(text: string): Record<string, unknown> | null {
  const start = text.indexOf('{')
  const end = text.lastIndexOf('}')
  if (start < 0 || end <= start) return null
  try {
    return JSON.parse(text.slice(start, end + 1)) as Record<string, unknown>
  } catch {
    return null
  }
}

function parseHeadings(text: string): Partial<Record<SummarySectionKey, string>> {
  const out: Partial<Record<SummarySectionKey, string>> = {}
  const titleToKey = new Map<string, SummarySectionKey>()
  for (const def of SUMMARY_SECTIONS) {
    titleToKey.set(def.title, def.key)
    titleToKey.set(def.key, def.key)
  }
  const lines = text.split(/\r?\n/)
  let current: SummarySectionKey | null = null
  let buffer: string[] = []
  const flush = () => {
    if (current) out[current] = buffer.join('\n').trim()
  }
  for (const line of lines) {
    const m = /^#{1,4}\s*(?:\d+[.、]\s*)?(.+?)\s*$/.exec(line)
    if (m) {
      const candidate = m[1].trim()
      const key = titleToKey.get(candidate)
      if (key) {
        flush()
        current = key
        buffer = []
        continue
      }
    }
    if (current) buffer.push(line)
  }
  flush()
  return out
}

export function checkCitations(text: string, valid: Set<string>): CitationCheck {
  const unresolved: string[] = []
  let total = 0
  let resolved = 0
  const re = /\[(M|T|F|C):([^\]]+)\]/g
  for (const match of text.matchAll(re)) {
    total++
    const token = `${match[1]}:${match[2].trim()}`
    if (valid.has(token)) resolved++
    else if (!unresolved.includes(token)) unresolved.push(token)
  }
  return { total, resolved, unresolved }
}

function combineSections(sections: Record<SummarySectionKey, string>): string {
  return SUMMARY_SECTIONS.map((d) => `## ${d.title}\n\n${sections[d.key] || ''}`).join('\n\n')
}

export class SummaryService {
  private settings: SettingsService
  private logger: Logger

  constructor(settings: SettingsService, logger: Logger) {
    this.settings = settings
    this.logger = logger
  }

  templateDraft(ctx: PackContext, note: string | null = null): SummaryDraft {
    const sections = deterministicSections(ctx)
    const hash = computeEvidenceHash(ctx)
    const citations = checkCitations(combineSections(sections), new Set(buildEvidenceBundle(ctx).ids))
    return {
      sessionId: ctx.row.sessionId,
      sections,
      generatedAt: Date.now(),
      source: 'template',
      model: null,
      evidenceHash: hash,
      citations,
      error: note,
      stale: false
    }
  }

  async generate(ctx: PackContext, forceTemplate = false): Promise<SummaryDraft> {
    const cfg = this.settings.getModelConfig()
    const bundle = buildEvidenceBundle(ctx)
    const hash = computeEvidenceHash(ctx)
    if (forceTemplate) {
      return this.templateDraft(ctx, null)
    }
    if (!cfg.apiKey || !cfg.baseUrl || !cfg.model) {
      const draft = this.templateDraft(ctx, '未配置模型接口，已生成确定性草稿（未调用模型）。')
      this.logger.info(`summary-template session=${ctx.row.sessionId} reason=no-model`)
      return draft
    }
    const started = Date.now()
    try {
      const { content, latencyMs } = await callModel(cfg, [
        { role: 'system', content: SYSTEM_PROMPT },
        { role: 'user', content: `以下是唯一可用证据：\n\n${bundle.text}` }
      ])
      const parsed = extractJson(content) || parseHeadings(content)
      const sections = { ...deterministicSections(ctx) } as Record<SummarySectionKey, string>
      let found = 0
      for (const def of SUMMARY_SECTIONS) {
        const value = parsed[def.key]
        if (typeof value === 'string' && value.trim()) {
          sections[def.key] = value.trim()
          found++
        }
      }
      if (!found) {
        const draft = this.templateDraft(ctx, `模型返回内容无法解析为约定结构（${latencyMs} ms），已保留确定性草稿。`)
        this.logger.warn(`summary-parse-failed session=${ctx.row.sessionId}`)
        return draft
      }
      const citations = checkCitations(combineSections(sections), bundle.validCitations)
      this.logger.info(`summary-ok session=${ctx.row.sessionId} ms=${latencyMs} sections=${found} citations=${citations.resolved}/${citations.total}`)
      return {
        sessionId: ctx.row.sessionId,
        sections,
        generatedAt: Date.now(),
        source: 'ai',
        model: `${cfg.model}`,
        evidenceHash: hash,
        citations,
        error: citations.unresolved.length ? `有 ${citations.unresolved.length} 个引用未在证据中找到，请核对。` : null,
        stale: false
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      this.logger.error(`summary-failed session=${ctx.row.sessionId} ${message.slice(0, 200)}`)
      const draft = this.templateDraft(ctx, `AI 总结失败，已保留确定性草稿。原因：${message}`)
      draft.citations = checkCitations(combineSections(draft.sections), bundle.validCitations)
      return draft
    } finally {
      this.logger.info(`summary-elapsed session=${ctx.row.sessionId} ms=${Date.now() - started}`)
    }
  }

  async test(): Promise<{ ok: boolean; message: string; latencyMs: number | null }> {
    const cfg = this.settings.getModelConfig()
    if (!cfg.apiKey || !cfg.baseUrl || !cfg.model) {
      return { ok: false, message: '请先填写服务地址、模型名称和 API Key', latencyMs: null }
    }
    const started = Date.now()
    try {
      const { latencyMs } = await callModel(cfg, [
        { role: 'system', content: '只回复 OK，不要输出其他内容。' },
        { role: 'user', content: 'ping' }
      ])
      return { ok: true, message: `连接正常（${cfg.model}）`, latencyMs: latencyMs || Date.now() - started }
    } catch (error) {
      return { ok: false, message: error instanceof Error ? error.message : String(error), latencyMs: null }
    }
  }
}

export function markStale(draft: SummaryDraft | null, ctx: PackContext): SummaryDraft | null {
  if (!draft) return null
  return { ...draft, stale: draft.evidenceHash !== computeEvidenceHash(ctx) }
}

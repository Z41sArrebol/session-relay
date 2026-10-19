import type { ModelRef, TimelineItem } from '../../../shared/types'
import { sha256Text } from '../paths'
import type { ZMessageRow, ZPartRow, ZSyncData } from './reader'

const MAX_OUTPUT_CHARS = 128 * 1024
const MAX_ERROR_CHARS = 16 * 1024
const MAX_INPUT_JSON_CHARS = 64 * 1024

export interface BuiltEvent {
  eventId: string
  kind: string
  time: number
  messageId: string
  partId: string | null
  turnId: string | null
  sequence: number
  payload: string
  contentHash: string
}

function text(value: unknown): string {
  if (typeof value === 'string') return value
  if (value === null || value === undefined) return ''
  try {
    return JSON.stringify(value)
  } catch {
    return String(value)
  }
}

function cap(value: string, max: number): { value: string; truncated: boolean } {
  if (value.length <= max) return { value, truncated: false }
  return { value: value.slice(0, max), truncated: true }
}

function event(item: TimelineItem): BuiltEvent {
  const payload = JSON.stringify(item)
  return {
    eventId: item.id,
    kind: item.kind,
    time: item.time,
    messageId: item.messageId,
    partId: item.partId ?? null,
    turnId: item.turnId,
    sequence: item.sequence,
    payload,
    contentHash: sha256Text(payload)
  }
}

function modelOf(message: ZMessageRow): ModelRef | null {
  if (!message.meta.modelId) return null
  return {
    providerId: message.meta.providerId || '',
    modelId: message.meta.modelId,
    variant: message.meta.variant || undefined
  }
}

function isPublicAssistant(message: ZMessageRow): boolean {
  return message.meta.role === 'assistant' && message.meta.origin !== 'system' && !message.meta.synthetic
}

function isRealUser(message: ZMessageRow): boolean {
  if (message.meta.role !== 'user') return false
  if (message.meta.origin !== 'real_user') return false
  if (message.meta.synthetic) return false
  if (message.meta.visibility === 'model-only') return false
  return true
}

/**
 * Turn a Z-Code sync batch into stable timeline events.
 *
 * Collected: real user prompts, public assistant text, tool calls + results,
 * and explicit runtime model-change notes.
 * Excluded on purpose: reasoning parts, model-only injected context, system
 * assistant messages, and step-start/step-finish bookkeeping.
 */
export function buildEvents(
  sessionId: string,
  z: ZSyncData,
  lookupMessage: (id: string) => ZMessageRow | null
): BuiltEvent[] {
  const messageMap = new Map<string, ZMessageRow>()
  for (const m of z.messages) messageMap.set(m.id, m)
  const out: BuiltEvent[] = []
  const seen = new Set<string>()

  for (const part of z.parts) {
    const message = messageMap.get(part.messageId) || lookupMessage(part.messageId)
    if (!message) continue
    const type = String(part.data.type || '')
    const baseTime = part.createdAt || message.createdAt
    const turnId = message.meta.role === 'assistant' ? message.meta.parentId : message.id
    const sequence = message.sequence * 10000 + part.sequence

    if (type === 'text') {
      const isUser = isRealUser(message)
      const isAssistant = isPublicAssistant(message)
      if (!isUser && !isAssistant) continue
      const body = String(part.data.text || '')
      if (!body.trim()) continue
      const item: TimelineItem = {
        id: `${isUser ? 'u' : 'a'}:${message.id}:${part.id}`,
        sessionId,
        kind: isUser ? 'user' : 'assistant',
        time: baseTime,
        messageId: message.id,
        partId: part.id,
        turnId,
        sequence,
        text: body,
        finish: message.meta.finish,
        isFinalStatement: isAssistant && message.meta.finish === 'stop',
        model: isAssistant ? modelOf(message) : null
      }
      if (!seen.has(item.id)) {
        seen.add(item.id)
        out.push(event(item))
      }
      continue
    }

    if (type === 'tool') {
      if (!isPublicAssistant(message)) continue
      const state = (part.data.state as Record<string, unknown>) || {}
      const rawInput = state.input
      let input = rawInput
      let inputTruncated = false
      try {
        const serialised = JSON.stringify(rawInput)
        if (serialised && serialised.length > MAX_INPUT_JSON_CHARS) {
          input = { _truncated: true, preview: serialised.slice(0, MAX_INPUT_JSON_CHARS) }
          inputTruncated = true
        }
      } catch {
        input = { _unserialisable: true }
      }
      const rawOutput = state.output
      const rawError = state.error
      const output = cap(text(rawOutput), MAX_OUTPUT_CHARS)
      const error = cap(text(rawError), MAX_ERROR_CHARS)
      const statusRaw = String(state.status || 'pending')
      const status =
        statusRaw === 'completed' || statusRaw === 'error' || statusRaw === 'running' || statusRaw === 'cancelled'
          ? statusRaw
          : 'pending'
      const toolTime = (state.time as Record<string, unknown>) || {}
      const start = typeof toolTime.start === 'number' ? toolTime.start : baseTime
      const item: TimelineItem = {
        id: `t:${part.id}`,
        sessionId,
        kind: 'tool',
        time: start,
        messageId: message.id,
        partId: part.id,
        turnId,
        sequence,
        toolName: String(part.data.tool || 'tool'),
        callId: String(part.data.callID || ''),
        input,
        output: output.value || undefined,
        error: error.value || undefined,
        status,
        truncated: output.truncated || error.truncated || inputTruncated,
        model: modelOf(message)
      }
      if (!seen.has(item.id)) {
        seen.add(item.id)
        out.push(event(item))
      }
      continue
    }

    if (type === 'timeline') {
      const timelineType = String(part.data.timelineType || '')
      if (timelineType !== 'model_change') continue
      const from = (part.data.fromModelSelection as Record<string, unknown>) || {}
      const to = (part.data.toModelSelection as Record<string, unknown>) || {}
      const fromLabel = String(from.label || from.modelId || '未知模型')
      const toLabel = String(to.label || to.modelId || '未知模型')
      const item: TimelineItem = {
        id: `s:${part.id}`,
        sessionId,
        kind: 'system',
        time: baseTime,
        messageId: message.id,
        partId: part.id,
        turnId: null,
        sequence,
        text: `模型切换：${fromLabel} → ${toLabel}`,
        note: '运行时事件',
        model: null
      }
      if (!seen.has(item.id)) {
        seen.add(item.id)
        out.push(event(item))
      }
    }
  }

  out.sort((a, b) => a.time - b.time || a.sequence - b.sequence || a.eventId.localeCompare(b.eventId))
  return out
}

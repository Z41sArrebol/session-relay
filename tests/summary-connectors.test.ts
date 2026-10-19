import type { Logger } from '../src/main/core/log'
import { describe, expect, it, beforeAll, afterAll } from 'vitest'
import http from 'node:http'
import type { AddressInfo } from 'node:net'
import { RelayStore } from '../src/main/core/state'
import { ZcodeReader } from '../src/main/core/zcode/reader'
import { Observer } from '../src/main/core/observer'
import { getGitEvidence } from '../src/main/core/git'
import type { PackContext } from '../src/main/core/handoff'
import { buildEvidenceBundle, checkCitations, computeEvidenceHash, SummaryService } from '../src/main/core/summary'
import { ConnectorService } from '../src/main/core/connectors'
import { createZcodeFixture, type Fixture } from './fixtures/zcode'
import type { SettingsService } from '../src/main/core/settings'

const silentLogger = { info: () => undefined, warn: () => undefined, error: () => undefined } as unknown as Logger

function fakeSettings(cfg: { baseUrl: string; model: string; temperature: number; apiKey: string | null }): SettingsService {
  return { getModelConfig: () => cfg } as unknown as SettingsService
}

describe('summary and citations', () => {
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
    const git = await getGitEvidence({
      sessionId: fixture.sessionA,
      projectRoot: fixture.projectRoot,
      baseline: row.baseline,
      live: row.live
    })
    const timeline = observer.getTimeline(fixture.sessionA)
    ctx = { row, git, timeline: timeline.items, tokens: timeline.tokens, summary: null }
  })

  afterAll(() => {
    reader.close()
    store.close()
    fixture.cleanup()
  })

  it('validates citations against real evidence IDs', () => {
    const bundle = buildEvidenceBundle(ctx)
    expect(bundle.ids).toContain('M:msg_user_a')
    expect(bundle.ids).toContain('T:call_test_a')
    expect(bundle.text).not.toContain('INTERNAL_REASONING_SHOULD_NOT_BE_COLLECTED')
    const good = checkCitations('目标见 [M:msg_user_a]，命令见 [T:call_test_a]。', bundle.validCitations)
    expect(good.total).toBe(2)
    expect(good.resolved).toBe(2)
    const bad = checkCitations('不存在的引用 [M:msg_missing]。', bundle.validCitations)
    expect(bad.unresolved).toContain('M:msg_missing')
  })

  it('falls back to a deterministic draft when no model is configured', async () => {
    const service = new SummaryService(fakeSettings({ baseUrl: '', model: '', temperature: 0.2, apiKey: null }), silentLogger)
    const draft = await service.generate(ctx)
    expect(draft.source).toBe('template')
    expect(draft.error).toContain('未配置模型')
    expect(draft.sections.goal).toContain('实现登录页')
    expect(draft.sections.claims).toContain('未经核实')
  })

  it('calls an OpenAI-compatible endpoint and parses the eight sections', async () => {
    const server = http.createServer((req, res) => {
      if (req.method !== 'POST' || req.url !== '/v1/chat/completions') {
        res.writeHead(404).end()
        return
      }
      let body = ''
      req.on('data', (chunk) => (body += chunk))
      req.on('end', () => {
        const parsed = JSON.parse(body) as { messages: Array<{ content: string }> }
        expect(parsed.messages[1].content).toContain('实现登录页')
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(
          JSON.stringify({
            choices: [
              {
                message: {
                  content: JSON.stringify({
                    goal: '实现登录页并跑测试。[M:msg_user_a]',
                    changes: '没有后续变更要求。',
                    state: '表单与测试已写入。[T:call_test_a]',
                    files: '工作区有变更。[F:README.md]',
                    verification: '记录到 npm test，退出码 0。[T:call_test_a]',
                    claims: '执行者声称测试通过，未经核实。[M:msg_final_a]',
                    open: '仍需独立复验。',
                    next: '重跑 npm test。'
                  })
                }
              }
            ]
          })
        )
      })
    })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    const port = (server.address() as AddressInfo).port
    try {
      const service = new SummaryService(
        fakeSettings({ baseUrl: `http://127.0.0.1:${port}/v1`, model: 'test-model', temperature: 0.2, apiKey: 'test-key' }),
        silentLogger
      )
      const draft = await service.generate(ctx)
      expect(draft.source).toBe('ai')
      expect(draft.sections.goal).toContain('实现登录页')
      expect(draft.citations.total).toBeGreaterThanOrEqual(4)
      expect(draft.citations.unresolved.length).toBe(0)
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()))
    }
  })

  it('keeps a deterministic draft when the model endpoint fails', async () => {
    const server = http.createServer((_req, res) => {
      res.writeHead(500, { 'Content-Type': 'application/json' })
      res.end('{"error":"boom"}')
    })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    const port = (server.address() as AddressInfo).port
    try {
      const service = new SummaryService(
        fakeSettings({ baseUrl: `http://127.0.0.1:${port}/v1`, model: 'test-model', temperature: 0.2, apiKey: 'test-key' }),
        silentLogger
      )
      const draft = await service.generate(ctx)
      expect(draft.source).toBe('template')
      expect(draft.error).toContain('AI 总结失败')
      expect(draft.sections.goal).toContain('实现登录页')
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()))
    }
  })

  it('changes the evidence hash when new records arrive', () => {
    const hashBefore = computeEvidenceHash(ctx)
    const hashAfter = computeEvidenceHash({
      ...ctx,
      timeline: [...ctx.timeline, { ...ctx.timeline[0], id: 'extra', messageId: 'extra' }]
    })
    expect(hashAfter).not.toBe(hashBefore)
  })
})

describe('connectors', () => {
  it('never reports sent when confirmation is missing or the target is unsupported', async () => {
    const fixture = createZcodeFixture()
    const store = new RelayStore(fixture.storePath)
    const service = new ConnectorService({ store, logger: silentLogger, userDataDir: fixture.root })
    const base = {
      sessionId: fixture.sessionA,
      mode: 'review' as const,
      filePaths: [],
      includeFullFiles: false,
      extraNotes: '',
      connectorId: 'claude-cli',
      confirmed: false,
      relayInstruction: ''
    }
    const unconfirmed = await service.send(base, fixture.projectRoot, fixture.projectRoot)
    expect(unconfirmed.sent).toBe(false)
    expect(unconfirmed.reason).toBe('not-confirmed')

    const unsupported = await service.send(
      { ...base, connectorId: 'zcode-session', confirmed: true },
      fixture.projectRoot,
      fixture.projectRoot
    )
    expect(unsupported.sent).toBe(false)
    expect(unsupported.reason).toBe('unsupported')

    const notVerified = await service.send({ ...base, confirmed: true }, fixture.projectRoot, fixture.projectRoot)
    expect(notVerified.sent).toBe(false)
    expect(notVerified.reason).toBe('not-verified')

    await expect(service.verify('claude-cli', false)).rejects.toThrow('确认')
    store.close()
    fixture.cleanup()
  })

  it('labels export as primary and Z-Code as export-only', async () => {
    const fixture = createZcodeFixture()
    const store = new RelayStore(fixture.storePath)
    const service = new ConnectorService({ store, logger: silentLogger, userDataDir: fixture.root })
    const list = await service.list()
    expect(list.find((c) => c.id === 'export')?.primary).toBe(true)
    expect(list.find((c) => c.id === 'zcode-session')?.verificationState).toBe('unsupported')
    const claude = list.find((c) => c.id === 'claude-cli')
    expect(claude).toBeTruthy()
    expect(claude?.primary).toBe(false)
    store.close()
    fixture.cleanup()
  })
})

import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { _electron as electron } from 'playwright'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const electronBin = path.join(root, 'node_modules', 'electron', 'dist', 'electron.exe')
const esbuildBin = path.join(root, 'node_modules', 'esbuild', 'bin', 'esbuild')

function fail(message) {
  console.error('E2E FAIL:', message)
  process.exitCode = 1
  throw new Error(message)
}

function assert(condition, message) {
  if (!condition) fail(message)
}

async function main() {
  if (!existsSync(path.join(root, 'out', 'main', 'index.js'))) {
    fail('out/main/index.js 不存在，先运行 npm run build')
  }
  const work = path.join(root, '.tmp', 'e2e')
  rmSync(work, { recursive: true, force: true })
  mkdirSync(work, { recursive: true })
  const fixtureJson = path.join(work, 'fixture.json')
  const prepareCjs = path.join(work, 'prepare.cjs')

  const build = spawnSync(
    process.execPath,
    [
      esbuildBin,
      path.join(root, 'tests', 'e2e', 'prepare.ts'),
      '--bundle',
      '--platform=node',
      '--format=cjs',
      `--outfile=${prepareCjs}`,
      '--external:better-sqlite3'
    ],
    { encoding: 'utf8', cwd: root }
  )
  if (build.status !== 0) fail(`fixture bundle failed: ${build.stderr || build.stdout}`)

  const appendTs = path.join(root, 'tests', 'e2e', 'append.ts')
  const appendCjs = path.join(work, 'append.cjs')
  const buildAppend = spawnSync(
    process.execPath,
    [
      esbuildBin,
      appendTs,
      '--bundle',
      '--platform=node',
      '--format=cjs',
      `--outfile=${appendCjs}`,
      '--external:better-sqlite3'
    ],
    { encoding: 'utf8', cwd: root }
  )
  if (buildAppend.status !== 0) fail(`append bundle failed: ${buildAppend.stderr || buildAppend.stdout}`)

  const prep = spawnSync(electronBin, [prepareCjs, fixtureJson], {
    encoding: 'utf8',
    cwd: root,
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }
  })
  if (prep.status !== 0) fail(`fixture prepare failed: ${prep.stderr || prep.stdout}`)
  const fixture = JSON.parse(readFileSync(fixtureJson, 'utf8'))

  const env = {
    ...process.env,
    SESSION_RELAY_ZCODE_DB: fixture.dbPath,
    SESSION_RELAY_USER_DATA: fixture.userData
  }
  const shots = path.join(root, 'docs', 'screenshots')
  mkdirSync(shots, { recursive: true })
  const pageErrors = []

  let app = await electron.launch({ args: ['.', '--disable-gpu'], cwd: root, env })
  let win = await app.firstWindow()
  win.on('pageerror', (error) => pageErrors.push(error.message))
  win.on('console', (message) => {
    if (message.type() === 'error') pageErrors.push(message.text())
  })

  console.log('STEP launch+bootstrap')
  win.setDefaultTimeout(12_000)
  await win.waitForSelector('text=已接入会话', { timeout: 20_000 })
  assert((await win.locator('body').innerText()).includes('接入第一个会话'), 'empty state missing')

  console.log('STEP open attach')
  await win.getByRole('button', { name: '接入第一个会话' }).click()
  await win.waitForSelector('text=接入 Z-Code 会话', { timeout: 10_000 })
  await win.getByRole('button', { name: /测试会话 A/ }).first().click()
  const projectValue = await win.locator('.path-picker input').inputValue()
  assert(projectValue === fixture.projectRoot, `project root mismatch: ${projectValue}`)
  console.log('STEP submit attach')
  await win.getByRole('button', { name: '接入并开始观察' }).click()

  console.log('STEP wait timeline')
  await win.waitForSelector('text=实现登录页并跑测试。', { timeout: 20_000 })
  await win.waitForSelector('text=恢复简报（接手先看）', { timeout: 10_000 }).catch(() => undefined)
  const handoffText = await win.locator('.handoff').innerText()
  assert(handoffText.includes('最新目标'), 'recovery latest goal missing')
  assert(handoffText.includes('已完成与可核对证据'), 'recovery completed evidence missing')
  assert(handoffText.includes('失败过的路线'), 'recovery failed attempts missing')
  assert(handoffText.includes('工作区一致性'), 'recovery workspace consistency missing')
  assert(handoffText.includes('接手后先做什么'), 'recovery next actions missing')
  assert(handoffText.includes('更新 README'), 'incomplete todo missing')
  const timelineText = await win.locator('.timeline-pane').innerText()
  assert(timelineText.includes('用户要求'), 'user label missing')
  assert(timelineText.includes('模型公开回复'), 'assistant label missing')
  assert(timelineText.includes('收尾陈述 · 未核实'), 'claim badge missing')
  assert(!timelineText.includes('INTERNAL_REASONING'), 'reasoning leaked into timeline')
  assert(!timelineText.includes('SYSTEM_INJECTION'), 'injected context leaked into timeline')

  console.log('STEP expand tool')
  await win.locator('.tool-line').first().click()
  const toolDetail = await win.locator('.tool-detail').first().innerText()
  assert(toolDetail.includes('PASS login.test.ts'), 'tool output missing')
  assert(toolDetail.includes('执行结果'), 'tool result label missing')

  console.log('STEP live increment')
  const liveText = '运行中的增量消息。'
  const appended = spawnSync(electronBin, [appendCjs, fixture.dbPath, fixture.sessionA, liveText], {
    encoding: 'utf8',
    cwd: root,
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }
  })
  if (appended.status !== 0) fail(`append message failed: ${appended.stderr || appended.stdout}`)
  await win.waitForSelector(`text=${liveText}`, { timeout: 15_000 })
  await win.waitForTimeout(400)
  const liveCount = await win.locator('.msg-user .msg-body').filter({ hasText: liveText }).count()
  assert(liveCount === 1, `live message should appear exactly once, got ${liveCount}`)

  const cardBefore = await win.locator('.rail-card').first().innerText()
  console.log('CARD BEFORE:', cardBefore.split('\n').join(' | '))
  const countBefore = Number((cardBefore.match(/(\d+)\s*条记录/) || [])[1] || '0')
  assert(countBefore > 0, 'event count not shown')

  console.log('STEP open pack')
  await win.getByRole('button', { name: '预览交接包' }).click()
  await win.waitForSelector('text=预览交接包', { timeout: 15_000 })
  console.log('STEP wait pack files')
  await win.waitForSelector('.pack-file', { timeout: 20_000 })
  const files = await win.locator('.pack-file .mono').allInnerTexts()
  assert(files.some((f) => f === 'HANDOFF.md'), 'HANDOFF.md not in pack')
  assert(files.some((f) => f.includes('session/excerpt.md')), 'session excerpt missing')
  assert(files.some((f) => f.includes('changes/diff-unstaged.patch')), 'diff missing')
  const packText = await win.locator('.modal').innerText()
  assert(packText.includes('独立验收'), 'review mode default missing')
  assert(packText.includes('隐私提醒'), 'privacy notice missing')

  console.log('STEP copy instruction')
  await win.locator('.modal-foot').getByRole('button', { name: /复制接力指令/ }).click()
  await win.waitForSelector('text=接力指令已复制', { timeout: 5_000 })

  await win.locator('.target').filter({ hasText: '另一个 Z-Code 会话' }).click()
  const zcodeText = await win.locator('.send-box').innerText()
  assert(zcodeText.includes('仅支持导出'), 'Z-Code should be export-only')
  assert(zcodeText.includes('没有公开的外部启动/发送入口'), 'Z-Code unsupported reason missing')

  await win.locator('.target').filter({ hasText: 'Claude Code CLI' }).click()
  const claudeText = await win.locator('.send-box').innerText()
  assert(claudeText.includes('候选 · 未验证') || claudeText.includes('已自检'), 'connector state missing')
  assert(!claudeText.includes('已发送'), 'must not claim sent before sending')

  await win.waitForTimeout(400)
  await win.screenshot({ path: path.join(shots, 'pack-preview.png'), fullPage: true })
  console.log('STEP close pack')
  await win.locator('.modal-head .icon-btn').click()
  await win.waitForTimeout(500)
  await win.screenshot({ path: path.join(shots, 'timeline.png'), fullPage: true })

  console.log('STEP close app 1')
  await app.close()

  // Restart with the same userData and fixture: observation progress must survive.
  app = await electron.launch({ args: ['.', '--disable-gpu'], cwd: root, env })
  win = await app.firstWindow()
  win.on('pageerror', (error) => pageErrors.push(error.message))
  console.log('STEP relaunch')
  await win.waitForSelector('.rail-card', { timeout: 20_000 })
  const cardAfter = await win.locator('.rail-card').first().innerText()
  const countAfter = Number((cardAfter.match(/(\d+)\s*条记录/) || [])[1] || '0')
  assert(countAfter === countBefore, `event count changed after restart: ${countBefore} -> ${countAfter}`)
  console.log('STEP select after restart')
  await win.locator('.rail-card').first().click()
  await win.waitForSelector('.msg-user', { timeout: 20_000 })
  const userMessages = await win.locator('.msg-user .msg-body').allInnerTexts()
  assert(userMessages.filter((t) => t.includes('实现登录页并跑测试。')).length === 1, 'duplicate import after restart')
  assert(userMessages.filter((t) => t.includes(liveText)).length === 1, 'live message duplicated after restart')
  await win.waitForTimeout(500)
  await win.screenshot({ path: path.join(shots, 'restart.png'), fullPage: true })
  console.log('STEP close app 2')
  await app.close()

  if (pageErrors.length) {
    fail(`renderer errors: ${pageErrors.join(' | ')}`)
  }
  console.log(
    JSON.stringify(
      {
        ok: true,
        screenshots: ['docs/screenshots/timeline.png', 'docs/screenshots/pack-preview.png', 'docs/screenshots/restart.png'],
        eventCount: countBefore,
        assertions: [
          'attach fixture session',
          'recovery tab answers five questions',
          'timeline filters reasoning and injected context',
          'tool output expandable',
          'pack preview lists HANDOFF/session/diff',
          'Z-Code target shows export-only',
          'no sent state before actual send',
          'live increment appears exactly once',
          'restart keeps observation progress without duplicates'
        ]
      },
      null,
      2
    )
  )
  rmSync(fixture.root, { recursive: true, force: true })
}

main().catch(async (error) => {
  console.error(error)
  process.exitCode = 1
})

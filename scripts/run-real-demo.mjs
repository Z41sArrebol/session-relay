import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, rmSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const electron = path.join(root, 'node_modules', 'electron', 'dist', 'electron.exe')
const esbuild = path.join(root, 'node_modules', 'esbuild', 'bin', 'esbuild')
const work = path.join(root, '.tmp', 'real-demo')
rmSync(work, { recursive: true, force: true })
mkdirSync(work, { recursive: true })
const outfile = path.join(work, 'real-demo.cjs')

const build = spawnSync(
  process.execPath,
  [
    esbuild,
    path.join(root, 'tests', 'demo', 'real-demo.ts'),
    '--bundle',
    '--platform=node',
    '--format=cjs',
    `--outfile=${outfile}`,
    '--external:better-sqlite3'
  ],
  { cwd: root, encoding: 'utf8' }
)
if (build.status !== 0) {
  console.error(build.stderr || build.stdout)
  process.exit(1)
}
if (!existsSync(electron)) {
  console.error('Electron binary missing; run npm install first')
  process.exit(1)
}
const run = spawnSync(electron, [outfile], {
  cwd: root,
  stdio: 'inherit',
  env: {
    ...process.env,
    ELECTRON_RUN_AS_NODE: '1',
    SESSION_RELAY_REAL_SESSION:
      process.env.SESSION_RELAY_REAL_SESSION || 'sess_88d1faa6-6aa0-4cac-95e6-972300a76d84'
  }
})
process.exit(run.status ?? 1)

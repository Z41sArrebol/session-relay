import { spawn } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const electron = path.join(root, 'node_modules', 'electron', 'dist', 'electron.exe')
const vitest = path.join(root, 'node_modules', 'vitest', 'vitest.mjs')

const child = spawn(electron, [vitest, ...process.argv.slice(2)], {
  stdio: 'inherit',
  cwd: root,
  env: {
    ...process.env,
    ELECTRON_RUN_AS_NODE: '1'
  }
})

child.on('exit', (code) => process.exit(code ?? 1))
child.on('error', (error) => {
  console.error(error)
  process.exit(1)
})

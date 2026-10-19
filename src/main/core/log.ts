import { app } from 'electron'
import { appendFileSync, mkdirSync, statSync, renameSync } from 'node:fs'
import path from 'node:path'

const MAX_LOG_BYTES = 2 * 1024 * 1024

/**
 * Metadata-only logger. Never pass message text, tool output, API keys or
 * handoff content here; those live in the user's own evidence files.
 */
export class Logger {
  private file: string
  private ready = false

  constructor() {
    try {
      const dir = path.join(app.getPath('userData'), 'logs')
      mkdirSync(dir, { recursive: true })
      this.file = path.join(dir, 'app.log')
      this.ready = true
    } catch {
      this.file = ''
    }
  }

  private write(level: string, message: string): void {
    if (!this.ready) return
    try {
      const st = statSync(this.file, { throwIfNoEntry: false })
      if (st && st.size > MAX_LOG_BYTES) {
        renameSync(this.file, `${this.file}.1`)
      }
    } catch {
      // ignore rotation failures
    }
    try {
      appendFileSync(this.file, `${new Date().toISOString()} [${level}] ${message}\n`, 'utf8')
    } catch {
      // never crash on logging
    }
  }

  info(message: string): void {
    this.write('info', message)
  }

  warn(message: string): void {
    this.write('warn', message)
  }

  error(message: string): void {
    this.write('error', message)
  }
}

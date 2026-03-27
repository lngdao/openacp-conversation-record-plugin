import fs from 'node:fs'
import path from 'node:path'
import type { PluginContext } from '@openacp/plugin-sdk'
import type { RecordEntry, ConversationRecordConfig } from './types.js'
import { shouldRecord } from './types.js'

export class ConversationRecorder {
  private readonly sessionsDir: string
  private readonly config: ConversationRecordConfig

  constructor(dataDir: string, config: ConversationRecordConfig) {
    this.sessionsDir = path.join(dataDir, 'sessions')
    this.config = config
    fs.mkdirSync(this.sessionsDir, { recursive: true })
  }

  /**
   * Register event listeners on the plugin context.
   * Returns cleanup function to remove listeners.
   */
  register(ctx: PluginContext): void {
    ctx.on('session:created', (payload: unknown) => {
      const p = payload as Record<string, unknown>
      const sessionId = String(p.sessionId ?? '')
      if (sessionId) this.append(sessionId, 'session:created', p)
    })

    ctx.on('session:ended', (payload: unknown) => {
      const p = payload as { sessionId: string; reason: string }
      this.append(p.sessionId, 'session:ended', p)
    })

    ctx.on('session:named', (payload: unknown) => {
      const p = payload as { sessionId: string; name: string }
      if (p.name === 'Assistant') {
        // System session — delete recording, not useful for context bridge
        this.deleteRecording(p.sessionId)
        return
      }
      this.append(p.sessionId, 'session:named', p)
    })

    ctx.on('agent:prompt', (payload: unknown) => {
      const p = payload as { sessionId: string; text: string; attachments?: unknown[] }
      if (this.config.recordLevel === 'minimal') return
      this.append(p.sessionId, 'agent:prompt', p)
    })

    ctx.on('agent:event', (payload: unknown) => {
      const p = payload as { sessionId: string; event: { type: string; [key: string]: unknown } }
      if (!shouldRecord(p.event.type, this.config.recordLevel, this.config.excludeEvents)) return
      this.append(p.sessionId, 'agent:event', p.event)
    })

    ctx.on('permission:request', (payload: unknown) => {
      const p = payload as { sessionId: string; request: unknown }
      if (this.config.recordLevel === 'minimal') return
      this.append(p.sessionId, 'permission:request', p)
    })

    ctx.on('permission:resolved', (payload: unknown) => {
      const p = payload as { sessionId: string; requestId: string; decision: string }
      if (this.config.recordLevel === 'minimal') return
      this.append(p.sessionId, 'permission:resolved', p)
    })
  }

  /** Append a record entry to the session's JSONL file. */
  private append(sessionId: string, type: string, data: unknown): void {
    const entry: RecordEntry = {
      ts: Date.now(),
      type,
      sessionId,
      data,
    }
    const filePath = this.getSessionPath(sessionId)
    try {
      fs.appendFileSync(filePath, JSON.stringify(entry) + '\n', 'utf-8')
    } catch {
      // Silently fail — recording should never break the system
    }
  }

  /** Read all entries for a session. */
  readSession(sessionId: string): RecordEntry[] {
    const filePath = this.getSessionPath(sessionId)
    try {
      const content = fs.readFileSync(filePath, 'utf-8')
      return content
        .split('\n')
        .filter(Boolean)
        .map((line) => JSON.parse(line) as RecordEntry)
    } catch {
      return []
    }
  }

  /** Read entries starting from a specific line number (0-based). */
  readSessionFrom(sessionId: string, fromLine: number): RecordEntry[] {
    const all = this.readSession(sessionId)
    return all.slice(fromLine)
  }

  /** Delete a session's recording file. */
  deleteRecording(sessionId: string): void {
    try {
      fs.unlinkSync(this.getSessionPath(sessionId))
    } catch {
      // File may not exist
    }
  }

  /** Check if a session has a recording file. */
  hasRecording(sessionId: string): boolean {
    return fs.existsSync(this.getSessionPath(sessionId))
  }

  /** List all recorded session IDs. */
  listRecordedSessions(): string[] {
    try {
      return fs.readdirSync(this.sessionsDir)
        .filter((f) => f.endsWith('.jsonl'))
        .map((f) => f.replace('.jsonl', ''))
    } catch {
      return []
    }
  }

  /** Delete recordings older than retentionDays. */
  cleanupOldRecordings(): number {
    const cutoff = Date.now() - this.config.retentionDays * 24 * 60 * 60 * 1000
    let deleted = 0
    try {
      const files = fs.readdirSync(this.sessionsDir)
      for (const file of files) {
        const filePath = path.join(this.sessionsDir, file)
        const stat = fs.statSync(filePath)
        if (stat.mtimeMs < cutoff) {
          fs.unlinkSync(filePath)
          deleted++
        }
      }
    } catch {
      // Ignore cleanup errors
    }
    return deleted
  }

  /** Get the total line count for a session recording. */
  getLineCount(sessionId: string): number {
    const filePath = this.getSessionPath(sessionId)
    try {
      const content = fs.readFileSync(filePath, 'utf-8')
      return content.split('\n').filter(Boolean).length
    } catch {
      return 0
    }
  }

  private getSessionPath(sessionId: string): string {
    return path.join(this.sessionsDir, `${sessionId}.jsonl`)
  }
}

import type { PluginContext, CommandArgs } from '@openacp/plugin-sdk'
import type { ConversationRecordConfig, ImportCursor } from './types.js'
import type { ConversationRecorder } from './recorder.js'
import { formatContext } from './context-formatter.js'

/** Minimal interface for SessionManager methods we need. */
interface SessionManagerLike {
  listSessions(): Array<{ id: string; name?: string; agentName: string; workingDirectory: string; channelId: string }>
}

export class ContextBridge {
  private readonly recorder: ConversationRecorder
  private readonly config: ConversationRecordConfig
  private readonly pendingContext = new Map<string, string>()
  private cursors = new Map<string, ImportCursor>()

  constructor(recorder: ConversationRecorder, config: ConversationRecordConfig) {
    this.recorder = recorder
    this.config = config
  }

  /** Register /context command and beforePrompt middleware. */
  register(ctx: PluginContext): void {
    ctx.registerCommand({
      name: 'context',
      description: 'Import conversation context from another session',
      usage: '[session-number]',
      category: 'plugin',
      handler: (args) => this.handleCommand(ctx, args),
    })

    ctx.registerMiddleware('agent:beforePrompt', {
      priority: 100,
      handler: async (payload, next) => {
        const p = payload as { sessionId: string; text: string; attachments?: unknown[] }
        const pending = this.pendingContext.get(p.sessionId)
        if (pending) {
          this.pendingContext.delete(p.sessionId)
          ;(payload as Record<string, unknown>).text = `${pending}\n\n${p.text}`
        }
        return next()
      },
    })
  }

  /** Load cursors from storage. */
  async loadCursors(ctx: PluginContext): Promise<void> {
    const stored = await ctx.storage.get<Record<string, ImportCursor>>('cursors')
    if (stored) {
      this.cursors = new Map(Object.entries(stored))
    }
  }

  /** Save cursors to storage. */
  private async saveCursors(ctx: PluginContext): Promise<void> {
    await ctx.storage.set('cursors', Object.fromEntries(this.cursors))
  }

  private async handleCommand(ctx: PluginContext, args: CommandArgs): Promise<void> {
    const core = ctx.core as Record<string, unknown>
    const sessionManager = core.sessionManager as SessionManagerLike

    if (!args.raw.trim()) {
      // List sessions
      await this.listSessions(args, sessionManager)
      return
    }

    const num = parseInt(args.raw.trim(), 10)
    if (isNaN(num) || num < 1) {
      await args.reply('Usage: /context [session-number]')
      return
    }

    await this.importContext(ctx, args, sessionManager, num)
  }

  private async listSessions(args: CommandArgs, sessionManager: SessionManagerLike): Promise<void> {
    const sessions = sessionManager.listSessions()
    const recorded = sessions.filter((s) =>
      this.recorder.hasRecording(s.id) &&
      s.id !== args.sessionId &&
      s.name !== 'Assistant'
    )

    if (recorded.length === 0) {
      await args.reply('No recorded sessions available.')
      return
    }

    const lines = recorded.map((s, i) => {
      const name = s.name ?? 'Unnamed'
      const prompts = this.recorder.getLineCount(s.id)
      return `  ${i + 1}. "${name}" (${s.agentName}) — ${prompts} events`
    })

    await args.reply(`Active sessions:\n${lines.join('\n')}\n\nUse /context <number> to import context.`)
  }

  private async importContext(
    ctx: PluginContext,
    args: CommandArgs,
    sessionManager: SessionManagerLike,
    num: number,
  ): Promise<void> {
    const sessions = sessionManager.listSessions()
    const recorded = sessions.filter((s: { id: string; name?: string }) =>
      this.recorder.hasRecording(s.id) &&
      s.id !== args.sessionId &&
      s.name !== 'Assistant'
    )

    if (num > recorded.length) {
      await args.reply(`Session ${num} not found. Use /context to see available sessions.`)
      return
    }

    const source = recorded[num - 1]

    if (source.id === args.sessionId) {
      await args.reply('Cannot import context from the current session.')
      return
    }

    // Delta-aware: check cursor
    const cursorKey = `${args.sessionId}:${source.id}`
    const cursor = this.cursors.get(cursorKey)
    const fromLine = cursor?.lastLine ?? 0

    const entries = this.recorder.readSessionFrom(source.id, fromLine)
    if (entries.length === 0) {
      await args.reply('No new events since last import.')
      return
    }

    const formatted = formatContext(
      entries,
      source.name ?? 'Unnamed',
      source.agentName,
      source.workingDirectory,
      this.config.maxContextEntries,
      this.config.maxContextChars,
    )

    if (!formatted) {
      await args.reply('No conversation-relevant events found in that session.')
      return
    }

    // Store pending context
    this.pendingContext.set(args.sessionId!, formatted)

    // Update cursor
    const totalLines = this.recorder.getLineCount(source.id)
    this.cursors.set(cursorKey, { sourceSessionId: source.id, lastLine: totalLines })
    await this.saveCursors(ctx)

    await args.reply(`Context imported from "${source.name ?? 'Unnamed'}" (${entries.length} entries). Will be injected on your next prompt.`)
  }
}

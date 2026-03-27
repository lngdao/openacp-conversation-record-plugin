import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { ConversationRecorder } from '../recorder.js'
import { DEFAULT_CONFIG } from '../types.js'
import type { ConversationRecordConfig } from '../types.js'

function createTmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'conv-record-test-'))
}

function mockCtx() {
  const handlers = new Map<string, Function[]>()
  return {
    on(event: string, handler: Function) {
      const list = handlers.get(event) ?? []
      list.push(handler)
      handlers.set(event, list)
    },
    emit(event: string, payload: unknown) {
      const list = handlers.get(event) ?? []
      for (const h of list) h(payload)
    },
    off() {},
    handlers,
  }
}

describe('ConversationRecorder', () => {
  let tmpDir: string
  let recorder: ConversationRecorder

  beforeEach(() => {
    tmpDir = createTmpDir()
    recorder = new ConversationRecorder(tmpDir, { ...DEFAULT_CONFIG })
  })

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  it('records session:created event', () => {
    const ctx = mockCtx()
    recorder.register(ctx as any)

    ctx.emit('session:created', { sessionId: 's1', agentName: 'claude', userId: 'u1', channelId: 'telegram', workingDir: '/tmp' })

    const entries = recorder.readSession('s1')
    expect(entries).toHaveLength(1)
    expect(entries[0].type).toBe('session:created')
  })

  it('records agent:event based on record level', () => {
    const ctx = mockCtx()
    recorder.register(ctx as any)

    // standard level should record tool_call but not agent_thought_chunk
    ctx.emit('agent:event', { sessionId: 's1', event: { type: 'tool_call', tool: { name: 'Write', id: 'tc1' } } })
    ctx.emit('agent:event', { sessionId: 's1', event: { type: 'agent_thought_chunk', content: 'thinking...' } })

    const entries = recorder.readSession('s1')
    expect(entries).toHaveLength(1)
    expect((entries[0].data as any).type).toBe('tool_call')
  })

  it('respects excludeEvents config', () => {
    fs.rmSync(tmpDir, { recursive: true, force: true })
    tmpDir = createTmpDir()
    recorder = new ConversationRecorder(tmpDir, { ...DEFAULT_CONFIG, excludeEvents: ['tool_call'] })
    const ctx = mockCtx()
    recorder.register(ctx as any)

    ctx.emit('agent:event', { sessionId: 's1', event: { type: 'tool_call', tool: { name: 'Write', id: 'tc1' } } })
    ctx.emit('agent:event', { sessionId: 's1', event: { type: 'agent_message', content: 'hello' } })

    const entries = recorder.readSession('s1')
    expect(entries).toHaveLength(1)
    expect((entries[0].data as any).type).toBe('agent_message')
  })

  it('records to separate files per session', () => {
    const ctx = mockCtx()
    recorder.register(ctx as any)

    ctx.emit('session:created', { sessionId: 's1', agentName: 'claude', userId: 'u1', channelId: 'tg', workingDir: '/tmp' })
    ctx.emit('session:created', { sessionId: 's2', agentName: 'codex', userId: 'u1', channelId: 'tg', workingDir: '/tmp' })

    expect(recorder.readSession('s1')).toHaveLength(1)
    expect(recorder.readSession('s2')).toHaveLength(1)
    expect(recorder.hasRecording('s1')).toBe(true)
    expect(recorder.hasRecording('s3')).toBe(false)
  })

  it('delta reads from a specific line', () => {
    const ctx = mockCtx()
    recorder.register(ctx as any)

    ctx.emit('session:created', { sessionId: 's1', agentName: 'claude', userId: 'u1', channelId: 'tg', workingDir: '/tmp' })
    ctx.emit('session:named', { sessionId: 's1', name: 'Test Session' })
    ctx.emit('session:ended', { sessionId: 's1', reason: 'done' })

    const fromLine2 = recorder.readSessionFrom('s1', 2)
    expect(fromLine2).toHaveLength(1)
    expect(fromLine2[0].type).toBe('session:ended')
  })

  it('lists recorded sessions', () => {
    const ctx = mockCtx()
    recorder.register(ctx as any)

    ctx.emit('session:created', { sessionId: 'a1', agentName: 'claude', userId: 'u1', channelId: 'tg', workingDir: '/tmp' })
    ctx.emit('session:created', { sessionId: 'b2', agentName: 'codex', userId: 'u1', channelId: 'tg', workingDir: '/tmp' })

    const ids = recorder.listRecordedSessions()
    expect(ids).toContain('a1')
    expect(ids).toContain('b2')
  })

  it('cleans up old recordings', () => {
    const ctx = mockCtx()
    recorder.register(ctx as any)

    ctx.emit('session:created', { sessionId: 'old', agentName: 'claude', userId: 'u1', channelId: 'tg', workingDir: '/tmp' })

    // Backdate the file
    const filePath = path.join(tmpDir, 'sessions', 'old.jsonl')
    const pastDate = new Date(Date.now() - 31 * 24 * 60 * 60 * 1000)
    fs.utimesSync(filePath, pastDate, pastDate)

    const deleted = recorder.cleanupOldRecordings()
    expect(deleted).toBe(1)
    expect(recorder.hasRecording('old')).toBe(false)
  })

  it('records at minimal level only conversation events', () => {
    fs.rmSync(tmpDir, { recursive: true, force: true })
    tmpDir = createTmpDir()
    recorder = new ConversationRecorder(tmpDir, { ...DEFAULT_CONFIG, recordLevel: 'minimal' })
    const ctx = mockCtx()
    recorder.register(ctx as any)

    ctx.emit('agent:event', { sessionId: 's1', event: { type: 'agent_message', content: 'hi' } })
    ctx.emit('agent:event', { sessionId: 's1', event: { type: 'tool_call', tool: { name: 'Write', id: 'tc1' } } })
    ctx.emit('agent:prompt', { sessionId: 's1', text: 'hello' })

    const entries = recorder.readSession('s1')
    // minimal: agent_message recorded, tool_call not, agent:prompt not (minimal level)
    expect(entries).toHaveLength(1)
    expect((entries[0].data as any).type).toBe('agent_message')
  })

  it('records at full level including thinking', () => {
    fs.rmSync(tmpDir, { recursive: true, force: true })
    tmpDir = createTmpDir()
    recorder = new ConversationRecorder(tmpDir, { ...DEFAULT_CONFIG, recordLevel: 'full' })
    const ctx = mockCtx()
    recorder.register(ctx as any)

    ctx.emit('agent:event', { sessionId: 's1', event: { type: 'agent_thought_chunk', content: 'thinking...' } })
    ctx.emit('agent:event', { sessionId: 's1', event: { type: 'agent_message', content: 'hi' } })

    const entries = recorder.readSession('s1')
    expect(entries).toHaveLength(2)
  })
})

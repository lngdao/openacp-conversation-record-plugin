import { describe, it, expect } from 'vitest'
import { formatContext } from '../context-formatter.js'
import type { RecordEntry } from '../types.js'

function entry(type: string, data: unknown, ts = Date.now()): RecordEntry {
  return { ts, type, sessionId: 's1', data }
}

describe('formatContext', () => {
  it('returns empty string for no entries', () => {
    expect(formatContext([], 'Test', 'claude', '/tmp', 100, 8000)).toBe('')
  })

  it('formats simple conversation', () => {
    const entries = [
      entry('session:created', { sessionId: 's1', agentName: 'claude', userId: 'u1', channelId: 'tg', workingDir: '/tmp' }),
      entry('agent:prompt', { text: 'Build a REST API' }),
      entry('agent:event', { type: 'agent_message', content: 'I will create an Express app' }),
    ]

    const result = formatContext(entries, 'Build API', 'claude', '/tmp', 100, 8000)
    expect(result).toContain('[Context imported from session "Build API"')
    expect(result).toContain('User: "Build a REST API"')
    expect(result).toContain('Agent: I will create an Express app')
    expect(result).toContain('[End imported context]')
  })

  it('merges consecutive agent_message events', () => {
    const entries = [
      entry('agent:event', { type: 'agent_message', content: 'Hello ' }),
      entry('agent:event', { type: 'agent_message', content: 'world!' }),
    ]

    const result = formatContext(entries, 'Test', 'claude', '/tmp', 100, 8000)
    expect(result).toContain('Agent: Hello world!')
    // Should be one merged entry, not two
    expect(result.match(/Agent:/g)?.length).toBe(1)
  })

  it('collapses tool_call + tool_call_update pairs', () => {
    const entries = [
      entry('agent:event', { type: 'tool_call', tool: { name: 'Write', id: 'tc1', input: { file_path: 'src/app.ts' } } }),
      entry('agent:event', { type: 'tool_call_update', tool: { id: 'tc1' }, status: 'running' }),
      entry('agent:event', { type: 'tool_call_update', tool: { id: 'tc1' }, status: 'completed' }),
    ]

    const result = formatContext(entries, 'Test', 'claude', '/tmp', 100, 8000)
    expect(result).toContain('Write: src/app.ts')
    // Should be collapsed into one entry
    expect(result.split('\n').filter((l) => l.includes('Write')).length).toBe(1)
  })

  it('compresses consecutive explore runs', () => {
    const entries = [
      entry('agent:event', { type: 'tool_call', tool: { name: 'Read', id: 'r1', input: { file_path: 'src/a.ts' } } }),
      entry('agent:event', { type: 'tool_call', tool: { name: 'Read', id: 'r2', input: { file_path: 'src/b.ts' } } }),
      entry('agent:event', { type: 'tool_call', tool: { name: 'Grep', id: 'g1', input: { pattern: 'foo' } } }),
    ]

    const result = formatContext(entries, 'Test', 'claude', '/tmp', 100, 8000)
    expect(result).toContain('Explored:')
    expect(result).toContain('3 files')
  })

  it('deduplicates retried tool calls', () => {
    const entries = [
      entry('agent:event', { type: 'tool_call', tool: { name: 'Bash', id: 'b1', input: { command: 'npm test' } } }),
      entry('agent:event', { type: 'tool_call', tool: { name: 'Bash', id: 'b2', input: { command: 'npm test' } } }),
      entry('agent:event', { type: 'tool_call', tool: { name: 'Bash', id: 'b3', input: { command: 'npm test' } } }),
      entry('agent:event', { type: 'tool_call', tool: { name: 'Bash', id: 'b4', input: { command: 'npm test' } } }),
    ]

    const result = formatContext(entries, 'Test', 'claude', '/tmp', 100, 8000)
    expect(result).toContain('retried')
    // Should be collapsed
    expect(result.split('\n').filter((l) => l.includes('Bash')).length).toBe(1)
  })

  it('respects maxChars budget with smart selection', () => {
    const entries: RecordEntry[] = []
    // Add many events to exceed budget
    entries.push(entry('agent:prompt', { text: 'Initial request' }))
    for (let i = 0; i < 50; i++) {
      entries.push(entry('agent:event', { type: 'agent_message', content: `Response ${i} with some padding text to increase size.` }))
      entries.push(entry('agent:event', { type: 'tool_call', tool: { name: 'Write', id: `w${i}`, input: { file_path: `src/file${i}.ts` } } }))
    }
    entries.push(entry('agent:prompt', { text: 'Final request' }))

    // Tight budget — won't fit all but should truncate
    const result = formatContext(entries, 'Test', 'claude', '/tmp', 20, 3000)
    expect(result.length).toBeLessThanOrEqual(3000)
    // Should contain header and footer
    expect(result).toContain('[Context imported')
    expect(result).toContain('[End imported context]')
    // Should contain omission markers
    expect(result).toContain('events omitted')
    // Should keep first prompt (reserved)
    expect(result).toContain('Initial request')
  })

  it('keeps first prompt and last events as reserved', () => {
    const entries: RecordEntry[] = [
      entry('agent:prompt', { text: 'First prompt' }),
      entry('agent:event', { type: 'agent_message', content: 'Middle response' }),
      entry('agent:event', { type: 'agent_message', content: 'Last response' }),
    ]

    const result = formatContext(entries, 'Test', 'claude', '/tmp', 100, 8000)
    expect(result).toContain('First prompt')
    expect(result).toContain('Last response')
  })
})

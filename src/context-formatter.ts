import type { RecordEntry } from './types.js'

interface CompressedEntry {
  type: string
  summary: string
  score: number
  chars: number
}

/**
 * Phase 1: Compress — remove redundancy from raw entries.
 * Phase 2: Budget — select by importance scoring.
 */
export function formatContext(
  entries: RecordEntry[],
  sessionName: string,
  agentName: string,
  workingDir: string,
  maxEntries: number,
  maxChars: number,
): string {
  // Filter to conversation-relevant events only
  const relevant = filterRelevant(entries)
  if (relevant.length === 0) return ''

  // Phase 1: Compress
  const compressed = compress(relevant)

  // Phase 2: Budget
  const selected = budget(compressed, maxEntries, maxChars, sessionName, agentName, workingDir)

  return selected
}

/** Filter to events useful for context injection. */
function filterRelevant(entries: RecordEntry[]): RecordEntry[] {
  const relevantTypes = new Set([
    'agent:prompt',
    'agent:event',
    'session:created',
    'session:named',
  ])
  const relevantEventTypes = new Set([
    'agent_message',
    'text',
    'tool_call',
    'tool_call_update',
    'error',
  ])

  return entries.filter((e) => {
    if (e.type === 'agent:event') {
      const data = e.data as { type: string }
      return relevantEventTypes.has(data.type)
    }
    return relevantTypes.has(e.type)
  })
}

/** Phase 1: Compress entries by merging, collapsing, and deduplicating. */
function compress(entries: RecordEntry[]): CompressedEntry[] {
  const result: CompressedEntry[] = []
  let i = 0

  while (i < entries.length) {
    const entry = entries[i]

    if (entry.type === 'session:created') {
      // Skip — metadata handled in header
      i++
      continue
    }

    if (entry.type === 'session:named') {
      // Skip — name in header
      i++
      continue
    }

    if (entry.type === 'agent:prompt') {
      const data = entry.data as { text: string }
      const text = truncateText(data.text, 300)
      result.push({ type: 'prompt', summary: `User: "${text}"`, score: 10, chars: 0 })
      i++
      continue
    }

    if (entry.type === 'agent:event') {
      const event = entry.data as { type: string; [key: string]: unknown }

      // Rule 1: Merge consecutive text/agent_message
      if (event.type === 'agent_message' || event.type === 'text') {
        let merged = String(event.content ?? '')
        let j = i + 1
        while (j < entries.length) {
          const next = entries[j]
          if (next.type === 'agent:event') {
            const nextEvent = next.data as { type: string; content?: string }
            if (nextEvent.type === 'agent_message' || nextEvent.type === 'text') {
              merged += nextEvent.content ?? ''
              j++
              continue
            }
          }
          break
        }
        const text = truncateText(merged, 500)
        result.push({ type: 'agent_text', summary: `Agent: ${text}`, score: 8, chars: 0 })
        i = j
        continue
      }

      // Rule 2: Collapse tool_call + tool_call_update pairs
      if (event.type === 'tool_call') {
        const tool = event.tool as { name: string; id: string } | undefined
        const toolName = tool?.name ?? 'unknown'
        const toolId = tool?.id ?? ''

        // Look ahead for updates
        let finalStatus = 'started'
        let j = i + 1
        while (j < entries.length) {
          const next = entries[j]
          if (next.type === 'agent:event') {
            const nextEvent = next.data as { type: string; tool?: { id: string }; status?: string }
            if (nextEvent.type === 'tool_call_update' && nextEvent.tool?.id === toolId) {
              finalStatus = nextEvent.status ?? finalStatus
              j++
              continue
            }
          }
          break
        }

        // Rule 3: Compress explore runs
        const exploreTools = new Set(['Read', 'Grep', 'Glob', 'Ls'])
        if (exploreTools.has(toolName)) {
          // Look ahead for more consecutive explore tools
          const files: string[] = [extractPath(event)]
          let k = j
          while (k < entries.length) {
            const next = entries[k]
            if (next.type === 'agent:event') {
              const nextEvent = next.data as { type: string; tool?: { name: string; id: string } }
              if (nextEvent.type === 'tool_call' && exploreTools.has(nextEvent.tool?.name ?? '')) {
                files.push(extractPath(nextEvent))
                // Skip its updates too
                let m = k + 1
                while (m < entries.length) {
                  const upd = entries[m]
                  if (upd.type === 'agent:event') {
                    const updEvent = upd.data as { type: string; tool?: { id: string } }
                    if (updEvent.type === 'tool_call_update' && updEvent.tool?.id === nextEvent.tool?.id) {
                      m++
                      continue
                    }
                  }
                  break
                }
                k = m
                continue
              }
            }
            break
          }

          if (files.length > 1) {
            const fileList = files.filter(Boolean).join(', ')
            result.push({
              type: 'explore',
              summary: `Explored: ${fileList} (${files.length} files)`,
              score: 2,
              chars: 0,
            })
            i = k
            continue
          }

          // Single explore — low value
          result.push({ type: 'explore', summary: `${toolName}: ${files[0] || 'unknown'}`, score: 1, chars: 0 })
          i = j
          continue
        }

        // Rule 5: Deduplicate retries (same tool name consecutively)
        const executions: Array<{ args: string }> = [{ args: extractArgs(event) }]
        let k2 = j
        while (k2 < entries.length) {
          const next = entries[k2]
          if (next.type === 'agent:event') {
            const nextEvent = next.data as { type: string; tool?: { name: string; id: string } }
            if (nextEvent.type === 'tool_call' && nextEvent.tool?.name === toolName) {
              executions.push({ args: extractArgs(nextEvent) })
              // Skip updates
              let m = k2 + 1
              while (m < entries.length) {
                const upd = entries[m]
                if (upd.type === 'agent:event') {
                  const updEvent = upd.data as { type: string; tool?: { id: string } }
                  if (updEvent.type === 'tool_call_update' && updEvent.tool?.id === nextEvent.tool?.id) {
                    m++
                    continue
                  }
                }
                break
              }
              k2 = m
              continue
            }
          }
          break
        }

        if (executions.length > 2) {
          // Deduplicate: show first + last, collapse middle
          const first = executions[0].args
          const last = executions[executions.length - 1].args
          const score = getToolScore(toolName)
          result.push({
            type: 'tool',
            summary: `${toolName}: ${first} [...retried ${executions.length - 2} times] → ${last}`,
            score,
            chars: 0,
          })
          i = k2
          continue
        }

        // Normal tool call
        const args = extractArgs(event)
        const score = getToolScore(toolName)
        result.push({
          type: 'tool',
          summary: `${toolName}: ${truncateText(args, 200)}`,
          score,
          chars: 0,
        })
        i = j
        continue
      }

      // tool_call_update without prior tool_call (orphan) — skip
      if (event.type === 'tool_call_update') {
        i++
        continue
      }

      // Error
      if (event.type === 'error') {
        const msg = String((event as { message?: string }).message ?? 'Unknown error')
        result.push({ type: 'error', summary: `Error: ${truncateText(msg, 200)}`, score: 6, chars: 0 })
        i++
        continue
      }
    }

    i++
  }

  // Calculate chars for each entry
  for (const entry of result) {
    entry.chars = entry.summary.length + 1 // +1 for newline
  }

  return result
}

/** Phase 2: Select entries within budget using importance scoring. */
function budget(
  entries: CompressedEntry[],
  maxEntries: number,
  maxChars: number,
  sessionName: string,
  agentName: string,
  workingDir: string,
): string {
  const header = `[Context imported from session "${sessionName}" (${agentName}) in ${workingDir}]\n\n`
  const footer = '\n[End imported context]'
  const reservedChars = header.length + footer.length

  let availableChars = maxChars - reservedChars
  if (availableChars <= 0) return ''

  // If everything fits, return all
  const totalChars = entries.reduce((sum, e) => sum + e.chars, 0)
  if (entries.length <= maxEntries && totalChars <= availableChars) {
    return header + entries.map((e) => `- ${e.summary}`).join('\n') + footer
  }

  // Reserved: first prompt + last 10 entries
  const firstPromptIdx = entries.findIndex((e) => e.type === 'prompt')
  const reserved = new Set<number>()

  if (firstPromptIdx >= 0) reserved.add(firstPromptIdx)
  for (let i = Math.max(0, entries.length - 10); i < entries.length; i++) {
    reserved.add(i)
  }

  // Calculate reserved chars
  let reservedEntryChars = 0
  for (const idx of reserved) {
    reservedEntryChars += entries[idx].chars + 2 // "- " prefix
  }
  availableChars -= reservedEntryChars

  // Score remaining entries, sort by score (desc) then recency (desc)
  const candidates = entries
    .map((e, i) => ({ entry: e, index: i }))
    .filter(({ index }) => !reserved.has(index))
    .sort((a, b) => {
      if (b.entry.score !== a.entry.score) return b.entry.score - a.entry.score
      return b.index - a.index // recency
    })

  // Fill budget
  const selected = new Set<number>(reserved)
  let usedChars = 0
  for (const { entry, index } of candidates) {
    const entryChars = entry.chars + 2
    if (selected.size >= maxEntries) break
    if (usedChars + entryChars > availableChars) continue
    selected.add(index)
    usedChars += entryChars
  }

  // Build output in chronological order, insert gaps
  const sortedIndices = [...selected].sort((a, b) => a - b)
  const lines: string[] = []
  let lastIdx = -1
  const omittedTotal = entries.length - sortedIndices.length

  for (const idx of sortedIndices) {
    if (lastIdx >= 0 && idx - lastIdx > 1) {
      const gap = idx - lastIdx - 1
      lines.push(`[...${gap} events omitted]`)
    }
    lines.push(`- ${entries[idx].summary}`)
    lastIdx = idx
  }

  // Trailing gap
  if (lastIdx < entries.length - 1) {
    const gap = entries.length - 1 - lastIdx
    lines.push(`[...${gap} events omitted]`)
  }

  return header + lines.join('\n') + footer
}

function getToolScore(toolName: string): number {
  if (toolName === 'Write' || toolName === 'Edit') return 7
  if (toolName === 'Bash') return 6
  return 1
}

function extractPath(event: Record<string, unknown>): string {
  const tool = event.tool as { input?: Record<string, unknown> } | undefined
  const input = tool?.input ?? {}
  return String(input.file_path ?? input.path ?? input.pattern ?? '')
}

function extractArgs(event: Record<string, unknown>): string {
  const tool = event.tool as { name?: string; input?: Record<string, unknown> } | undefined
  const input = tool?.input ?? {}
  const name = tool?.name ?? ''

  if (name === 'Write' || name === 'Edit') {
    return String(input.file_path ?? input.path ?? '')
  }
  if (name === 'Bash') {
    return String(input.command ?? '')
  }
  // Generic: first string value
  for (const val of Object.values(input)) {
    if (typeof val === 'string' && val.length > 0) return val
  }
  return ''
}

function truncateText(text: string, maxLen: number): string {
  if (text.length <= maxLen) return text
  return text.slice(0, maxLen) + '...'
}

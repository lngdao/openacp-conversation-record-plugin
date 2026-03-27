export type RecordLevel = 'minimal' | 'standard' | 'full'

export interface RecordEntry {
  ts: number
  type: string
  sessionId: string
  data: unknown
}

export interface ConversationRecordConfig {
  recordLevel: RecordLevel
  excludeEvents: string[]
  maxContextEntries: number
  maxContextChars: number
  retentionDays: number
}

export interface ImportCursor {
  sourceSessionId: string
  lastLine: number
}

export const DEFAULT_CONFIG: ConversationRecordConfig = {
  recordLevel: 'standard',
  excludeEvents: [],
  maxContextEntries: 100,
  maxContextChars: 8000,
  retentionDays: 30,
}

// Events included per record level (cumulative)
const MINIMAL_EVENTS: Set<string> = new Set([
  'text',               // agent text response
  'agent_message',      // legacy name
  'user_message_chunk', // user replay on resume
])

const STANDARD_EVENTS: Set<string> = new Set([
  ...MINIMAL_EVENTS,
  'tool_call',
  'tool_call_update',
  'error',
  'usage',
])

const FULL_EVENTS: Set<string> = new Set([
  ...STANDARD_EVENTS,
  'thought',
  'agent_thought_chunk',
  'commands_update',
  'current_mode_update',
  'config_option_update',
  'model_update',
  'resource_content',
  'resource_link',
  'session_info_update',
])

const LEVEL_MAP: Record<RecordLevel, Set<string>> = {
  minimal: MINIMAL_EVENTS,
  standard: STANDARD_EVENTS,
  full: FULL_EVENTS,
}

/**
 * Check if an agent event subtype should be recorded at the given level.
 * Session lifecycle events (session:created, session:ended, etc.) are always recorded
 * and don't go through this filter — they are EventBus events, not AgentEvent subtypes.
 */
export function shouldRecord(
  eventType: string,
  level: RecordLevel,
  excludeEvents: string[],
): boolean {
  if (excludeEvents.includes(eventType)) return false
  return LEVEL_MAP[level].has(eventType)
}

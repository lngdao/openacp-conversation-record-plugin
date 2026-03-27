# @openacp/plugin-conversation-record

OpenACP plugin that records session events to disk and enables cross-session context injection.

## Features

- **Conversation Recording** — Subscribes to EventBus events, appends each event as a JSONL line per session
- **Context Bridge** — `/context` command that reads recorded events from another session, formats them, and injects into the current session's next prompt
- **Delta-aware imports** — Tracks cursors so repeated imports only bring new events
- **Smart compression** — Merges consecutive messages, collapses tool call chains, deduplicates retries
- **Budget-aware selection** — Prioritizes high-value events (prompts, edits, errors) when context exceeds limits

## Install

```bash
openacp plugin add @openacp/plugin-conversation-record
```

## Configuration

Add to your OpenACP plugin config:

```json
{
  "recordLevel": "standard",
  "excludeEvents": [],
  "maxContextEntries": 100,
  "maxContextChars": 8000,
  "retentionDays": 30
}
```

### Record Levels

| Level | Events recorded |
|---|---|
| `minimal` | Agent text responses only |
| `standard` | Text + tool calls + errors + usage |
| `full` | Everything including thinking, mode changes, config updates |

## Usage

### List available sessions

```
/context
```

### Import context from a session

```
/context 3
```

Context is injected into your next prompt automatically via `agent:beforePrompt` middleware.

## Development

```bash
npm install
npm run build
npm test
```

### Dev mode with hot-reload

```bash
openacp dev ./
```

## How it works

```
Agent events → EventBus → ConversationRecorder → JSONL file (per session)

User: /context 3 → ContextBridge
  → read session 3 JSONL
  → filter conversation-relevant events
  → compress & budget-select
  → store import cursor (delta-aware)

User sends prompt → agent:beforePrompt middleware
  → prepend imported context
  → agent receives enriched prompt
```

## License

MIT

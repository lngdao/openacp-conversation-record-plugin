import type { OpenACPPlugin } from '@openacp/plugin-sdk'
import { ConversationRecorder } from './recorder.js'
import { ContextBridge } from './context-bridge.js'
import { DEFAULT_CONFIG } from './types.js'
import type { ConversationRecordConfig } from './types.js'

const conversationRecordPlugin: OpenACPPlugin = {
  name: '@lngdao/openacp-plugin-conversation-record',
  version: '0.1.0',
  description: 'Record session events and bridge context between sessions',
  permissions: [
    'events:read',
    'commands:register',
    'middleware:register',
    'storage:read',
    'storage:write',
    'kernel:access',
  ],

  async setup(ctx) {
    const config: ConversationRecordConfig = {
      ...DEFAULT_CONFIG,
      ...(ctx.pluginConfig as Partial<ConversationRecordConfig>),
    }

    const dataDir = ctx.storage.getDataDir()
    const recorder = new ConversationRecorder(dataDir, config)

    // Cleanup old recordings on boot
    const deleted = recorder.cleanupOldRecordings()
    if (deleted > 0) {
      ctx.log.info(`Cleaned up ${deleted} old recording(s)`)
    }

    // Register event listeners for recording
    recorder.register(ctx)

    // Setup context bridge
    const bridge = new ContextBridge(recorder, config)
    await bridge.loadCursors(ctx)
    bridge.register(ctx)

    ctx.log.info(`Conversation record ready (level: ${config.recordLevel})`)
  },
}

export default conversationRecordPlugin

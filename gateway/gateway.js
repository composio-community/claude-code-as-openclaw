import http from 'node:http'
import { spawn } from 'node:child_process'
import path from 'node:path'
import { loadConfig, getConfig, watchConfig, paths } from './config.js'
import {
  loadPersistedSessions,
  getOrCreateSession,
  getSession,
  appendMessage,
  getAllSessions,
  clearSession,
} from './sessionManager.js'
import {
  loadPairedUsers,
  checkAccess,
  approvePairingCode,
  getPendingPairs,
} from './auth.js'
import { TelegramChannel } from './channels/telegram.js'
import { DiscordChannel } from './channels/discord.js'
import { SlackChannel } from './channels/slack.js'
import { WhatsAppChannel } from './channels/whatsapp.js'
import {
  initCronScheduler,
  startCronScheduler,
  stopCronScheduler,
  setCronGateway,
  createCronTask,
  deleteCronTask,
  listCronTasks,
} from './cron.js'
import { transcribeVoice, textToVoice, cleanupVoiceFile } from './voice.js'
import {
  loadMemoryContext,
  buildFlushPrompt,
  runDreamConsolidation,
  writeMemoryFile,
  appendToDiary,
  searchMemory,
  readMemoryFile,
  listMemoryFiles,
} from './memory.js'

/**
 * The Gateway: a single long-lived Node.js process that manages channels,
 * sessions, auth, and spawns the real Claude Code CLI for each agent turn.
 *
 * Each incoming message is routed through auth, then dispatched to a
 * `claude -p <prompt> --resume <sessionId> --output-format stream-json --verbose`
 * subprocess. The full Claude Code with all tools, MCP, memory, etc. runs
 * in that subprocess. The gateway collects the streamed output and sends
 * the final assistant text back to the channel.
 */
export class Gateway {
  constructor() {
    this.channels = new Map() // platform -> channel instance
    this.httpServer = null
    this.activeTurns = new Set() // channelKeys with agent turn in flight
    this.messageQueues = new Map() // channelKey -> queued messages while turn runs
    this.log = makeLogger('gateway')
  }

  async start() {
    const config = await loadConfig()
    await loadPairedUsers()
    await loadPersistedSessions()

    this.log(
      `OpenClaudeClaw Gateway starting on ${config.gateway.host}:${config.gateway.port}`,
    )

    // Start channels
    await this._startChannels(config)

    // Start cron scheduler
    initCronScheduler(this.log)
    setCronGateway(this)
    await startCronScheduler()

    // Dream consolidation — runs daily at 4am, promotes diary entries to MEMORY.md
    this._dreamTimer = setInterval(async () => {
      const hour = new Date().getHours()
      if (hour === 4) {
        this.log('Running dream consolidation...')
        const result = await runDreamConsolidation()
        this.log(`Dream: reviewed ${result.reviewed} entries, promoted ${result.promoted}`)
      }
    }, 60 * 60 * 1000) // check every hour

    // Start HTTP control server
    await this._startHttpServer(config)

    // Watch config for hot-reload
    watchConfig(newConfig => {
      this.log('Config changed, reloading channels...')
      this._startChannels(newConfig).catch(err => {
        this.log(`Channel reload error: ${err.message}`)
      })
    })

    this.log('Gateway ready.')
  }

  async stop() {
    stopCronScheduler()
    for (const [platform, channel] of this.channels) {
      channel.stop()
      this.log(`Stopped ${platform} channel`)
    }
    if (this.httpServer) {
      await new Promise(resolve => this.httpServer.close(resolve))
    }
    this.log('Gateway stopped.')
  }

  // --- Channel management ---

  async _startChannels(config) {
    // Telegram
    if (
      config.channels.telegram?.enabled &&
      config.channels.telegram?.botToken
    ) {
      if (!this.channels.has('telegram')) {
        const tg = new TelegramChannel({
          botToken: config.channels.telegram.botToken,
          pollingTimeout: config.channels.telegram.pollingTimeout ?? 30,
        })

        tg.on('message', msg => this._handleIncoming('telegram', msg))
        tg.on('voice', msg => this._handleVoice('telegram', msg))
        tg.on('error', err => this.log(`Telegram error: ${err.message}`))

        try {
          const botInfo = await tg.start()
          this.channels.set('telegram', tg)
          this.log(`Telegram connected: @${botInfo.username}`)
        } catch (err) {
          this.log(`Telegram failed to start: ${err.message}`)
        }
      }
    } else if (this.channels.has('telegram')) {
      this.channels.get('telegram').stop()
      this.channels.delete('telegram')
      this.log('Telegram channel disabled')
    }

    // Discord
    if (
      config.channels.discord?.enabled &&
      config.channels.discord?.botToken
    ) {
      if (!this.channels.has('discord')) {
        const dc = new DiscordChannel({
          botToken: config.channels.discord.botToken,
        })

        dc.on('message', msg => this._handleIncoming('discord', msg))
        dc.on('error', err => this.log(`Discord error: ${err.message}`))

        try {
          const botInfo = await dc.start()
          this.channels.set('discord', dc)
          this.log(`Discord connected: ${botInfo.username}`)
        } catch (err) {
          this.log(`Discord failed to start: ${err.message}`)
        }
      }
    } else if (this.channels.has('discord')) {
      this.channels.get('discord').stop()
      this.channels.delete('discord')
      this.log('Discord channel disabled')
    }

    // Slack
    if (
      config.channels.slack?.enabled &&
      config.channels.slack?.botToken &&
      config.channels.slack?.appToken
    ) {
      if (!this.channels.has('slack')) {
        const sl = new SlackChannel({
          botToken: config.channels.slack.botToken,
          appToken: config.channels.slack.appToken,
        })

        sl.on('message', msg => this._handleIncoming('slack', msg))
        sl.on('error', err => this.log(`Slack error: ${err.message}`))

        try {
          const botInfo = await sl.start()
          this.channels.set('slack', sl)
          this.log(`Slack connected: ${botInfo.botName}`)
        } catch (err) {
          this.log(`Slack failed to start: ${err.message}`)
        }
      }
    } else if (this.channels.has('slack')) {
      this.channels.get('slack').stop()
      this.channels.delete('slack')
      this.log('Slack channel disabled')
    }

    // WhatsApp (via Baileys)
    if (config.channels.whatsapp?.enabled) {
      if (!this.channels.has('whatsapp')) {
        const wa = new WhatsAppChannel({})

        wa.on('message', msg => this._handleIncoming('whatsapp', msg))
        wa.on('error', err => this.log(`WhatsApp error: ${err.message}`))

        try {
          const botInfo = await wa.start()
          this.channels.set('whatsapp', wa)
          this.log(`WhatsApp connected: ${botInfo.name ?? botInfo.jid}`)
        } catch (err) {
          this.log(`WhatsApp failed to start: ${err.message}`)
        }
      }
    } else if (this.channels.has('whatsapp')) {
      this.channels.get('whatsapp').stop()
      this.channels.delete('whatsapp')
      this.log('WhatsApp channel disabled')
    }
  }

  // --- Voice handling ---

  async _handleVoice(platform, msg) {
    const channel = this.channels.get(platform)
    if (!channel) return

    const channelKey = `${platform}:${msg.chatId}`
    const access = checkAccess(platform, msg.userId, msg.username)
    if (!access.allowed) {
      if (access.message) await channel.sendMessage(msg.chatId, access.message)
      return
    }

    try {
      await channel.sendTyping(msg.chatId)

      // Transcribe voice to text
      this.log(`Transcribing voice from ${channelKey} (${msg.duration}s)`)
      const text = await transcribeVoice(channel, msg.fileId)
      this.log(`Transcribed: "${text.slice(0, 80)}"`)

      if (!text) {
        await channel.sendMessage(msg.chatId, "(couldn't understand the voice message)")
        return
      }

      // Process as a regular text message
      const textMsg = { ...msg, text }
      await this._handleIncoming(platform, textMsg)

      // Also send a voice reply if the config says so
      const config = getConfig()
      if (config.voice?.replyWithVoice) {
        const session = getSession(channelKey)
        const lastMsg = session?.messages?.at(-1)
        if (lastMsg?.content) {
          const oggPath = await textToVoice(lastMsg.content)
          await channel.sendVoice(msg.chatId, oggPath)
          await cleanupVoiceFile(oggPath)
        }
      }
    } catch (err) {
      this.log(`Voice error for ${channelKey}: ${err.message}`)
      await channel.sendMessage(msg.chatId, `Voice error: ${err.message}`).catch(() => {})
    }
  }

  // --- Message handling ---

  async _handleIncoming(platform, msg) {
    const channelKey = `${platform}:${msg.chatId}`

    // Auth check
    const access = checkAccess(platform, msg.userId, msg.username)
    if (!access.allowed) {
      const channel = this.channels.get(platform)
      if (channel && access.message) {
        await channel.sendMessage(msg.chatId, access.message)
      }
      this.log(
        `Denied ${platform} user ${msg.userId} (${msg.username}): ${access.pairingCode ?? 'not allowed'}`,
      )
      return
    }

    // Soul setup — after pairing, first thing is defining the agent's identity
    const soul = await readMemoryFile('SOUL.md')
    if (!soul) {
      const channel = this.channels.get(platform)
      if (!channel) return

      if (!this._soulSetupActive) {
        this._soulSetupActive = true
        await channel.sendMessage(msg.chatId, [
          'Welcome! One required step before we start.',
          '',
          'Define your agent\'s soul — who should I be? This sets my personality, role, and style for every conversation.',
          '',
          'Example: "You are a senior engineer. Be concise and direct. Use code examples. Never apologize."',
          '',
          'Type it now:',
        ].join('\n'))
        return
      }

      // They're responding with the soul
      await writeMemoryFile('SOUL.md', msg.text)
      this._soulSetupActive = false
      await channel.sendMessage(msg.chatId, 'Got it. That\'s who I am now. Let\'s go.')
      this.log(`SOUL.md set by ${channelKey}: ${msg.text.slice(0, 80)}`)
      return
    }

    // If agent is already running a turn for this chat, queue the message
    if (this.activeTurns.has(channelKey)) {
      if (!this.messageQueues.has(channelKey)) {
        this.messageQueues.set(channelKey, [])
      }
      this.messageQueues.get(channelKey).push(msg)
      this.log(`Queued message for ${channelKey} (agent busy)`)
      return
    }

    // Handle slash commands before sending to agent
    const slashResult = await this._handleSlashCommand(platform, channelKey, msg)
    if (slashResult) return

    await this._runAgentTurn(platform, channelKey, msg)
  }

  async _handleSlashCommand(platform, channelKey, msg) {
    const channel = this.channels.get(platform)
    if (!channel) return false
    const text = msg.text.trim()

    if (text === '!new' || text === '!reset' || text === '/new' || text === '/reset') {
      await clearSession(channelKey)
      await channel.sendMessage(msg.chatId, 'Session cleared. Starting fresh.')
      this.log(`Session cleared for ${channelKey}`)
      return true
    }

    if (text === '!status' || text === '/status') {
      const session = getSession(channelKey)
      if (session) {
        await channel.sendMessage(msg.chatId,
          `Session: ${session.id.slice(0, 8)}...\nMessages: ${session.messages.length}\nSince: ${session.createdAt}`)
      } else {
        await channel.sendMessage(msg.chatId, 'No active session.')
      }
      return true
    }

    if (text === '!help' || text === '/help') {
      await channel.sendMessage(msg.chatId, [
        'Commands (use ! or / prefix):',
        '!new — Start a fresh conversation',
        '!status — Show current session info',
        '!model <name> — Switch model',
        '!help — Show this message',
        '',
        'On Discord, use ! prefix to avoid slash command conflicts.',
      ].join('\n'))
      return true
    }

    if (text.startsWith('!model') || text.startsWith('/model')) {
      const name = text.replace(/^[!/]model\s*/, '').trim()
      if (!name) {
        const config = getConfig()
        const current = config.agent?.model ?? 'default'
        const providers = config.models?.providers ?? {}
        const lines = [`Current: ${current}`, '', 'Available:']
        for (const [provName, prov] of Object.entries(providers)) {
          const models = (prov.models ?? []).map(m => m.id).join(', ')
          if (models) lines.push(`  ${provName}: ${models}`)
        }
        lines.push('', 'Usage: /model <id> or /model <provider>/<id>')
        await channel.sendMessage(msg.chatId, lines.join('\n'))
        return true
      }
      const config = getConfig()
      config.agent = config.agent ?? {}
      config.agent.model = name
      await channel.sendMessage(msg.chatId, `Model set to: ${name}`)
      return true
    }

    return false
  }

  async _runAgentTurn(platform, channelKey, msg) {
    const config = getConfig()
    const channel = this.channels.get(platform)
    if (!channel) return

    this.activeTurns.add(channelKey)

    try {
      // Send typing indicator
      await channel.sendTyping(msg.chatId)

      // Get or create session
      const session = await getOrCreateSession(channelKey, {
        platform,
        userId: msg.userId,
        username: msg.username,
        firstName: msg.firstName,
      })

      // Spawn the real Claude Code CLI with gateway context
      let responseText
      try {
        responseText = await this._spawnClaudeCode(session, msg.text, config, channelKey)
      } catch (spawnErr) {
        // Stale session — reset and retry fresh
        if (spawnErr.message?.includes('No conversation found') && session.claudeSessionId) {
          this.log(`Stale Claude session ${session.claudeSessionId}, starting fresh`)
          session.claudeSessionId = null
          responseText = await this._spawnClaudeCode(session, msg.text, config, channelKey)
        } else {
          throw spawnErr
        }
      }

      // Persist the exchange
      await appendMessage(channelKey, {
        role: 'user',
        content: msg.text,
        timestamp: new Date().toISOString(),
      })
      await appendMessage(channelKey, {
        role: 'assistant',
        content: responseText,
        timestamp: new Date().toISOString(),
      })

      // Send reply (thread-style on Discord)
      await channel.sendMessage(msg.chatId, responseText || '(no response)', { replyTo: msg.messageId })
    } catch (err) {
      this.log(`Agent error for ${channelKey}: ${err.message}`)
      try {
        await channel.sendMessage(msg.chatId, `Error: ${err.message}`)
      } catch {
        // can't send error to user, just log
      }
    } finally {
      this.activeTurns.delete(channelKey)

      // Process queued messages
      const queue = this.messageQueues.get(channelKey)
      if (queue?.length > 0) {
        const next = queue.shift()
        if (queue.length === 0) this.messageQueues.delete(channelKey)
        this._runAgentTurn(platform, channelKey, next)
      }
    }
  }

  /**
   * Run a prompt through either:
   *   - Claude CLI (for Anthropic models — full tool use)
   *   - Direct OpenAI-compatible API call (for OpenAI, DeepSeek, Qwen, Ollama)
   */
  async _spawnClaudeCode(session, prompt, config, channelKey = null) {
    const modelId = config.agent?.model
    const provider = this._resolveProvider(modelId, config)

    // Non-Anthropic provider — call OpenAI-compatible API directly
    if (provider && provider.name !== 'anthropic') {
      return this._callOpenAICompatible(session, prompt, provider)
    }

    // Anthropic — use the full claude CLI with tools
    return this._spawnClaude(session, prompt, config, channelKey)
  }

  _resolveProvider(modelId, config) {
    if (!modelId) return null
    const providers = config.models?.providers ?? {}
    for (const [name, prov] of Object.entries(providers)) {
      const models = prov.models ?? []
      if (models.some(m => m.id === modelId)) {
        return { name, ...prov, resolvedModel: modelId }
      }
    }
    // Check if it's a provider/model format like "openai/gpt-4o"
    if (modelId.includes('/')) {
      const [provName, model] = modelId.split('/', 2)
      const prov = providers[provName]
      if (prov) return { name: provName, ...prov, resolvedModel: model }
    }
    return null
  }

  async _callOpenAICompatible(session, prompt, provider) {
    const apiKey = provider.apiKey ?? process.env[`${provider.name.toUpperCase()}_API_KEY`]
    if (!apiKey) throw new Error(`No API key for provider "${provider.name}". Set ${provider.name.toUpperCase()}_API_KEY or add apiKey to config.`)

    const messages = [
      ...(session.openaiMessages ?? []),
      { role: 'user', content: prompt },
    ]

    const res = await fetch(`${provider.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model: provider.resolvedModel,
        messages,
        temperature: 0,
      }),
    })

    if (!res.ok) {
      const body = await res.text()
      throw new Error(`${provider.name} API error ${res.status}: ${body.slice(0, 300)}`)
    }

    const data = await res.json()
    const reply = data.choices?.[0]?.message?.content ?? ''

    // Persist conversation for multi-turn
    session.openaiMessages = [
      ...messages,
      { role: 'assistant', content: reply },
    ]

    return reply
  }

  async _spawnClaude(session, prompt, config, channelKey = null) {
    return new Promise(async (resolve, reject) => {
      const claudeBinRaw = config.agent?.claudeBin ?? 'claude'
      const claudeParts = claudeBinRaw.split(/\s+/)
      const claudeBin = claudeParts[0]
      const claudePrefix = claudeParts.slice(1) // e.g. ["node", "/path/cli.js"] -> bin="node", prefix=["/path/cli.js"]
      const gatewayPort = config.gateway?.port ?? 18789
      const args = [...claudePrefix, '-p', prompt, '--output-format', 'json', '--allowedTools', 'Bash,Read,Write,Edit,Glob,Grep,Agent,WebSearch,WebFetch']

      // Resume the exact Claude session for this chat
      if (session.claudeSessionId) {
        args.push('--resume', session.claudeSessionId)
      }

      if (config.agent?.model) {
        args.push('--model', config.agent.model)
      }
      if (config.agent?.fallbackModel) {
        args.push('--fallback-model', config.agent.fallbackModel)
      }
      if (config.agent?.maxTurns) {
        args.push('--max-turns', String(config.agent.maxTurns))
      }
      if (config.agent?.workspaceRoot) {
        args.push('--add-dir', config.agent.workspaceRoot)
      }
      if (config.agent?.allowedTools?.length) {
        args.push('--allowedTools', ...config.agent.allowedTools)
      }

      // Tell Claude about the gateway cron API so it can schedule tasks
      const cronPrompt = [
        'You are running inside the OpenClaudeClaw gateway daemon connected to Telegram.',
        'You can schedule persistent cron jobs that run even when no Claude session is open.',
        'When the user asks to schedule, remind, or set up recurring tasks, use the Bash tool to call the gateway API:',
        '',
        'Create a recurring cron job:',
        `  curl -s -X POST http://127.0.0.1:${gatewayPort}/cron/create -H 'content-type: application/json' -d '{"cron":"<5-field cron>","prompt":"<what to do>","recurring":true,"notifyChannel":"${channelKey ?? ''}"}'`,
        '',
        'Create a one-shot task:',
        `  curl -s -X POST http://127.0.0.1:${gatewayPort}/cron/create -H 'content-type: application/json' -d '{"cron":"<5-field cron>","prompt":"<what to do>","recurring":false,"notifyChannel":"${channelKey ?? ''}"}'`,
        '',
        'List cron jobs:',
        `  curl -s http://127.0.0.1:${gatewayPort}/cron/list`,
        '',
        'Delete a cron job:',
        `  curl -s -X POST http://127.0.0.1:${gatewayPort}/cron/delete -H 'content-type: application/json' -d '{"id":"<job_id>"}'`,
        '',
        'The cron expression uses 5 fields: minute hour day-of-month month day-of-week (local time).',
        'Results of cron jobs are automatically sent to the user on Telegram.',
        'IMPORTANT: Always include the notifyChannel field so results reach the user.',
      ].join('\n')

      // Load persistent memory
      const memoryContext = await loadMemoryContext()
      const memoryInstructions = buildMemoryInstructions(gatewayPort)

      // Soul prepended (keeps Claude's default coding instructions intact)
      const soul = await readMemoryFile('SOUL.md')

      const appendPrompt = [
        // Soul at the top — identity first
        soul ? [
          '=== YOUR IDENTITY ===',
          soul,
          'Stay in this character for every response. This defines who you are.',
          '',
        ].join('\n') : '',
        // Memory context — loaded from disk, tools handle read/write natively
        memoryContext ? `=== YOUR MEMORY ===\n${memoryContext}\n` : '',
        // Memory protocol
        '=== MEMORY PROTOCOL ===',
        'You have MemorySearch and MemorySave tools. Use them:',
        '- ALWAYS search memory before saying you don\'t remember something',
        '- ALWAYS save when user corrects you, states a preference, or shares info to remember',
        '- ALWAYS save after completing significant tasks (to diary)',
        '',
        // Cron
        cronPrompt,
      ].join('\n')

      args.push('--append-system-prompt', appendPrompt)

      this.log(`Spawning: ${claudeBin} ${args.slice(0, 4).join(' ')} ...`)

      const child = spawn(claudeBin, args, {
        cwd: config.agent?.workspaceRoot ?? process.cwd(),
        env: process.env,
        stdio: ['pipe', 'pipe', 'pipe'],
      })

      let stdout = ''
      let stderr = ''

      child.stdout.on('data', chunk => {
        stdout += chunk.toString()
      })
      child.stderr.on('data', chunk => {
        stderr += chunk.toString()
      })

      child.on('error', err => {
        reject(new Error(`Failed to spawn claude: ${err.message}`))
      })

      child.on('close', code => {
        if (code !== 0 && !stdout) {
          reject(
            new Error(
              `claude exited with code ${code}: ${stderr.slice(0, 500)}`,
            ),
          )
          return
        }

        // Parse JSON output to get session_id and result text
        let text = stdout.trim()
        try {
          const data = JSON.parse(text)
          // Store the Claude session ID so we can --resume it next turn
          if (data.session_id) {
            session.claudeSessionId = data.session_id
          }
          text = data.result ?? text
        } catch {
          // Not JSON, use raw output
        }

        resolve(text)
      })

      // Close stdin immediately — prompt is passed via -p flag
      child.stdin.end()
    })
  }

  // --- HTTP control server ---

  async _startHttpServer(config) {
    const { port, host } = config.gateway

    this.httpServer = http.createServer(async (req, res) => {
      const url = new URL(req.url, `http://${host}:${port}`)
      const route = `${req.method} ${url.pathname}`

      try {
        switch (route) {
          case 'GET /health':
            return jsonResponse(res, 200, {
              status: 'ok',
              uptime: process.uptime(),
              channels: [...this.channels.keys()],
              sessions: getAllSessions().length,
            })

          case 'GET /sessions':
            return jsonResponse(res, 200, {
              sessions: getAllSessions().map(s => ({
                id: s.id,
                channelKey: s.channelKey,
                metadata: s.metadata,
                messageCount: s.messages.length,
                lastActiveAt: s.lastActiveAt,
              })),
            })

          case 'GET /pairs/pending':
            return jsonResponse(res, 200, { pending: getPendingPairs() })

          case 'POST /pairs/approve': {
            const body = await readBody(req)
            const { code } = JSON.parse(body)
            const result = await approvePairingCode(code)
            if (result) {
              return jsonResponse(res, 200, { paired: result })
            }
            return jsonResponse(res, 404, { error: 'Invalid or expired code' })
          }

          case 'POST /sessions/clear': {
            const body = await readBody(req)
            const { channelKey } = JSON.parse(body)
            await clearSession(channelKey)
            return jsonResponse(res, 200, { cleared: channelKey })
          }

          case 'POST /cron/create': {
            const body = await readBody(req)
            const { cron, prompt, recurring, notifyChannel } = JSON.parse(body)
            const task = await createCronTask({ cron, prompt, recurring, notifyChannel })
            return jsonResponse(res, 200, { created: task })
          }

          case 'GET /cron/list':
            return jsonResponse(res, 200, { tasks: listCronTasks() })

          case 'POST /cron/delete': {
            const body = await readBody(req)
            const { id } = JSON.parse(body)
            const removed = await deleteCronTask(id)
            return jsonResponse(res, removed ? 200 : 404, removed ? { deleted: id } : { error: 'Not found' })
          }

          case 'POST /memory/write': {
            const body = await readBody(req)
            const { file, content } = JSON.parse(body)
            await writeMemoryFile(file, content)
            return jsonResponse(res, 200, { written: file })
          }

          case 'POST /memory/diary': {
            const body = await readBody(req)
            const { content } = JSON.parse(body)
            await appendToDiary(content)
            return jsonResponse(res, 200, { appended: true })
          }

          case 'GET /memory/search': {
            const q = url.searchParams.get('q') ?? ''
            const results = await searchMemory(q)
            return jsonResponse(res, 200, { results })
          }

          case 'GET /memory/read': {
            const file = url.searchParams.get('file') ?? 'MEMORY.md'
            const content = await readMemoryFile(file)
            return jsonResponse(res, 200, { file, content })
          }

          case 'GET /memory/list':
            return jsonResponse(res, 200, { files: await listMemoryFiles() })

          default:
            return jsonResponse(res, 404, { error: 'Not found' })
        }
      } catch (err) {
        return jsonResponse(res, 500, { error: err.message })
      }
    })

    await new Promise((resolve, reject) => {
      this.httpServer.listen(port, host, () => {
        this.log(`HTTP control API on http://${host}:${port}`)
        resolve()
      })
      this.httpServer.on('error', reject)
    })
  }
}

// --- Utilities ---


function jsonResponse(res, status, data) {
  res.writeHead(status, { 'content-type': 'application/json' })
  res.end(JSON.stringify(data))
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = []
    req.on('data', c => chunks.push(c))
    req.on('end', () => resolve(Buffer.concat(chunks).toString()))
    req.on('error', reject)
  })
}

function makeLogger(prefix) {
  return msg => {
    const ts = new Date().toISOString()
    // biome-ignore lint/suspicious/noConsole: gateway logs
    console.log(`[${ts}] [${prefix}] ${msg}`)
  }
}

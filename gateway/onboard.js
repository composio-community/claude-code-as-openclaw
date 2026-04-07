import fs from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import readline from 'node:readline'
import { loadConfig, paths } from './config.js'
import { readMemoryFile, writeMemoryFile, ensureMemoryDir, listMemoryFiles } from './memory.js'

const MEMORY_DIR = path.join(os.homedir(), '.claude', 'gateway', 'memory')

/**
 * Interactive setup menu — `openclaudeclaw onboard`
 *
 * Menu-driven: pick a section, change what you want, go back.
 * Can also jump directly: `openclaudeclaw onboard telegram` or `openclaudeclaw onboard models`
 */

const PROVIDERS = {
  openai: {
    name: 'OpenAI',
    baseUrl: 'https://api.openai.com/v1',
    envKey: 'OPENAI_API_KEY',
    models: [
      { id: 'gpt-5.4', name: 'GPT-5.4 (flagship)' },
      { id: 'gpt-5.4-mini', name: 'GPT-5.4 Mini' },
      { id: 'gpt-5.4-nano', name: 'GPT-5.4 Nano' },
      { id: 'o3-mini', name: 'o3 Mini (reasoning)' },
    ],
  },
  deepseek: {
    name: 'DeepSeek',
    baseUrl: 'https://api.deepseek.com/v1',
    envKey: 'DEEPSEEK_API_KEY',
    models: [
      { id: 'deepseek-chat', name: 'DeepSeek V4' },
      { id: 'deepseek-reasoner', name: 'DeepSeek R1' },
    ],
  },
  qwen: {
    name: 'Qwen (Alibaba)',
    baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
    envKey: 'QWEN_API_KEY',
    models: [
      { id: 'qwen3.6-plus', name: 'Qwen 3.6 Plus' },
      { id: 'qwen3.5-coder', name: 'Qwen 3.5 Coder' },
      { id: 'qwen-flash', name: 'Qwen Flash' },
    ],
  },
  ollama: {
    name: 'Ollama (local)',
    baseUrl: 'http://localhost:11434/v1',
    envKey: null,
    apiKey: 'ollama',
    models: [
      { id: 'qwen2.5-coder:14b', name: 'Qwen 2.5 Coder 14B' },
      { id: 'llama3.3:70b', name: 'Llama 3.3 70B' },
      { id: 'deepseek-r1:14b', name: 'DeepSeek R1 14B' },
    ],
  },
  groq: {
    name: 'Groq',
    baseUrl: 'https://api.groq.com/openai/v1',
    envKey: 'GROQ_API_KEY',
    models: [
      { id: 'llama-3.3-70b-versatile', name: 'Llama 3.3 70B' },
      { id: 'mixtral-8x7b-32768', name: 'Mixtral 8x7B' },
    ],
  },
  openrouter: {
    name: 'OpenRouter',
    baseUrl: 'https://openrouter.ai/api/v1',
    envKey: 'OPENROUTER_API_KEY',
    models: [
      { id: 'anthropic/claude-sonnet-4-6', name: 'Claude Sonnet 4.6' },
      { id: 'openai/gpt-5.4', name: 'GPT-5.4' },
      { id: 'deepseek/deepseek-chat', name: 'DeepSeek V4' },
      { id: 'qwen/qwen3.6-plus', name: 'Qwen 3.6 Plus' },
    ],
  },
}

let rl = null
function ask(q) {
  return new Promise(resolve => rl.question(q, resolve))
}

async function save(config) {
  await fs.writeFile(paths.config, JSON.stringify(config, null, 2))
  console.log('  Saved.\n')
}

function status(enabled, detail) {
  return enabled ? `\x1b[32m● ${detail}\x1b[0m` : '\x1b[90m○ off\x1b[0m'
}

async function triggerComposioAuth(mcpUrl) {
  const { authenticateMCP } = await import('./mcpAuth.js')
  await authenticateMCP('composio', mcpUrl)
}

export async function runOnboard(jumpTo = null) {
  rl = readline.createInterface({ input: process.stdin, output: process.stdout })
  const config = await loadConfig()

  // Direct jump: `openclaudeclaw onboard telegram`
  if (jumpTo) {
    const handlers = {
      telegram: () => setupTelegram(config),
      whatsapp: () => setupWhatsApp(config),
      discord: () => setupDiscord(config),
      slack: () => setupSlack(config),
      models: () => setupModels(config),
      composio: () => setupComposio(config),
      voice: () => setupVoice(config),
      memory: () => setupMemory(),
      port: () => setupPort(config),
    }
    const handler = handlers[jumpTo]
    if (handler) {
      await handler()
      await save(config)
    } else {
      console.log(`  Unknown section: ${jumpTo}`)
      console.log(`  Available: ${Object.keys(handlers).join(', ')}`)
    }
    rl.close()
    return
  }

  // Main menu loop
  while (true) {
    console.log('')
    console.log('  OpenClaudeClaw Gateway Setup')
    console.log('  ─────────────────────')
    console.log('')

    const tg = config.channels?.telegram
    const wa = config.channels?.whatsapp
    const dc = config.channels?.discord
    const sl = config.channels?.slack
    const provCount = Object.keys(config.models?.providers ?? {}).length
    const comp = config.composio

    console.log(`  1. Telegram     ${status(tg?.enabled, tg?.botToken ? '@bot connected' : 'enabled')}`)
    console.log(`  2. WhatsApp     ${status(wa?.enabled, 'QR pairing')}`)
    console.log(`  3. Discord      ${status(dc?.enabled, dc?.botToken ? 'bot connected' : 'enabled')}`)
    console.log(`  4. Slack        ${status(sl?.enabled, sl?.botToken ? 'connected' : 'enabled')}`)
    console.log(`  5. Models       ${provCount} provider(s) configured`)
    console.log(`  6. Composio     ${status(comp?.enabled, '1000+ tools')}`)
    console.log(`  7. Voice        ${status(config.voice?.enabled !== false, config.voice?.replyWithVoice ? 'voice replies on' : 'text replies')}`)
    console.log(`  8. Memory       ${await getMemoryStatus()}`)
    console.log(`  9. Port         ${config.gateway?.port ?? 18789}`)
    console.log(`  q. Done`)
    console.log('')

    const choice = (await ask('  > ')).trim().toLowerCase()

    switch (choice) {
      case '1': case 'telegram':  await setupTelegram(config); break
      case '2': case 'whatsapp':  await setupWhatsApp(config); break
      case '3': case 'discord':   await setupDiscord(config); break
      case '4': case 'slack':     await setupSlack(config); break
      case '5': case 'models':    await setupModels(config); break
      case '6': case 'composio':  await setupComposio(config); break
      case '7': case 'voice':     await setupVoice(config); break
      case '8': case 'memory':    await setupMemory(); break
      case '9': case 'port':      await setupPort(config); break
      case 'q': case 'quit': case 'done': case '': {
        const soul = await readMemoryFile('SOUL.md')
        if (!soul) {
          console.log('  SOUL.md is required. Set it in Memory (option 8) before exiting.')
          break
        }
        await save(config)
        rl.close()
        return
      }
      default:
        console.log('  Invalid choice.')
    }
  }
}

// --- Section handlers ---

async function setupTelegram(config) {
  console.log('\n  Telegram Setup')
  config.channels = config.channels ?? {}
  const current = config.channels.telegram

  if (current?.enabled) {
    console.log(`  Currently: enabled (token: ...${current.botToken?.slice(-6) ?? '?'})`)
    const action = (await ask('  [k]eep / [c]hange token / [d]isable? ')).trim().toLowerCase()
    if (action === 'd') {
      config.channels.telegram = { enabled: false }
      console.log('  Disabled.')
    } else if (action === 'c') {
      const token = (await ask('  New bot token: ')).trim()
      config.channels.telegram = { enabled: true, botToken: token, dmPolicy: 'pairing' }
    }
  } else {
    const token = (await ask('  Bot token from @BotFather (or enter to skip): ')).trim()
    if (token) {
      config.channels.telegram = { enabled: true, botToken: token, dmPolicy: 'pairing' }
      console.log('  Enabled.')
    }
  }
  await save(config)
}

async function setupWhatsApp(config) {
  console.log('\n  WhatsApp Setup')
  config.channels = config.channels ?? {}
  const current = config.channels.whatsapp

  if (current?.enabled) {
    const action = (await ask('  Currently enabled. [k]eep / [d]isable? ')).trim().toLowerCase()
    if (action === 'd') {
      config.channels.whatsapp = { enabled: false }
      console.log('  Disabled.')
    }
  } else {
    const enable = (await ask('  Enable WhatsApp? (y/n) ')).trim().toLowerCase() === 'y'
    if (enable) {
      console.log('  Installing @whiskeysockets/baileys...')
      const { spawnSync } = await import('node:child_process')
      const install = spawnSync('npm', ['install', '@whiskeysockets/baileys', '--no-save'], {
        stdio: 'inherit',
        cwd: process.cwd(),
      })
      if (install.status !== 0) {
        console.log('  Failed to install baileys. Run manually: npm install @whiskeysockets/baileys')
        return
      }
      config.channels.whatsapp = { enabled: true, dmPolicy: 'pairing' }
      console.log('')
      console.log('  Enabled. To complete setup:')
      console.log('  1. Run the gateway in foreground: openclaudeclaw gateway start')
      console.log('  2. Scan the QR code with WhatsApp (Settings > Linked Devices)')
      console.log('  3. Once linked, Ctrl+C and switch to daemon mode')
      console.log('  You only need to scan once — auth persists across restarts.')
    }
  }
  await save(config)
}

async function setupDiscord(config) {
  console.log('\n  Discord Setup')
  config.channels = config.channels ?? {}
  const current = config.channels.discord

  if (current?.enabled) {
    console.log(`  Currently: enabled`)
    const action = (await ask('  [k]eep / [c]hange token / [d]isable? ')).trim().toLowerCase()
    if (action === 'd') {
      config.channels.discord = { enabled: false }
    } else if (action === 'c') {
      const token = (await ask('  New bot token: ')).trim()
      config.channels.discord = { enabled: true, botToken: token, dmPolicy: 'pairing' }
    }
  } else {
    const token = (await ask('  Bot token from Discord Developer Portal (or enter to skip): ')).trim()
    if (token) {
      config.channels.discord = { enabled: true, botToken: token, dmPolicy: 'pairing' }
      console.log('  Enabled.')
    }
  }
  await save(config)
}

async function setupSlack(config) {
  console.log('\n  Slack Setup (Socket Mode)')
  config.channels = config.channels ?? {}
  const current = config.channels.slack

  if (current?.enabled) {
    const action = (await ask('  Currently enabled. [k]eep / [c]hange / [d]isable? ')).trim().toLowerCase()
    if (action === 'd') {
      config.channels.slack = { enabled: false }
    } else if (action === 'c') {
      const botToken = (await ask('  Bot token (xoxb-...): ')).trim()
      const appToken = (await ask('  App token (xapp-...): ')).trim()
      config.channels.slack = { enabled: true, botToken, appToken, dmPolicy: 'pairing' }
    }
  } else {
    const botToken = (await ask('  Bot token xoxb-... (or enter to skip): ')).trim()
    if (botToken) {
      const appToken = (await ask('  App token xapp-...: ')).trim()
      config.channels.slack = { enabled: true, botToken, appToken, dmPolicy: 'pairing' }
      console.log('  Enabled.')
    }
  }
  await save(config)
}

async function setupModels(config) {
  config.models = config.models ?? {}
  config.models.providers = config.models.providers ?? { anthropic: { models: [{ id: 'opus' }, { id: 'sonnet' }, { id: 'haiku' }] } }

  while (true) {
    console.log('\n  Model Providers')
    console.log('  ───────────────')
    const configured = Object.keys(config.models.providers)
    for (const name of configured) {
      const prov = config.models.providers[name]
      const modelNames = (prov.models ?? []).map(m => m.id).join(', ')
      console.log(`  \x1b[32m●\x1b[0m ${name}: ${modelNames}`)
    }

    const available = Object.keys(PROVIDERS).filter(k => !configured.includes(k))
    if (available.length > 0) {
      console.log(`  Available to add: ${available.join(', ')}`)
    }
    console.log('')

    const action = (await ask('  [a]dd provider / [r]emove provider / [b]ack? ')).trim().toLowerCase()

    if (action === 'b' || action === '') break

    if (action === 'a') {
      const name = (await ask(`  Provider name (${available.join(', ')}): `)).trim().toLowerCase()
      const template = PROVIDERS[name]
      if (!template) { console.log('  Unknown provider.'); continue }

      let apiKey = template.apiKey ?? null
      if (template.envKey) {
        const existing = process.env[template.envKey]
        if (existing) {
          console.log(`  Found ${template.envKey} in environment.`)
          apiKey = existing
        } else {
          apiKey = (await ask(`  API key (or set ${template.envKey} env var later): `)).trim() || null
        }
      }

      config.models.providers[name] = {
        baseUrl: template.baseUrl,
        ...(apiKey ? { apiKey } : {}),
        models: template.models,
      }
      console.log(`  Added ${template.name} with ${template.models.length} models.`)
    }

    if (action === 'r') {
      const name = (await ask('  Remove which provider? ')).trim().toLowerCase()
      if (name === 'anthropic') { console.log('  Cannot remove Anthropic (built-in).'); continue }
      if (config.models.providers[name]) {
        delete config.models.providers[name]
        console.log(`  Removed ${name}.`)
      } else {
        console.log('  Not found.')
      }
    }
  }
  await save(config)
}

async function setupComposio(config) {
  console.log('\n  Composio MCP (1000+ external tools)')
  const current = config.composio

  if (current?.enabled) {
    const action = (await ask('  Currently enabled. [k]eep / [d]isable? ')).trim().toLowerCase()
    if (action === 'd') {
      config.composio = { enabled: false }
      console.log('  Disabled.')
    }
  } else {
    const enable = (await ask('  Enable Composio? GitHub, Gmail, Slack, Notion, and 1000+ more. (y/n) ')).trim().toLowerCase() === 'y'
    if (enable) {
      config.composio = { enabled: true, mcpUrl: 'https://connect.composio.dev/mcp' }
      console.log('  Authenticating with Composio... (browser will open)')
      await triggerComposioAuth(config.composio.mcpUrl)
    }
  }
  await save(config)
}

async function setupVoice(config) {
  console.log('\n  Voice Settings')
  config.voice = config.voice ?? { enabled: true, replyWithVoice: false }

  console.log(`  Voice input (STT): always enabled when whisper is installed`)
  const voiceReply = (await ask(`  Reply with voice (TTS)? Currently: ${config.voice.replyWithVoice ? 'on' : 'off'}. (y/n) `)).trim().toLowerCase()
  if (voiceReply === 'y') config.voice.replyWithVoice = true
  if (voiceReply === 'n') config.voice.replyWithVoice = false
  await save(config)
}

async function setupMemory() {
  await ensureMemoryDir()

  while (true) {
    console.log('\n  Memory')
    console.log('  ──────')

    const soul = await readMemoryFile('SOUL.md')
    const mem = await readMemoryFile('MEMORY.md')
    const files = await listMemoryFiles()

    console.log(`  SOUL.md:    ${soul ? `${soul.split('\n').length} lines` : 'not set'}`)
    console.log(`  MEMORY.md:  ${mem ? `${mem.split('\n').length} lines` : 'empty'}`)
    console.log(`  Diary files: ${files.filter(f => /^\d{4}-/.test(f.file)).length}`)
    console.log(`  Location:   ${MEMORY_DIR}`)
    console.log('')
    console.log('  1. Edit SOUL.md (who is the agent)')
    console.log('  2. Edit MEMORY.md (long-term facts)')
    console.log('  3. View files')
    console.log('  b. Back')
    console.log('')

    const choice = (await ask('  > ')).trim().toLowerCase()

    if (choice === 'b' || choice === '') break

    if (choice === '1') {
      console.log('\n  SOUL.md defines your agent\'s identity and personality.')
      console.log('  Example: "You are a senior engineer assistant. Be concise. Use code examples."')
      if (soul) {
        console.log(`\n  Current SOUL.md:\n  ${soul.split('\n').join('\n  ')}`)
      }
      console.log('')
      const content = (await ask('  New content (or enter to keep): ')).trim()
      if (content) {
        await writeMemoryFile('SOUL.md', content)
        console.log('  Saved.')
      }
    }

    if (choice === '2') {
      console.log('\n  MEMORY.md stores long-term facts the agent should always know.')
      console.log('  Example: "User\'s name is Prathit. Prefers TypeScript. Project uses Next.js."')
      if (mem) {
        console.log(`\n  Current MEMORY.md:\n  ${mem.split('\n').join('\n  ')}`)
      }
      console.log('')
      const content = (await ask('  New content (or enter to keep): ')).trim()
      if (content) {
        await writeMemoryFile('MEMORY.md', content)
        console.log('  Saved.')
      }
    }

    if (choice === '3') {
      console.log('')
      for (const f of files) {
        console.log(`  ${f.file}  (${f.size} bytes, ${f.modified})`)
      }
      if (files.length === 0) console.log('  No memory files yet.')
    }
  }
}

async function getMemoryStatus() {
  try {
    const files = await listMemoryFiles()
    if (files.length === 0) return '\x1b[90m○ empty\x1b[0m'
    const hasSoul = files.some(f => f.file === 'SOUL.md')
    const hasMem = files.some(f => f.file === 'MEMORY.md')
    const diaryCount = files.filter(f => /^\d{4}-/.test(f.file)).length
    const parts = []
    if (hasSoul) parts.push('soul')
    if (hasMem) parts.push('memory')
    if (diaryCount) parts.push(`${diaryCount} diary`)
    return `\x1b[32m● ${parts.join(', ')}\x1b[0m`
  } catch {
    return '\x1b[90m○ empty\x1b[0m'
  }
}

async function setupPort(config) {
  console.log(`\n  Current port: ${config.gateway?.port ?? 18789}`)
  const port = (await ask('  New port (or enter to keep): ')).trim()
  if (port) {
    config.gateway = config.gateway ?? {}
    config.gateway.port = parseInt(port) || 18789
    await save(config)
  }
}

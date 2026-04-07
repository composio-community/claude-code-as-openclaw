import fs from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'

const CLAUDE_DIR = path.join(os.homedir(), '.claude')
const GATEWAY_DIR = path.join(CLAUDE_DIR, 'gateway')
const CONFIG_PATH = path.join(CLAUDE_DIR, 'gateway.json')
const SESSIONS_DIR = path.join(GATEWAY_DIR, 'sessions')
const PAIRS_PATH = path.join(GATEWAY_DIR, 'paired-users.json')

export const paths = {
  root: GATEWAY_DIR,
  config: CONFIG_PATH,
  sessions: SESSIONS_DIR,
  pairs: PAIRS_PATH,
}

const DEFAULT_CONFIG = {
  gateway: {
    port: 18789,
    host: '127.0.0.1',
  },
  agent: {
    model: null,           // uses whatever claude CLI defaults to
    fallbackModel: null,   // auto-fallback when primary is overloaded
    maxTurns: 12,
    maxSubagentDepth: 1,
    approvalMode: 'auto',
    workspaceRoot: process.cwd(),
  },
  models: {
    providers: {
      anthropic: {
        models: [
          { id: 'opus', name: 'Claude Opus 4.6' },
          { id: 'sonnet', name: 'Claude Sonnet 4.6' },
          { id: 'haiku', name: 'Claude Haiku 4.5' },
        ],
      },
    },
  },
  channels: {
    telegram: {
      enabled: false,
      botToken: null,
      dmPolicy: 'pairing', // 'pairing' | 'allowlist' | 'open'
      allowFrom: [],        // telegram user IDs for allowlist mode
      pollingTimeout: 30,   // long-poll timeout seconds
    },
    discord: {
      enabled: false,
      botToken: null,
      dmPolicy: 'pairing',
    },
    slack: {
      enabled: false,
      botToken: null,       // xoxb-...
      appToken: null,       // xapp-... (for Socket Mode)
      dmPolicy: 'pairing',
    },
    whatsapp: {
      enabled: false,
      dmPolicy: 'pairing',
    },
  },
  voice: {
    enabled: true,
    replyWithVoice: false,  // set true to send TTS voice replies
  },
  composio: {
    enabled: false,
    mcpUrl: 'https://connect.composio.dev/mcp',
  },
}

let _cached = null
let _watcher = null

export async function ensureDirs() {
  await fs.mkdir(GATEWAY_DIR, { recursive: true })
  await fs.mkdir(SESSIONS_DIR, { recursive: true })
}

export async function loadConfig() {
  if (_cached) return _cached

  await ensureDirs()

  let raw
  try {
    raw = await fs.readFile(CONFIG_PATH, 'utf8')
  } catch (err) {
    if (err.code === 'ENOENT') {
      // Write default config on first run
      await fs.writeFile(CONFIG_PATH, JSON.stringify(DEFAULT_CONFIG, null, 2))
      _cached = structuredClone(DEFAULT_CONFIG)
      return _cached
    }
    throw err
  }

  _cached = deepMerge(structuredClone(DEFAULT_CONFIG), JSON.parse(raw))
  return _cached
}

export function getConfig() {
  if (!_cached) throw new Error('Config not loaded. Call loadConfig() first.')
  return _cached
}

export function watchConfig(onChange) {
  if (_watcher) return
  const ac = new AbortController()
  _watcher = ac

  ;(async () => {
    try {
      const watcher = fs.watch(CONFIG_PATH, { signal: ac.signal })
      for await (const event of watcher) {
        if (event.eventType === 'change') {
          _cached = null
          const fresh = await loadConfig()
          onChange(fresh)
        }
      }
    } catch (err) {
      if (err.name !== 'AbortError') throw err
    }
  })()

  return () => ac.abort()
}

function deepMerge(target, source) {
  for (const key of Object.keys(source)) {
    if (
      source[key] &&
      typeof source[key] === 'object' &&
      !Array.isArray(source[key]) &&
      target[key] &&
      typeof target[key] === 'object' &&
      !Array.isArray(target[key])
    ) {
      deepMerge(target[key], source[key])
    } else {
      target[key] = source[key]
    }
  }
  return target
}

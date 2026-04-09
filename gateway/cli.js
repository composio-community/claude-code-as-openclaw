#!/usr/bin/env node

/**
 * OpenClaudeClaw Gateway CLI
 *
 * Usage:
 *   openclaudeclaw gateway start             Start the gateway (foreground)
 *   openclaudeclaw gateway stop              Stop the running gateway
 *   openclaudeclaw gateway status            Show gateway status
 *   openclaudeclaw gateway install-daemon    Register as OS service (launchd/systemd)
 *   openclaudeclaw gateway uninstall-daemon  Remove OS service
 *   openclaudeclaw pair <code>               Approve a pairing code
 *   openclaudeclaw pairs                     List pending pairing codes
 *   openclaudeclaw sessions                  List active sessions
 */

import process from 'node:process'
import { loadConfig } from './config.js'

async function getGatewayUrl() {
  const config = await loadConfig()
  const host = config.gateway?.host ?? '127.0.0.1'
  const port = config.gateway?.port ?? 18789
  return `http://${host}:${port}`
}

async function main() {
  const args = process.argv.slice(2)
  const command = args[0]

  switch (command) {
    case 'onboard':
    case 'setup':
    case 'init':
      return handleOnboard(args[1])
    case 'gateway':
      return handleGateway(args.slice(1))
    case 'pair':
      return handlePair(args[1])
    case 'pairs':
      return handlePairs()
    case 'sessions':
      return handleSessions()
    default:
      printUsage()
  }
}

async function handleGateway(args) {
  const sub = args[0]

  switch (sub) {
    case 'start':
      return startGateway()
    case 'stop':
      return stopGateway()
    case 'status':
      return gatewayStatus()
    case 'install-daemon':
      return installDaemon()
    case 'uninstall-daemon':
      return uninstallDaemon()
    default:
      console.log('Usage: openclaudeclaw gateway <start|stop|status|install-daemon|uninstall-daemon>')
  }
}

async function handleOnboard(section) {
  const { runOnboard } = await import('./onboard.js')
  await runOnboard(section ?? null)
}

async function startGateway() {
  const { loadConfig } = await import('./config.js')
  const config = await loadConfig()

  const telegramEnabled = config.channels?.telegram?.enabled
  const telegramToken = config.channels?.telegram?.botToken

  if (!telegramEnabled || !telegramToken) {
    console.log('No channels enabled. Configure at least one channel in ~/.claude/gateway.json')
    console.log('')
    console.log('Example — enable Telegram:')
    console.log(JSON.stringify({
      channels: {
        telegram: {
          enabled: true,
          botToken: 'YOUR_BOT_TOKEN_FROM_BOTFATHER',
          dmPolicy: 'pairing',
        },
      },
    }, null, 2))
    console.log('')
    console.log('Then run: openclaudeclaw gateway start')
    process.exit(1)
  }

  console.log('Starting OpenClaudeClaw Gateway...')
  console.log(`  Port:       ${config.gateway.port}`)
  console.log(`  Model:      ${config.agent?.model ?? 'default'}`)
  console.log(`  Workspace:  ${config.agent?.workspaceRoot ?? process.cwd()}`)
  console.log(`  Telegram:   ${telegramEnabled ? 'enabled' : 'disabled'}`)
  console.log('')

  const { Gateway } = await import('./gateway.js')
  const gateway = new Gateway()

  // Graceful shutdown
  const shutdown = async (signal) => {
    console.log(`\nReceived ${signal}, shutting down...`)
    await gateway.stop()
    process.exit(0)
  }
  process.on('SIGINT', () => shutdown('SIGINT'))
  process.on('SIGTERM', () => shutdown('SIGTERM'))

  await gateway.start()
}

async function stopGateway() {
  try {
    const url = await getGatewayUrl()
    const res = await fetch(`${url}/health`)
    if (!res.ok) throw new Error('not running')

    // Send a stop signal via killing the process
    // In practice, the daemon manager (launchd/systemd) handles this
    console.log('Gateway is running. To stop it:')
    console.log('  If running in foreground: Ctrl+C')
    console.log('  If running as daemon:     openclaudeclaw gateway uninstall-daemon')
    console.log('  Or:                       launchctl unload ~/Library/LaunchAgents/com.openclaudeclaw.gateway.plist')
  } catch {
    console.log('Gateway is not running.')
  }
}

async function gatewayStatus() {
  try {
    const url = await getGatewayUrl()
    const res = await fetch(`${url}/health`)
    const data = await res.json()
    console.log('Gateway Status: RUNNING')
    console.log(`  Uptime:     ${formatUptime(data.uptime)}`)
    console.log(`  Channels:   ${data.channels.join(', ') || 'none'}`)
    console.log(`  Sessions:   ${data.sessions}`)
  } catch {
    console.log('Gateway Status: NOT RUNNING')
  }
}

async function installDaemon() {
  const { installDaemon: install } = await import('./daemon.js')
  const result = await install()
  console.log(result.message)
}

async function uninstallDaemon() {
  const { uninstallDaemon: uninstall } = await import('./daemon.js')
  const result = await uninstall()
  console.log(result.message)
}

async function handlePair(code) {
  if (!code) {
    console.log('Usage: openclaudeclaw pair <code>')
    return
  }

  try {
    const url = await getGatewayUrl()
    const res = await fetch(`${url}/pairs/approve`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ code: code.toUpperCase() }),
    })
    const data = await res.json()
    if (data.paired) {
      console.log(`Paired! ${data.paired.platform} user ${data.paired.userId} (${data.paired.username})`)
    } else {
      console.log(`Failed: ${data.error}`)
    }
  } catch {
    console.log('Error: Could not reach gateway. Is it running?')
  }
}

async function handlePairs() {
  try {
    const url = await getGatewayUrl()
    const res = await fetch(`${url}/pairs/pending`)
    const data = await res.json()
    if (data.pending.length === 0) {
      console.log('No pending pairing requests.')
      return
    }
    console.log('Pending pairing requests:')
    for (const p of data.pending) {
      console.log(`  ${p.code}  ${p.platform}:${p.userId} (${p.username})  expires in ${p.expiresIn}s`)
    }
    console.log('')
    console.log('Approve with: openclaudeclaw pair <code>')
  } catch {
    console.log('Error: Could not reach gateway. Is it running?')
  }
}

async function handleSessions() {
  try {
    const url = await getGatewayUrl()
    const res = await fetch(`${url}/sessions`)
    const data = await res.json()
    if (data.sessions.length === 0) {
      console.log('No active sessions.')
      return
    }
    console.log('Active sessions:')
    for (const s of data.sessions) {
      const user = s.metadata?.username ?? s.metadata?.firstName ?? 'unknown'
      console.log(`  ${s.id.slice(0, 8)}  ${s.channelKey}  @${user}  ${s.messageCount} msgs  last: ${s.lastActiveAt}`)
    }
  } catch {
    console.log('Error: Could not reach gateway. Is it running?')
  }
}

function printUsage() {
  console.log(`
OpenClaudeClaw — Claude Code Gateway

Quick start:
  openclaudeclaw onboard                   Interactive setup wizard

Commands:
  openclaudeclaw onboard                   Set up channels, models, Composio
  openclaudeclaw gateway start             Start the gateway (foreground)
  openclaudeclaw gateway stop              Stop the running gateway
  openclaudeclaw gateway status            Show gateway health
  openclaudeclaw gateway install-daemon    Register as OS service (always-on)
  openclaudeclaw gateway uninstall-daemon  Remove OS service
  openclaudeclaw pair <code>               Approve a pairing code
  openclaudeclaw pairs                     List pending pairing requests
  openclaudeclaw sessions                  List active sessions

Channels:
  Telegram, WhatsApp, Discord, Slack

Models:
  Anthropic (built-in), OpenAI, DeepSeek, Qwen, Ollama, Groq, OpenRouter

Integrations:
  Composio MCP — 100+ external tools (GitHub, Gmail, Slack, etc.)
`)
}

function formatUptime(seconds) {
  const h = Math.floor(seconds / 3600)
  const m = Math.floor((seconds % 3600) / 60)
  const s = Math.floor(seconds % 60)
  return `${h}h ${m}m ${s}s`
}

main().catch(err => {
  console.error(err.message)
  process.exit(1)
})

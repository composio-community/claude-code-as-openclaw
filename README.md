# Claude Code as OpenClaw

An open-source OpenClaw alternative powered by Claude Code. 

Use Claude Code as your AI agent across Telegram, WhatsApp, Discord, and Slack.

## Quick Start

### Prerequisites
- Node.js 22+
- [Bun](https://bun.sh) 1.1+

### 1. Clone, install, and register the command

```bash
git clone https://github.com/composio-community/openclaudeclaw.git
cd openclaudeclaw
npm install
npm link
```

`npm link` registers `openclaudeclaw` as a global command you can use from anywhere.

### 2. Build Claude Code from source

```bash
npm run build
```

First build takes a few minutes. Output: `dist/cli.js`. Verify and login:

```bash
node dist/cli.js --version
node dist/cli.js login
```

### 3. Setup

```bash
openclaudeclaw onboard
```

Pick your channels, models, integrations from a menu. Run again anytime to change one thing.

### 4. Start

```bash
# Foreground (for testing)
openclaudeclaw gateway start

# Or as a daemon (always-on, survives reboot)
openclaudeclaw gateway install-daemon
```

To restart the daemon after code changes:

```bash
launchctl unload ~/Library/LaunchAgents/com.openclaudeclaw.gateway.plist
launchctl load ~/Library/LaunchAgents/com.openclaudeclaw.gateway.plist
```

On Linux:

```bash
systemctl --user restart openclaudeclaw-gateway
```

### 5. Pair

Message your bot. Approve the pairing code:

```bash
openclaudeclaw pair <CODE>
```

### Using the installed Claude CLI instead

If you already have `claude` installed and don't want to build from source, skip step 2. The gateway uses the installed `claude` by default. To point at your own build, set `claudeBin` in `~/.claude/gateway.json`:

```json
{ "agent": { "claudeBin": "node /path/to/dist/cli.js" } }
```

## What It Does

```
Telegram / WhatsApp / Discord / Slack
              |
              v
     +------------------+
     |  OpenClaudeClaw Gateway |  Always-on Node.js daemon
     |                   |  Auth, sessions, cron, voice
     +--------+---------+
              |
              v  spawns per message
     claude -p "user message" --resume <session>
              |
              v
     Full Claude Code: all tools, MCP, memory
              |
              v
     Response sent back to chat
```

Each chat gets a persistent session. Claude remembers the conversation until you type `/new`.

## Features

### Messaging Channels
- **Telegram** — Bot API long-polling, voice messages, zero deps
- **WhatsApp** — via [Baileys](https://github.com/WhiskeySockets/Baileys), QR code pairing
- **Discord** — Gateway WebSocket, zero deps
- **Slack** — Socket Mode, zero deps

### Multi-Model
Switch models mid-conversation with `/model`:

| Provider | Models | Auth |
|----------|--------|------|
| **Anthropic** (built-in) | opus, sonnet, haiku | Claude CLI auth |
| **OpenAI** | gpt-5.4, gpt-5.4-mini, gpt-5.4-nano, o3-mini | API key |
| **DeepSeek** | deepseek-chat (V4), deepseek-reasoner (R1) | API key |
| **Qwen** | qwen3.6-plus, qwen3.5-coder, qwen-flash | API key |
| **Ollama** | Any local model | Local |
| **Groq** | llama-3.3-70b, mixtral-8x7b | API key |
| **OpenRouter** | Any model across providers | API key |

Anthropic models get full Claude Code tool use. Other providers use OpenAI-compatible chat completions API.

### Persistent Cron Jobs
Tell Claude naturally: *"remind me every morning at 9 to check PRs"*

Claude schedules it via the gateway's cron API. The daemon fires it on schedule and sends results back to your chat — even when no Claude session is open.

### Voice Messages
Send a voice message on Telegram:
1. Whisper transcribes it to text
2. Claude processes it
3. Optional: TTS voice reply sent back

Requires: `ffmpeg`, `whisper` (pip install openai-whisper)

### Composio MCP (1000+ External Tools)
Connect Claude to GitHub, Gmail, Slack, Notion, Jira, and 1000+ more via [Composio](https://composio.dev). OAuth handled automatically during setup.

### Pairing / Auth
Unknown senders get an 8-character pairing code. Approve via CLI:
```bash
node gateway/cli.js pair ABCD1234
```

Three DM policies: `pairing` (default), `allowlist`, `open`.

### Always-On Daemon
```bash
node gateway/cli.js gateway install-daemon
```
- **macOS**: launchd LaunchAgent — starts on login, restarts on crash
- **Linux**: systemd user service — same behavior

## Configuration

Config lives at `~/.claude/gateway.json`. Edit directly or use the setup menu:

```bash
# Full menu
node gateway/cli.js onboard

# Jump to a section
node gateway/cli.js onboard telegram
node gateway/cli.js onboard models
node gateway/cli.js onboard composio
```

Example config:

```json
{
  "gateway": { "port": 18789 },
  "channels": {
    "telegram": {
      "enabled": true,
      "botToken": "...",
      "dmPolicy": "pairing"
    },
    "whatsapp": { "enabled": true },
    "discord": { "enabled": true, "botToken": "..." },
    "slack": { "enabled": true, "botToken": "xoxb-...", "appToken": "xapp-..." }
  },
  "agent": {
    "model": "sonnet",
    "maxTurns": 12
  },
  "models": {
    "providers": {
      "anthropic": {
        "models": [
          { "id": "opus", "name": "Claude Opus 4.6" },
          { "id": "sonnet", "name": "Claude Sonnet 4.6" },
          { "id": "haiku", "name": "Claude Haiku 4.5" }
        ]
      },
      "openai": {
        "baseUrl": "https://api.openai.com/v1",
        "apiKey": "sk-...",
        "models": [{ "id": "gpt-5.4" }]
      }
    }
  },
  "composio": { "enabled": true },
  "voice": { "enabled": true, "replyWithVoice": false }
}
```

## Chat Commands

| Command | Description |
|---------|-------------|
| `/new` | Start a fresh conversation |
| `/status` | Show current session info |
| `/model <name>` | Switch model (e.g. `/model opus`) |
| `/model` | List available models and current |
| `/help` | Show all commands |

## CLI Commands

```bash
openclaudeclaw onboard [section]          # Setup wizard
openclaudeclaw gateway start              # Start foreground
openclaudeclaw gateway stop               # Stop info
openclaudeclaw gateway status             # Health check
openclaudeclaw gateway install-daemon     # Always-on
openclaudeclaw gateway uninstall-daemon
openclaudeclaw pair <code>                # Approve user
openclaudeclaw pairs                      # List pending
openclaudeclaw sessions                   # List sessions
```

## HTTP API

The gateway exposes a local control API (default `127.0.0.1:18789`):

```
GET  /health          — Gateway status
GET  /sessions        — List sessions
GET  /pairs/pending   — Pending pairing codes
POST /pairs/approve   — Approve a code
POST /sessions/clear  — Clear a session
POST /cron/create     — Create cron job
GET  /cron/list       — List cron jobs
POST /cron/delete     — Delete cron job
```

## Architecture

```
gateway/
  cli.js              CLI entrypoint
  gateway.js          Core: channels, sessions, agent spawning, HTTP API
  config.js           ~/.claude/gateway.json loader with hot-reload
  sessionManager.js   Chat ID -> session mapping with persistence
  auth.js             Pairing codes, allowlist, access control
  cron.js             Persistent cron scheduler
  voice.js            Whisper STT + macOS TTS pipeline
  mcpAuth.js          Standalone OAuth2 PKCE for MCP servers
  onboard.js          Interactive setup menu
  daemon.js           launchd/systemd service installer
  channels/
    telegram.js       Telegram Bot API (long-polling)
    whatsapp.js       WhatsApp via Baileys
    discord.js        Discord Gateway WebSocket
    slack.js          Slack Socket Mode
```

Zero npm dependencies for core gateway. WhatsApp requires `@whiskeysockets/baileys`. Voice requires `ffmpeg` + `whisper`.

## Inspired By

[OpenClaw](https://github.com/openclaw/openclaw) — the open-source AI agent with 247K GitHub stars. OpenClaw pioneered the always-on gateway + messaging platform architecture. OpenClaudeClaw brings that pattern to Claude Code with Anthropic's superior harness and tool use.

## License

Built on the open-sourced Claude Code by Anthropic.

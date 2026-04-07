import { EventEmitter } from 'node:events'

/**
 * Discord Bot channel using Gateway API (WebSocket).
 * Zero dependencies — uses native WebSocket + fetch.
 *
 * Events:
 *   'message' -> { chatId, userId, username, firstName, text, raw }
 *   'error'   -> Error
 */

const API_BASE = 'https://discord.com/api/v10'
const GATEWAY_URL = 'wss://gateway.discord.gg/?v=10&encoding=json'

export class DiscordChannel extends EventEmitter {
  constructor({ botToken }) {
    super()
    this.botToken = botToken
    this.running = false
    this.ws = null
    this.heartbeatTimer = null
    this.seq = null
    this.botUser = null
    this.resumeUrl = null
    this.sessionId = null
    this._seenMessages = new Set()
  }

  get platform() {
    return 'discord'
  }

  async start() {
    this.running = true
    await this._connect(GATEWAY_URL)
    return this.botUser
  }

  stop() {
    this.running = false
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer)
    if (this.ws) this.ws.close()
  }

  async sendMessage(chatId, text, options = {}) {
    // Discord max message length is 2000
    const chunks = splitMessage(text, 2000)
    for (const chunk of chunks) {
      const body = { content: chunk }
      // Reply to the original message
      if (options.replyTo) {
        body.message_reference = {
          message_id: options.replyTo,
          channel_id: chatId,
        }
        body.allowed_mentions = { replied_user: false }
      }
      await this._api('POST', `/channels/${chatId}/messages`, body)
    }
  }

  async sendTyping(chatId) {
    try {
      await this._api('POST', `/channels/${chatId}/typing`)
    } catch { /* non-critical */ }
  }

  async _connect(url, isReconnect = false) {
    return new Promise((resolve, reject) => {
      this.ws = new WebSocket(url)

      this.ws.onmessage = (event) => {
        const data = JSON.parse(event.data)
        this._handleGatewayMessage(data, isReconnect ? null : resolve)
      }

      this.ws.onerror = (err) => {
        this.emit('error', new Error(`Discord WS error: ${err.message ?? 'unknown'}`))
        if (!isReconnect) reject(err)
      }

      this.ws.onclose = (event) => {
        if (this.heartbeatTimer) clearInterval(this.heartbeatTimer)
        if (this.running) {
          setTimeout(() => this._connect(this.resumeUrl ?? GATEWAY_URL, true), 5000)
        }
      }
    })
  }

  _handleGatewayMessage(data, onReady) {
    const { op, t, s, d } = data

    if (s) this.seq = s

    // Hello — start heartbeat, then identify or resume
    if (op === 10) {
      this._startHeartbeat(d.heartbeat_interval)
      if (this.sessionId && this.seq) {
        // Resume existing session — no event replay
        this._resume()
      } else {
        this._identify()
      }
    }

    // Heartbeat ACK
    if (op === 11) return

    // Dispatch
    if (op === 0) {
      if (t === 'READY') {
        this.botUser = d.user
        this.sessionId = d.session_id
        this.resumeUrl = d.resume_gateway_url
        onReady?.(d.user)
      }

      if (t === 'MESSAGE_CREATE') {
        // Ignore bot's own messages and other bots
        if (d.author?.id === this.botUser?.id) return
        if (d.author?.bot) return
        if (!d.content) return
        // Dedupe — Discord can send the same message twice on reconnect
        if (this._seenMessages.has(d.id)) return
        this._seenMessages.add(d.id)
        if (this._seenMessages.size > 1000) {
          const arr = [...this._seenMessages]
          this._seenMessages = new Set(arr.slice(-500))
        }

        this.emit('message', {
          chatId: d.channel_id,
          messageId: d.id,
          userId: d.author.id,
          username: d.author.username,
          firstName: d.author.global_name ?? d.author.username,
          text: d.content,
          raw: d,
        })
      }
    }
  }

  _identify() {
    this.ws.send(JSON.stringify({
      op: 2,
      d: {
        token: this.botToken,
        intents: 1 << 9 | 1 << 12 | 1 << 15, // GUILD_MESSAGES | MESSAGE_CONTENT | DIRECT_MESSAGES
        properties: { os: 'linux', browser: 'openclaudeclaw', device: 'openclaudeclaw' },
      },
    }))
  }

  _resume() {
    this.ws.send(JSON.stringify({
      op: 6,
      d: {
        token: this.botToken,
        session_id: this.sessionId,
        seq: this.seq,
      },
    }))
  }

  _startHeartbeat(intervalMs) {
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer)
    this.heartbeatTimer = setInterval(() => {
      this.ws.send(JSON.stringify({ op: 1, d: this.seq }))
    }, intervalMs)
  }

  async _api(method, path, body) {
    const res = await fetch(`${API_BASE}${path}`, {
      method,
      headers: {
        Authorization: `Bot ${this.botToken}`,
        'Content-Type': 'application/json',
      },
      body: body ? JSON.stringify(body) : undefined,
    })
    if (!res.ok) {
      const text = await res.text()
      throw new Error(`Discord API ${method} ${path}: ${res.status} ${text.slice(0, 200)}`)
    }
    if (res.headers.get('content-type')?.includes('json')) {
      return res.json()
    }
  }
}

function splitMessage(text, maxLen) {
  if (text.length <= maxLen) return [text]
  const chunks = []
  let remaining = text
  while (remaining.length > 0) {
    if (remaining.length <= maxLen) { chunks.push(remaining); break }
    let splitAt = remaining.lastIndexOf('\n', maxLen)
    if (splitAt < maxLen * 0.3) splitAt = maxLen
    chunks.push(remaining.slice(0, splitAt))
    remaining = remaining.slice(splitAt)
  }
  return chunks
}

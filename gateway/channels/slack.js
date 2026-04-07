import { EventEmitter } from 'node:events'

/**
 * Slack Bot channel using Socket Mode (WebSocket) + Web API.
 * Zero dependencies — uses native WebSocket + fetch.
 *
 * Requires:
 *   - Bot token (xoxb-...)
 *   - App-level token (xapp-...) for Socket Mode
 *
 * Events:
 *   'message' -> { chatId, userId, username, firstName, text, raw }
 *   'error'   -> Error
 */

const API_BASE = 'https://slack.com/api'

export class SlackChannel extends EventEmitter {
  constructor({ botToken, appToken }) {
    super()
    this.botToken = botToken
    this.appToken = appToken
    this.running = false
    this.ws = null
    this.botUserId = null
  }

  get platform() {
    return 'slack'
  }

  async start() {
    // Get bot identity
    const auth = await this._api('auth.test')
    this.botUserId = auth.user_id

    // Open Socket Mode connection
    this.running = true
    await this._connect()

    return { userId: auth.user_id, teamId: auth.team_id, botName: auth.user }
  }

  stop() {
    this.running = false
    if (this.ws) this.ws.close()
  }

  async sendMessage(chatId, text) {
    await this._api('chat.postMessage', {
      channel: chatId,
      text,
    })
  }

  async sendTyping(chatId) {
    // Slack doesn't have a direct typing indicator API for bots
    // but we can use chat.meMessage or just skip it
  }

  async _connect() {
    // Get WebSocket URL via apps.connections.open
    const res = await fetch(`${API_BASE}/apps.connections.open`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${this.appToken}`,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
    })
    const data = await res.json()
    if (!data.ok) throw new Error(`Slack Socket Mode: ${data.error}`)

    return new Promise((resolve, reject) => {
      this.ws = new WebSocket(data.url)

      this.ws.onopen = () => resolve()

      this.ws.onmessage = (event) => {
        const msg = JSON.parse(event.data)
        this._handleSocketMessage(msg)
      }

      this.ws.onerror = (err) => {
        this.emit('error', new Error(`Slack WS error: ${err.message ?? 'unknown'}`))
        reject(err)
      }

      this.ws.onclose = () => {
        if (this.running) {
          setTimeout(() => this._connect(), 5000)
        }
      }
    })
  }

  _handleSocketMessage(msg) {
    // Acknowledge all envelope messages
    if (msg.envelope_id) {
      this.ws.send(JSON.stringify({ envelope_id: msg.envelope_id }))
    }

    if (msg.type === 'events_api') {
      const event = msg.payload?.event
      if (!event) return

      // Handle regular messages (not from bots, not subtypes like edits)
      if (event.type === 'message' && !event.subtype && event.user !== this.botUserId) {
        this.emit('message', {
          chatId: event.channel,
          userId: event.user,
          username: event.user, // Slack doesn't send username in events
          firstName: event.user,
          text: event.text,
          raw: event,
        })
      }
    }
  }

  async _api(method, params = {}) {
    const res = await fetch(`${API_BASE}/${method}`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${this.botToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(params),
    })
    const data = await res.json()
    if (!data.ok) {
      throw new Error(`Slack API ${method}: ${data.error}`)
    }
    return data
  }
}

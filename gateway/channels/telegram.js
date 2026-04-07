import { EventEmitter } from 'node:events'

/**
 * Telegram Bot API bridge using long-polling.
 * No dependencies — uses native fetch.
 *
 * Events:
 *   'message' -> { chatId, userId, username, firstName, text, raw }
 *   'error'   -> Error
 */

const API_BASE = 'https://api.telegram.org/bot'

export class TelegramChannel extends EventEmitter {
  constructor({ botToken, pollingTimeout = 30 }) {
    super()
    this.botToken = botToken
    this.pollingTimeout = pollingTimeout
    this.offset = 0
    this.running = false
    this.botInfo = null
    this._abortController = null
  }

  get platform() {
    return 'telegram'
  }

  async start() {
    // Verify token and get bot info
    this.botInfo = await this._call('getMe')
    this.running = true
    this._pollLoop()
    return this.botInfo
  }

  stop() {
    this.running = false
    this._abortController?.abort()
  }

  async sendMessage(chatId, text, options = {}) {
    // Telegram max message length is 4096
    const chunks = splitMessage(text, 4096)
    for (const chunk of chunks) {
      try {
        // Try Markdown first
        await this._call('sendMessage', {
          chat_id: chatId,
          text: chunk,
          parse_mode: 'Markdown',
          disable_web_page_preview: true,
        })
      } catch {
        // Markdown parse failed — send as plain text
        await this._call('sendMessage', {
          chat_id: chatId,
          text: chunk,
          disable_web_page_preview: true,
        })
      }
    }
  }

  async sendVoice(chatId, oggFilePath) {
    const fs = await import('node:fs')
    const formData = new FormData()
    formData.append('chat_id', String(chatId))
    const fileBuffer = fs.readFileSync(oggFilePath)
    formData.append('voice', new Blob([fileBuffer], { type: 'audio/ogg' }), 'voice.ogg')

    const url = `https://api.telegram.org/bot${this.botToken}/sendVoice`
    const response = await fetch(url, { method: 'POST', body: formData })
    const data = await response.json()
    if (!data.ok) {
      throw new Error(`Telegram sendVoice: ${data.description ?? 'unknown error'}`)
    }
  }

  async sendTyping(chatId) {
    try {
      await this._call('sendChatAction', {
        chat_id: chatId,
        action: 'typing',
      })
    } catch {
      // non-critical, ignore
    }
  }

  async _pollLoop() {
    while (this.running) {
      try {
        this._abortController = new AbortController()
        const updates = await this._call(
          'getUpdates',
          {
            offset: this.offset,
            timeout: this.pollingTimeout,
            allowed_updates: ['message'],
          },
          this._abortController.signal,
        )

        for (const update of updates) {
          this.offset = update.update_id + 1

          const msg = update.message
          if (msg?.text) {
            this.emit('message', {
              chatId: msg.chat.id,
              userId: msg.from.id,
              username: msg.from.username ?? null,
              firstName: msg.from.first_name ?? null,
              text: msg.text,
              raw: msg,
            })
          } else if (msg?.voice) {
            this.emit('voice', {
              chatId: msg.chat.id,
              userId: msg.from.id,
              username: msg.from.username ?? null,
              firstName: msg.from.first_name ?? null,
              fileId: msg.voice.file_id,
              duration: msg.voice.duration,
              raw: msg,
            })
          }
        }
      } catch (err) {
        if (err.name === 'AbortError') continue
        this.emit('error', err)
        // Back off on errors
        await sleep(3000)
      }
    }
  }

  async _call(method, params = {}, signal = undefined) {
    const url = `${API_BASE}${this.botToken}/${method}`
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(params),
      signal,
    })

    const data = await response.json()
    if (!data.ok) {
      throw new Error(`Telegram API ${method}: ${data.description ?? 'unknown error'} (${data.error_code})`)
    }
    return data.result
  }
}

function splitMessage(text, maxLen) {
  if (text.length <= maxLen) return [text]
  const chunks = []
  let remaining = text
  while (remaining.length > 0) {
    if (remaining.length <= maxLen) {
      chunks.push(remaining)
      break
    }
    // Try to split at newline
    let splitAt = remaining.lastIndexOf('\n', maxLen)
    if (splitAt < maxLen * 0.3) splitAt = maxLen
    chunks.push(remaining.slice(0, splitAt))
    remaining = remaining.slice(splitAt)
  }
  return chunks
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms))
}

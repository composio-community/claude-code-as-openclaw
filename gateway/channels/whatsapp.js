import { EventEmitter } from 'node:events'
import { spawn } from 'node:child_process'
import fs from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'

/**
 * WhatsApp channel via Baileys (WhiskeySockets/Baileys).
 *
 * Baileys is a Node.js library that connects to WhatsApp Web via WebSocket.
 * No official API needed — uses your personal WhatsApp number.
 *
 * Setup:
 *   npm install @whiskeysockets/baileys
 *
 * On first run, it prints a QR code to scan with your phone.
 * Auth state is persisted to ~/.claude/gateway/whatsapp-auth/
 *
 * Events:
 *   'message' -> { chatId, userId, username, firstName, text, raw }
 *   'error'   -> Error
 */

const AUTH_DIR = path.join(os.homedir(), '.claude', 'gateway', 'whatsapp-auth')

export class WhatsAppChannel extends EventEmitter {
  constructor({ allowedJids = [] }) {
    super()
    this.allowedJids = allowedJids
    this.running = false
    this.sock = null
    this.botInfo = null
  }

  get platform() {
    return 'whatsapp'
  }

  async start() {
    await fs.mkdir(AUTH_DIR, { recursive: true })

    let baileys
    try {
      baileys = await import('@whiskeysockets/baileys')
    } catch {
      throw new Error(
        'WhatsApp requires @whiskeysockets/baileys. Run:\n  npm install @whiskeysockets/baileys'
      )
    }

    const { default: makeWASocket, useMultiFileAuthState, DisconnectReason, fetchLatestBaileysVersion } = baileys

    const { state, saveCreds } = await useMultiFileAuthState(AUTH_DIR)
    const { version } = await fetchLatestBaileysVersion()

    this.sock = makeWASocket({
      version,
      auth: state,
      printQRInTerminal: true, // Shows QR code for first-time pairing
      generateHighQualityLinkPreview: false,
    })

    // Save credentials on update
    this.sock.ev.on('creds.update', saveCreds)

    // Handle connection updates
    this.sock.ev.on('connection.update', (update) => {
      const { connection, lastDisconnect, qr } = update

      if (qr) {
        // biome-ignore lint/suspicious/noConsole: QR needed for pairing
        console.log('\n[WhatsApp] Scan this QR code with your phone:\n')
      }

      if (connection === 'close') {
        const statusCode = lastDisconnect?.error?.output?.statusCode
        if (statusCode !== DisconnectReason.loggedOut && this.running) {
          // Reconnect
          setTimeout(() => this.start(), 5000)
        } else {
          this.emit('error', new Error('WhatsApp logged out'))
        }
      }

      if (connection === 'open') {
        this.running = true
        this.botInfo = { jid: this.sock.user?.id, name: this.sock.user?.name }
        this.emit('ready', this.botInfo)
      }
    })

    // Handle incoming messages
    this.sock.ev.on('messages.upsert', ({ messages }) => {
      for (const msg of messages) {
        if (!msg.message) continue
        if (msg.key.fromMe) continue

        const text =
          msg.message.conversation ||
          msg.message.extendedTextMessage?.text ||
          null

        if (!text) continue

        const jid = msg.key.remoteJid
        const pushName = msg.pushName ?? jid.split('@')[0]

        this.emit('message', {
          chatId: jid,
          userId: jid,
          username: pushName,
          firstName: pushName,
          text,
          raw: msg,
        })
      }
    })

    // Wait for connection
    return new Promise((resolve) => {
      this.once('ready', resolve)
    })
  }

  stop() {
    this.running = false
    if (this.sock) {
      this.sock.end()
      this.sock = null
    }
  }

  async sendMessage(chatId, text) {
    if (!this.sock) throw new Error('WhatsApp not connected')
    await this.sock.sendMessage(chatId, { text })
  }

  async sendTyping(chatId) {
    try {
      if (this.sock) {
        await this.sock.sendPresenceUpdate('composing', chatId)
      }
    } catch { /* non-critical */ }
  }
}

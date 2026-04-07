import fs from 'node:fs/promises'
import { randomBytes } from 'node:crypto'
import { paths, getConfig } from './config.js'

/**
 * Pairing/auth flow for unknown senders.
 *
 * Policies:
 *   - "open":      anyone can message the agent
 *   - "allowlist":  only user IDs in config.channels.<ch>.allowFrom
 *   - "pairing":    unknown senders get a pairing code; operator approves via CLI
 */

// Ambiguous characters removed (0O1I)
const CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'
const CODE_LENGTH = 8
const CODE_EXPIRY_MS = 60 * 60 * 1000 // 1 hour

// In-memory pending codes: code -> { platform, userId, username, expiresAt }
const pendingPairs = new Map()

// Paired users loaded from disk: Set of "platform:userId"
let pairedUsers = new Set()

export async function loadPairedUsers() {
  try {
    const raw = await fs.readFile(paths.pairs, 'utf8')
    const arr = JSON.parse(raw)
    pairedUsers = new Set(arr)
  } catch (err) {
    if (err.code !== 'ENOENT') throw err
    pairedUsers = new Set()
  }
}

async function savePairedUsers() {
  await fs.writeFile(paths.pairs, JSON.stringify([...pairedUsers], null, 2))
}

export function isPaired(platform, userId) {
  return pairedUsers.has(`${platform}:${userId}`)
}

/**
 * Check if a sender is authorized to use the agent.
 * Returns { allowed: boolean, pairingCode?: string, message?: string }
 */
export function checkAccess(platform, userId, username) {
  const config = getConfig()
  const channelConfig = config.channels?.[platform]
  const policy = channelConfig?.dmPolicy ?? 'pairing'

  if (policy === 'open') {
    return { allowed: true }
  }

  if (policy === 'allowlist') {
    const allowFrom = channelConfig?.allowFrom ?? []
    const allowed = allowFrom.includes(String(userId)) || allowFrom.includes(username)
    if (allowed) return { allowed: true }
    return {
      allowed: false,
      message: 'You are not on the allowlist for this agent.',
    }
  }

  // pairing mode (default)
  if (isPaired(platform, userId)) {
    return { allowed: true }
  }

  // Generate or return existing pairing code
  const existingCode = findPendingCode(platform, userId)
  if (existingCode) {
    return {
      allowed: false,
      pairingCode: existingCode,
      message: `Pairing required. Your code: ${existingCode}\nAsk the operator to run: openclaudeclaw pair ${existingCode}`,
    }
  }

  const code = generatePairingCode()
  pendingPairs.set(code, {
    platform,
    userId: String(userId),
    username,
    expiresAt: Date.now() + CODE_EXPIRY_MS,
  })

  return {
    allowed: false,
    pairingCode: code,
    message: `Pairing required. Your code: ${code}\nAsk the operator to run: openclaudeclaw pair ${code}`,
  }
}

/**
 * Approve a pairing code (called by operator via CLI).
 * Returns the paired user info or null if code invalid/expired.
 */
export async function approvePairingCode(code) {
  const upperCode = code.toUpperCase()
  const entry = pendingPairs.get(upperCode)

  if (!entry) return null
  if (Date.now() > entry.expiresAt) {
    pendingPairs.delete(upperCode)
    return null
  }

  const key = `${entry.platform}:${entry.userId}`
  pairedUsers.add(key)
  pendingPairs.delete(upperCode)
  await savePairedUsers()

  return { platform: entry.platform, userId: entry.userId, username: entry.username }
}

export function getPendingPairs() {
  // Clean expired
  for (const [code, entry] of pendingPairs) {
    if (Date.now() > entry.expiresAt) pendingPairs.delete(code)
  }
  return [...pendingPairs.entries()].map(([code, entry]) => ({
    code,
    ...entry,
    expiresIn: Math.max(0, Math.round((entry.expiresAt - Date.now()) / 1000)),
  }))
}

function findPendingCode(platform, userId) {
  for (const [code, entry] of pendingPairs) {
    if (entry.platform === platform && entry.userId === String(userId)) {
      if (Date.now() > entry.expiresAt) {
        pendingPairs.delete(code)
        return null
      }
      return code
    }
  }
  return null
}

function generatePairingCode() {
  const bytes = randomBytes(CODE_LENGTH)
  let code = ''
  for (let i = 0; i < CODE_LENGTH; i++) {
    code += CODE_CHARS[bytes[i] % CODE_CHARS.length]
  }
  return code
}

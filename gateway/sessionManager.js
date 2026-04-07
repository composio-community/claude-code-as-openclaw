import fs from 'node:fs/promises'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { paths, getConfig } from './config.js'

/**
 * Maps channel chat IDs to agent sessions.
 * Each session gets its own transcript and message history,
 * persisted under ~/.openclaudeclaw/sessions/<sessionId>.json
 */

const sessions = new Map() // channelKey -> Session

export function getSession(channelKey) {
  return sessions.get(channelKey) ?? null
}

export function getAllSessions() {
  return [...sessions.values()]
}

export async function getOrCreateSession(channelKey, metadata = {}) {
  let session = sessions.get(channelKey)
  if (session) return session

  session = {
    id: randomUUID(),
    channelKey,        // e.g. "telegram:12345"
    metadata,          // { platform, userId, username, ... }
    messages: [],
    createdAt: new Date().toISOString(),
    lastActiveAt: new Date().toISOString(),
  }

  sessions.set(channelKey, session)
  await persistSession(session)
  return session
}

export async function appendMessage(channelKey, message) {
  const session = sessions.get(channelKey)
  if (!session) throw new Error(`No session for ${channelKey}`)

  session.messages.push(message)
  session.lastActiveAt = new Date().toISOString()
  await persistSession(session)
}

export async function getMessages(channelKey) {
  const session = sessions.get(channelKey)
  if (!session) return []
  return session.messages
}

export async function clearSession(channelKey) {
  const session = sessions.get(channelKey)
  if (!session) return

  sessions.delete(channelKey)
  const filePath = sessionFilePath(session.id)
  try {
    await fs.unlink(filePath)
  } catch (err) {
    if (err.code !== 'ENOENT') throw err
  }
}

export async function loadPersistedSessions() {
  let entries
  try {
    entries = await fs.readdir(paths.sessions)
  } catch (err) {
    if (err.code === 'ENOENT') return
    throw err
  }

  for (const entry of entries) {
    if (!entry.endsWith('.json')) continue
    try {
      const raw = await fs.readFile(path.join(paths.sessions, entry), 'utf8')
      const session = JSON.parse(raw)
      if (session.channelKey) {
        sessions.set(session.channelKey, session)
      }
    } catch {
      // skip corrupt session files
    }
  }
}

async function persistSession(session) {
  const filePath = sessionFilePath(session.id)
  const data = JSON.stringify(session, null, 2)
  await fs.writeFile(filePath, data)
}

function sessionFilePath(sessionId) {
  return path.join(paths.sessions, `${sessionId}.json`)
}

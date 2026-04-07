import fs from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import { randomUUID } from 'node:crypto'
import { spawn } from 'node:child_process'

/**
 * Gateway Cron Scheduler
 *
 * Persistent cron that runs inside the always-on gateway daemon.
 * Tasks persist to ~/.claude/gateway/cron_tasks.json and fire even
 * when no interactive Claude session is open.
 *
 * When a task fires, it spawns `claude -p "<prompt>"` as a subprocess.
 * Results can optionally be sent to a Telegram chat.
 */

const CRON_FILE = path.join(os.homedir(), '.claude', 'gateway', 'cron_tasks.json')
const TICK_INTERVAL_MS = 30_000 // check every 30s

let tasks = []
let tickTimer = null
let log = () => {}

// --- Public API ---

export function initCronScheduler(logger) {
  log = logger
}

export async function startCronScheduler() {
  await loadTasks()
  tickTimer = setInterval(() => tick(), TICK_INTERVAL_MS)
  log(`Cron scheduler started, ${tasks.length} task(s) loaded`)
}

export function stopCronScheduler() {
  if (tickTimer) {
    clearInterval(tickTimer)
    tickTimer = null
  }
}

export async function createCronTask({ cron, prompt, recurring = true, notifyChannel = null }) {
  validateCron(cron)
  const task = {
    id: randomUUID().slice(0, 8),
    cron,
    prompt,
    recurring,
    notifyChannel, // e.g. "telegram:12345" — send result to this chat
    createdAt: Date.now(),
    lastFiredAt: null,
  }
  tasks.push(task)
  await saveTasks()
  log(`Cron task created: ${task.id} — ${cron} — ${prompt.slice(0, 50)}`)
  return task
}

export async function deleteCronTask(id) {
  const idx = tasks.findIndex(t => t.id === id)
  if (idx === -1) return null
  const [removed] = tasks.splice(idx, 1)
  await saveTasks()
  log(`Cron task deleted: ${id}`)
  return removed
}

export function listCronTasks() {
  return tasks.map(t => ({
    ...t,
    nextFire: cronToNextDate(t.cron)?.toISOString() ?? null,
    humanSchedule: cronToHuman(t.cron),
  }))
}

// --- Tick loop ---

async function tick() {
  const now = new Date()
  const toFire = []
  const toDelete = []

  for (const task of tasks) {
    if (shouldFire(task, now)) {
      toFire.push(task)
      if (!task.recurring) {
        toDelete.push(task.id)
      }
    }
  }

  // Fire tasks (don't await — let them run in background)
  for (const task of toFire) {
    task.lastFiredAt = Date.now()
    fireTask(task)
  }

  // Clean up one-shot tasks
  if (toDelete.length > 0) {
    tasks = tasks.filter(t => !toDelete.includes(t.id))
    await saveTasks()
  } else if (toFire.length > 0) {
    await saveTasks() // persist lastFiredAt
  }
}

function shouldFire(task, now) {
  const fields = parseCron(task.cron)
  if (!fields) return false

  // Check if current minute matches the cron expression
  if (!matchesField(fields.minute, now.getMinutes())) return false
  if (!matchesField(fields.hour, now.getHours())) return false
  if (!matchesField(fields.dom, now.getDate())) return false
  if (!matchesField(fields.month, now.getMonth() + 1)) return false
  if (!matchesField(fields.dow, now.getDay())) return false

  // Don't fire twice in the same minute
  if (task.lastFiredAt) {
    const lastFired = new Date(task.lastFiredAt)
    if (
      lastFired.getFullYear() === now.getFullYear() &&
      lastFired.getMonth() === now.getMonth() &&
      lastFired.getDate() === now.getDate() &&
      lastFired.getHours() === now.getHours() &&
      lastFired.getMinutes() === now.getMinutes()
    ) {
      return false
    }
  }

  return true
}

// --- Task execution ---

let _gateway = null
export function setCronGateway(gateway) {
  _gateway = gateway
}

function fireTask(task) {
  log(`Firing cron task ${task.id}: ${task.prompt.slice(0, 80)}`)

  const claudeBin = 'claude'
  const args = ['-p', task.prompt]
  const cwd = process.cwd()

  const child = spawn(claudeBin, args, {
    cwd,
    env: process.env,
    stdio: ['pipe', 'pipe', 'pipe'],
  })

  let stdout = ''
  child.stdout.on('data', chunk => { stdout += chunk.toString() })
  child.stderr.on('data', () => {}) // drain

  child.on('close', async (code) => {
    const result = stdout.trim()
    log(`Cron task ${task.id} finished (exit ${code}): ${result.slice(0, 100)}`)

    // Send result to Telegram if notifyChannel is set
    if (task.notifyChannel && _gateway) {
      const [platform, chatId] = task.notifyChannel.split(':')
      const channel = _gateway.channels.get(platform)
      if (channel && chatId) {
        try {
          await channel.sendMessage(Number(chatId), result || '(no output)')
        } catch (err) {
          log(`Failed to notify ${task.notifyChannel}: ${err.message}`)
        }
      }
    }
  })

  child.stdin.end()
}

// --- Persistence ---

async function loadTasks() {
  try {
    const raw = await fs.readFile(CRON_FILE, 'utf8')
    const data = JSON.parse(raw)
    tasks = Array.isArray(data.tasks) ? data.tasks : []
  } catch (err) {
    if (err.code !== 'ENOENT') log(`Failed to load cron tasks: ${err.message}`)
    tasks = []
  }
}

async function saveTasks() {
  const dir = path.dirname(CRON_FILE)
  await fs.mkdir(dir, { recursive: true })
  await fs.writeFile(CRON_FILE, JSON.stringify({ tasks }, null, 2))
}

// --- Cron parser ---

function parseCron(expr) {
  const parts = expr.trim().split(/\s+/)
  if (parts.length !== 5) return null
  return {
    minute: parseField(parts[0], 0, 59),
    hour: parseField(parts[1], 0, 23),
    dom: parseField(parts[2], 1, 31),
    month: parseField(parts[3], 1, 12),
    dow: parseField(parts[4], 0, 6),
  }
}

function parseField(field, min, max) {
  if (field === '*') return null // matches all
  const values = new Set()

  for (const part of field.split(',')) {
    const stepMatch = part.match(/^(.+)\/(\d+)$/)
    const step = stepMatch ? parseInt(stepMatch[2]) : 1
    const range = stepMatch ? stepMatch[1] : part

    if (range === '*') {
      for (let i = min; i <= max; i += step) values.add(i)
    } else if (range.includes('-')) {
      const [lo, hi] = range.split('-').map(Number)
      for (let i = lo; i <= hi; i += step) values.add(i)
    } else {
      values.add(parseInt(range))
    }
  }

  return values
}

function matchesField(fieldValues, current) {
  if (fieldValues === null) return true // wildcard
  return fieldValues.has(current)
}

function validateCron(expr) {
  const fields = parseCron(expr)
  if (!fields) throw new Error(`Invalid cron expression: "${expr}". Expected 5 fields: M H DoM Mon DoW`)
}

function cronToNextDate(expr) {
  const fields = parseCron(expr)
  if (!fields) return null

  const now = new Date()
  // Check each minute for the next 48 hours
  const limit = 48 * 60
  for (let i = 1; i <= limit; i++) {
    const candidate = new Date(now.getTime() + i * 60000)
    candidate.setSeconds(0, 0)
    if (
      matchesField(fields.minute, candidate.getMinutes()) &&
      matchesField(fields.hour, candidate.getHours()) &&
      matchesField(fields.dom, candidate.getDate()) &&
      matchesField(fields.month, candidate.getMonth() + 1) &&
      matchesField(fields.dow, candidate.getDay())
    ) {
      return candidate
    }
  }
  return null
}

function cronToHuman(expr) {
  const parts = expr.trim().split(/\s+/)
  if (parts.length !== 5) return expr

  const [min, hour, dom, month, dow] = parts

  if (min.startsWith('*/')) return `every ${min.slice(2)} minutes`
  if (hour.startsWith('*/')) return `every ${hour.slice(2)} hours`
  if (min === '*' && hour === '*') return 'every minute'
  if (hour === '*') return `every hour at :${min.padStart(2, '0')}`

  const timeStr = `${hour.padStart(2, '0')}:${min.padStart(2, '0')}`

  if (dom !== '*' && month !== '*') return `once at ${timeStr} on ${month}/${dom}`
  if (dow === '1-5') return `weekdays at ${timeStr}`
  if (dow === '0,6') return `weekends at ${timeStr}`
  if (dow !== '*') return `day ${dow} at ${timeStr}`
  return `daily at ${timeStr}`
}

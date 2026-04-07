import fs from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'

/**
 * OpenClaw-style memory system.
 *
 * Files (plain Markdown, human-editable):
 *   ~/.claude/gateway/memory/SOUL.md        — Identity (user-written, never auto-modified)
 *   ~/.claude/gateway/memory/MEMORY.md      — Long-term facts, preferences, rules
 *   ~/.claude/gateway/memory/YYYY-MM-DD.md  — Daily diary
 *   ~/.claude/gateway/memory/DREAMS.md      — Dream consolidation log
 */

const MEMORY_DIR = path.join(os.homedir(), '.claude', 'gateway', 'memory')

export async function ensureMemoryDir() {
  await fs.mkdir(MEMORY_DIR, { recursive: true })
}

// --- Read ---

/**
 * Load memory context for injection into prompt.
 * Returns everything EXCEPT soul (soul is handled separately).
 */
export async function loadMemoryContext() {
  await ensureMemoryDir()

  const longTerm = await readMemoryFile('MEMORY.md')
  const today = await readMemoryFile(todayFilename())
  const yesterday = await readMemoryFile(yesterdayFilename())

  const parts = []

  if (longTerm) {
    parts.push('LONG-TERM MEMORY (facts, preferences, rules):', longTerm)
  }

  if (yesterday) {
    parts.push(`DIARY — ${yesterdayFilename()}:`, yesterday)
  }

  if (today) {
    parts.push(`DIARY — ${todayFilename()}:`, today)
  }

  return parts.length > 0 ? parts.join('\n\n') : null
}

export async function readMemoryFile(filename) {
  try {
    const content = await fs.readFile(path.join(MEMORY_DIR, filename), 'utf8')
    return content.trim() || null
  } catch {
    return null
  }
}

// --- Write ---

export async function writeMemoryFile(filename, content) {
  await ensureMemoryDir()
  if (!/^[\w\-.]+$/.test(filename)) {
    throw new Error(`Invalid memory filename: ${filename}`)
  }
  await fs.writeFile(path.join(MEMORY_DIR, filename), content)
}

export async function appendToMemoryFile(filename, content) {
  await ensureMemoryDir()
  if (!/^[\w\-.]+$/.test(filename)) {
    throw new Error(`Invalid memory filename: ${filename}`)
  }
  const filePath = path.join(MEMORY_DIR, filename)
  let existing = ''
  try {
    existing = await fs.readFile(filePath, 'utf8')
  } catch { /* new file */ }

  const timestamp = new Date().toLocaleTimeString('en-US', { hour12: false })
  const entry = `\n[${timestamp}] ${content}`
  await fs.writeFile(filePath, existing + entry)
}

export async function appendToDiary(content) {
  await appendToMemoryFile(todayFilename(), content)
}

// --- Search (hybrid: keyword + fuzzy + synonym-aware) ---

// Common synonyms/related terms for better recall without embeddings
const SYNONYMS = {
  bug: ['issue', 'error', 'fix', 'broken', 'crash', 'fail'],
  auth: ['login', 'authentication', 'oauth', 'token', 'password', 'credential'],
  deploy: ['ship', 'release', 'publish', 'launch', 'production'],
  test: ['spec', 'testing', 'coverage', 'jest', 'pytest', 'unit'],
  db: ['database', 'sql', 'postgres', 'mysql', 'mongo', 'migration'],
  api: ['endpoint', 'route', 'rest', 'graphql', 'request', 'response'],
  ui: ['frontend', 'component', 'react', 'css', 'layout', 'design'],
  perf: ['performance', 'slow', 'fast', 'latency', 'speed', 'optimize'],
  config: ['configuration', 'settings', 'env', 'environment', 'setup'],
  user: ['name', 'preference', 'likes', 'prefers', 'wants'],
}

export async function searchMemory(query) {
  await ensureMemoryDir()
  const files = await fs.readdir(MEMORY_DIR)

  const queryLower = query.toLowerCase()
  const queryWords = queryLower.split(/\s+/).filter(w => w.length > 1)

  // Expand query with synonyms
  const expandedWords = new Set(queryWords)
  for (const word of queryWords) {
    // Check if this word is a synonym key
    if (SYNONYMS[word]) {
      SYNONYMS[word].forEach(s => expandedWords.add(s))
    }
    // Check if this word appears in synonym values
    for (const [key, vals] of Object.entries(SYNONYMS)) {
      if (vals.includes(word)) {
        expandedWords.add(key)
        vals.forEach(s => expandedWords.add(s))
      }
    }
  }

  const results = []

  for (const file of files) {
    if (!file.endsWith('.md')) continue
    const content = await fs.readFile(path.join(MEMORY_DIR, file), 'utf8')
    const lines = content.split('\n')

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i]
      if (!line.trim()) continue
      const lineLower = line.toLowerCase()

      // Score: exact query word matches count double, synonym matches count single
      let score = 0
      for (const word of queryWords) {
        if (lineLower.includes(word)) score += 2
      }
      for (const word of expandedWords) {
        if (!queryWords.includes(word) && lineLower.includes(word)) score += 1
      }

      // Substring match of full query
      if (lineLower.includes(queryLower)) score += 3

      if (score > 0) {
        const start = Math.max(0, i - 2)
        const end = Math.min(lines.length, i + 3)
        results.push({
          file,
          line: i + 1,
          score,
          context: lines.slice(start, end).join('\n'),
        })
      }
    }
  }

  // Dedupe overlapping contexts, keep highest score
  const seen = new Set()
  const deduped = results
    .sort((a, b) => b.score - a.score)
    .filter(r => {
      const key = `${r.file}:${Math.floor(r.line / 5)}`
      if (seen.has(key)) return false
      seen.add(key)
      return true
    })

  return deduped.slice(0, 10)
}

// --- List ---

export async function listMemoryFiles() {
  await ensureMemoryDir()
  const files = await fs.readdir(MEMORY_DIR)
  const result = []
  for (const file of files) {
    if (!file.endsWith('.md')) continue
    const stat = await fs.stat(path.join(MEMORY_DIR, file))
    result.push({ file, size: stat.size, modified: stat.mtime.toISOString() })
  }
  return result
}

// --- Dream Consolidation ---

/**
 * Scans diary entries from the last N days, scores each line by
 * how many times similar content appears (recall frequency),
 * and promotes high-scoring items to MEMORY.md.
 */
export async function runDreamConsolidation(daysBack = 7) {
  await ensureMemoryDir()
  const files = await fs.readdir(MEMORY_DIR)

  // Collect all diary lines from last N days
  const cutoff = Date.now() - daysBack * 86400000
  const diaryLines = []

  for (const file of files) {
    if (!/^\d{4}-\d{2}-\d{2}\.md$/.test(file)) continue
    const dateStr = file.replace('.md', '')
    const fileDate = new Date(dateStr).getTime()
    if (fileDate < cutoff) continue

    const content = await fs.readFile(path.join(MEMORY_DIR, file), 'utf8')
    for (const line of content.split('\n')) {
      const trimmed = line.replace(/^\[[\d:]+\]\s*/, '').trim()
      if (trimmed.length > 10) {
        diaryLines.push({ text: trimmed, source: file })
      }
    }
  }

  if (diaryLines.length === 0) return { promoted: 0, reviewed: 0 }

  // Score each line by how many OTHER lines share similar words (recall frequency)
  const scored = diaryLines.map(entry => {
    const words = new Set(entry.text.toLowerCase().split(/\s+/).filter(w => w.length > 3))
    let score = 0
    for (const other of diaryLines) {
      if (other === entry) continue
      const otherWords = other.text.toLowerCase().split(/\s+/)
      const overlap = otherWords.filter(w => words.has(w)).length
      if (overlap >= 2) score++
    }
    return { ...entry, score }
  })

  // Promote top items (score >= 2 means mentioned in multiple diary entries)
  const promoted = scored.filter(s => s.score >= 2).map(s => s.text)
  if (promoted.length === 0) return { promoted: 0, reviewed: diaryLines.length }

  // Dedupe against existing MEMORY.md
  const existingMemory = (await readMemoryFile('MEMORY.md')) ?? ''
  const existingLower = existingMemory.toLowerCase()
  const newItems = promoted.filter(p =>
    !existingLower.includes(p.toLowerCase().slice(0, 30))
  )

  if (newItems.length > 0) {
    const timestamp = new Date().toISOString().split('T')[0]
    const addition = `\n\n## Consolidated ${timestamp}\n${newItems.map(i => `- ${i}`).join('\n')}`
    await writeMemoryFile('MEMORY.md', existingMemory + addition)

    // Log to DREAMS.md
    const dreamLog = `[${timestamp}] Reviewed ${diaryLines.length} diary entries, promoted ${newItems.length}:\n${newItems.map(i => `  + ${i}`).join('\n')}`
    await appendToMemoryFile('DREAMS.md', dreamLog)
  }

  return { promoted: newItems.length, reviewed: diaryLines.length }
}

// --- Pre-compaction Flush ---

/**
 * Returns a prompt that asks Claude to save important context.
 * The gateway should inject this when the conversation gets long.
 */
export function buildFlushPrompt() {
  return [
    'IMPORTANT: Your context window is getting full. Before continuing, save any important information from this conversation that should persist.',
    'Write lasting facts/preferences/rules to MEMORY.md.',
    'Write today\'s events/decisions/context to the diary.',
    'If nothing important needs saving, continue normally.',
  ].join('\n')
}

// --- Tool Instructions ---

/**
 * Build memory tool instructions styled like native tool descriptions.
 * Stronger than "here are curl commands" — framed as protocol the agent MUST follow.
 */
export function buildMemoryToolInstructions(gatewayPort) {
  return [
    '=== MEMORY PROTOCOL ===',
    'You have persistent memory. Follow this protocol strictly:',
    '',
    'RETRIEVE-BEFORE-ACT: Before answering ANY question about past events, preferences, or prior work,',
    'search memory FIRST. Never say "I don\'t remember" without searching.',
    '',
    'SAVE-ON-LEARN: When the user corrects you, states a preference, shares personal info,',
    'or you complete a significant task — save it immediately. Don\'t wait.',
    '',
    'Memory tools (use via Bash):',
    '',
    `memory_search: curl -s 'http://127.0.0.1:${gatewayPort}/memory/search?q=QUERY'`,
    '  → Search across all memory files. Use BEFORE answering from memory.',
    '',
    `memory_read: curl -s 'http://127.0.0.1:${gatewayPort}/memory/read?file=FILENAME'`,
    '  → Read a specific memory file.',
    '',
    `memory_save: curl -s -X POST http://127.0.0.1:${gatewayPort}/memory/write -H 'content-type: application/json' -d '{"file":"MEMORY.md","content":"FULL UPDATED CONTENT"}'`,
    '  → Write to long-term memory. Include ALL existing content plus new additions.',
    '',
    `memory_diary: curl -s -X POST http://127.0.0.1:${gatewayPort}/memory/diary -H 'content-type: application/json' -d '{"content":"WHAT HAPPENED"}'`,
    '  → Append to today\'s diary. Use for events, decisions, task completions.',
    '',
    `memory_list: curl -s http://127.0.0.1:${gatewayPort}/memory/list`,
    '  → List all memory files.',
    '',
    'RULES:',
    '- ALWAYS search before saying you don\'t know about past interactions',
    '- ALWAYS save when the user corrects you or states a preference',
    '- ALWAYS save after completing a significant task',
    '- Read MEMORY.md before overwriting it — preserve existing content',
    '- Keep MEMORY.md under 100 lines. Be concise. Facts, not prose.',
  ].join('\n')
}

// --- Utilities ---

function todayFilename() {
  const d = new Date()
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}.md`
}

function yesterdayFilename() {
  const d = new Date(Date.now() - 86400000)
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}.md`
}

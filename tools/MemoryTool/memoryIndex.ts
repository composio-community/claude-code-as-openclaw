import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import crypto from 'node:crypto'
import { createRequire } from 'node:module'

// Load better-sqlite3 — try require (sync, no top-level await)
let Database: any = null
try {
  const require2 = createRequire(import.meta.url)
  Database = require2('better-sqlite3')
} catch {
  try {
    // Try from gateway's node_modules
    const require3 = createRequire(path.join(os.homedir(), '.claude', 'gateway', 'node_modules', 'better-sqlite3', 'index.js'))
    Database = require3('better-sqlite3')
  } catch {
    // No SQLite available — search will fall back to file scan
    Database = null
  }
}

/**
 * SQLite FTS5 memory index — same architecture as OpenClaw.
 *
 * Schema:
 *   files   — tracks file hash/mtime for change detection
 *   chunks  — text chunks with line ranges
 *   chunks_fts — FTS5 virtual table for BM25-ranked keyword search
 *
 * Chunking: ~400 tokens, 80-token overlap (OpenClaw defaults)
 * Search: FTS5 BM25 ranking
 * Reindex: on-demand when files change (hash-based)
 */

const MEMORY_DIR = path.join(os.homedir(), '.claude', 'gateway', 'memory')
const DB_PATH = path.join(MEMORY_DIR, 'index.sqlite')
const CHUNK_TOKENS = 400
const CHUNK_OVERLAP = 80
// Rough approximation: 1 token ≈ 4 chars
const CHARS_PER_TOKEN = 4
const CHUNK_CHARS = CHUNK_TOKENS * CHARS_PER_TOKEN
const OVERLAP_CHARS = CHUNK_OVERLAP * CHARS_PER_TOKEN

let db: any = null

function getDb(): any {
  if (db) return db
  if (!Database) return null

  fs.mkdirSync(MEMORY_DIR, { recursive: true })
  db = new Database(DB_PATH)
  db.pragma('journal_mode = WAL')
  db.pragma('foreign_keys = ON')

  // Create tables
  db.exec(`
    CREATE TABLE IF NOT EXISTS files (
      path TEXT PRIMARY KEY,
      hash TEXT NOT NULL,
      mtime INTEGER NOT NULL,
      size INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS chunks (
      id TEXT PRIMARY KEY,
      path TEXT NOT NULL,
      start_line INTEGER NOT NULL,
      end_line INTEGER NOT NULL,
      hash TEXT NOT NULL,
      text TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_chunks_path ON chunks(path);
  `)

  // FTS5 virtual table — separate try since it may already exist
  try {
    db.exec(`
      CREATE VIRTUAL TABLE IF NOT EXISTS chunks_fts USING fts5(
        text,
        id UNINDEXED,
        path UNINDEXED,
        start_line UNINDEXED,
        end_line UNINDEXED
      );
    `)
  } catch {
    // Already exists
  }

  return db
}

// --- Indexing ---

/**
 * Reindex all memory files. Only processes files that changed (by hash).
 * Returns number of files reindexed.
 */
export function reindexMemory(): number {
  const db = getDb()
  if (!db) return 0
  let reindexed = 0

  // Get all .md files
  let files: string[]
  try {
    files = fs.readdirSync(MEMORY_DIR).filter(f => f.endsWith('.md'))
  } catch {
    return 0
  }

  const existingFiles = new Set<string>()

  for (const file of files) {
    const filePath = path.join(MEMORY_DIR, file)
    existingFiles.add(file)

    const stat = fs.statSync(filePath)
    const content = fs.readFileSync(filePath, 'utf8')
    const hash = crypto.createHash('sha256').update(content).digest('hex').slice(0, 16)

    // Check if file changed
    const existing = db.prepare('SELECT hash FROM files WHERE path = ?').get(file) as { hash: string } | undefined
    if (existing?.hash === hash) continue

    // File changed or new — reindex
    // Remove old chunks
    const oldChunkIds = db.prepare('SELECT id FROM chunks WHERE path = ?').all(file) as { id: string }[]
    for (const { id } of oldChunkIds) {
      db.prepare('DELETE FROM chunks_fts WHERE id = ?').run(id)
    }
    db.prepare('DELETE FROM chunks WHERE path = ?').run(file)

    // Chunk the file
    const chunks = chunkFile(content, file)

    // Insert new chunks
    const insertChunk = db.prepare('INSERT INTO chunks (id, path, start_line, end_line, hash, text) VALUES (?, ?, ?, ?, ?, ?)')
    const insertFts = db.prepare('INSERT INTO chunks_fts (text, id, path, start_line, end_line) VALUES (?, ?, ?, ?, ?)')

    for (const chunk of chunks) {
      insertChunk.run(chunk.id, file, chunk.startLine, chunk.endLine, hash, chunk.text)
      insertFts.run(chunk.text, chunk.id, file, chunk.startLine, chunk.endLine)
    }

    // Update file record
    db.prepare('INSERT OR REPLACE INTO files (path, hash, mtime, size) VALUES (?, ?, ?, ?)').run(file, hash, stat.mtimeMs, stat.size)

    reindexed++
  }

  // Remove chunks for deleted files
  const allIndexed = db.prepare('SELECT path FROM files').all() as { path: string }[]
  for (const { path: indexedPath } of allIndexed) {
    if (!existingFiles.has(indexedPath)) {
      const oldChunkIds = db.prepare('SELECT id FROM chunks WHERE path = ?').all(indexedPath) as { id: string }[]
      for (const { id } of oldChunkIds) {
        db.prepare('DELETE FROM chunks_fts WHERE id = ?').run(id)
      }
      db.prepare('DELETE FROM chunks WHERE path = ?').run(indexedPath)
      db.prepare('DELETE FROM files WHERE path = ?').run(indexedPath)
    }
  }

  return reindexed
}

/**
 * Chunk file content into ~400-token pieces with 80-token overlap.
 * Preserves line boundaries.
 */
function chunkFile(content: string, filePath: string): Array<{ id: string; startLine: number; endLine: number; text: string }> {
  const lines = content.split('\n')
  const chunks: Array<{ id: string; startLine: number; endLine: number; text: string }> = []

  let i = 0
  while (i < lines.length) {
    let chunkText = ''
    const startLine = i + 1
    let endLine = startLine

    // Accumulate lines up to CHUNK_CHARS
    while (i < lines.length && chunkText.length < CHUNK_CHARS) {
      chunkText += (chunkText ? '\n' : '') + lines[i]
      endLine = i + 1
      i++
    }

    if (chunkText.trim()) {
      const id = crypto.createHash('sha256').update(`${filePath}:${startLine}:${chunkText}`).digest('hex').slice(0, 12)
      chunks.push({ id, startLine, endLine, text: chunkText })
    }

    // Overlap — step back by OVERLAP_CHARS worth of lines
    if (i < lines.length) {
      let overlapChars = 0
      let stepBack = 0
      for (let j = i - 1; j >= 0 && overlapChars < OVERLAP_CHARS; j--) {
        overlapChars += lines[j].length + 1
        stepBack++
      }
      i -= Math.min(stepBack, Math.floor(stepBack * 0.5)) // overlap ~half the step-back
    }
  }

  return chunks
}

// --- Search ---

export type SearchResult = {
  file: string
  startLine: number
  endLine: number
  text: string
  score: number
}

/**
 * FTS5 BM25 search across all indexed memory chunks.
 * Reindexes changed files before searching.
 */
export function searchMemoryFTS(query: string, limit: number = 10): SearchResult[] {
  const db = getDb()

  // No SQLite available — fall back to file scan
  if (!db) return fileScanSearch(query, limit)

  // Reindex any changed files first
  reindexMemory()

  // FTS5 MATCH query — escape special chars
  const ftsQuery = query
    .replace(/['"(){}[\]*:^~!]/g, ' ')
    .split(/\s+/)
    .filter(w => w.length > 1)
    .join(' OR ')

  if (!ftsQuery) return []

  try {
    const results = db.prepare(`
      SELECT
        chunks_fts.id,
        chunks_fts.path AS file,
        chunks_fts.start_line AS startLine,
        chunks_fts.end_line AS endLine,
        chunks_fts.text,
        bm25(chunks_fts) AS score
      FROM chunks_fts
      WHERE chunks_fts MATCH ?
      ORDER BY score ASC
      LIMIT ?
    `).all(ftsQuery, limit) as SearchResult[]

    // bm25() returns negative values (lower = better), normalize to positive
    return results.map(r => ({ ...r, score: Math.abs(r.score) }))
  } catch {
    // FTS query syntax error — fallback to simple LIKE
    return fallbackSearch(query, limit)
  }
}

function fallbackSearch(query: string, limit: number): SearchResult[] {
  const db = getDb()
  const words = query.toLowerCase().split(/\s+/).filter(w => w.length > 1)
  if (words.length === 0) return []

  // LIKE-based search as fallback
  const conditions = words.map(() => 'LOWER(text) LIKE ?').join(' OR ')
  const params = words.map(w => `%${w}%`)

  return db.prepare(`
    SELECT id, path AS file, start_line AS startLine, end_line AS endLine, text, 1.0 AS score
    FROM chunks
    WHERE ${conditions}
    LIMIT ?
  `).all(...params, limit) as SearchResult[]
}

/**
 * Get stats about the index.
 */
export function getIndexStats(): { files: number; chunks: number; dbSize: number } {
  const db = getDb()
  if (!db) {
    // Count files directly
    let fileCount = 0
    try { fileCount = fs.readdirSync(MEMORY_DIR).filter(f => f.endsWith('.md')).length } catch { /* ok */ }
    return { files: fileCount, chunks: 0, dbSize: 0 }
  }
  const files = (db.prepare('SELECT count(*) AS n FROM files').get() as { n: number }).n
  const chunks = (db.prepare('SELECT count(*) AS n FROM chunks').get() as { n: number }).n
  let dbSize = 0
  try {
    dbSize = fs.statSync(DB_PATH).size
  } catch { /* ok */ }
  return { files, chunks, dbSize }
}

/**
 * Fallback search when SQLite isn't available — scans files directly.
 */
function fileScanSearch(query: string, limit: number): SearchResult[] {
  let files: string[]
  try {
    files = fs.readdirSync(MEMORY_DIR).filter(f => f.endsWith('.md'))
  } catch { return [] }

  const queryWords = query.toLowerCase().split(/\s+/).filter(w => w.length > 1)
  if (queryWords.length === 0) return []

  const results: SearchResult[] = []

  for (const file of files) {
    const content = fs.readFileSync(path.join(MEMORY_DIR, file), 'utf8')
    const lines = content.split('\n')

    for (let i = 0; i < lines.length; i++) {
      const lineLower = lines[i].toLowerCase()
      if (!lineLower.trim()) continue

      const matchCount = queryWords.filter(w => lineLower.includes(w)).length
      if (matchCount > 0) {
        const start = Math.max(0, i - 2)
        const end = Math.min(lines.length, i + 3)
        results.push({
          file,
          startLine: start + 1,
          endLine: end,
          text: lines.slice(start, end).join('\n'),
          score: matchCount / queryWords.length,
        })
      }
    }
  }

  const seen = new Set<string>()
  return results
    .sort((a, b) => b.score - a.score)
    .filter(r => {
      const key = `${r.file}:${Math.floor(r.startLine / 5)}`
      if (seen.has(key)) return false
      seen.add(key)
      return true
    })
    .slice(0, limit)
}

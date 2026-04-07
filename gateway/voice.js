import fs from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)
const TMP_DIR = path.join(os.tmpdir(), 'openclaudeclaw-voice')

/**
 * Voice pipeline: Telegram voice OGG → WAV → whisper STT → Claude → TTS → OGG → Telegram
 *
 * Dependencies:
 *   - ffmpeg (brew install ffmpeg)
 *   - whisper (pip install openai-whisper) or whisper.cpp (brew install whisper-cpp)
 *   - say (built-in macOS)
 */

export async function ensureVoiceDeps() {
  await fs.mkdir(TMP_DIR, { recursive: true })

  const missing = []
  for (const bin of ['ffmpeg']) {
    try {
      await execFileAsync('which', [bin])
    } catch {
      missing.push(bin)
    }
  }

  // Check for any whisper variant
  let whisperBin = null
  for (const bin of ['whisper', 'whisper-cpp', 'whisper.cpp']) {
    try {
      await execFileAsync('which', [bin])
      whisperBin = bin
      break
    } catch { /* try next */ }
  }
  if (!whisperBin) missing.push('whisper (pip install openai-whisper)')

  if (missing.length > 0) {
    throw new Error(`Voice deps missing: ${missing.join(', ')}`)
  }

  return { whisperBin }
}

/**
 * Download a Telegram voice file, transcribe it, return text.
 */
export async function transcribeVoice(telegramChannel, fileId) {
  const id = Date.now()
  const oggPath = path.join(TMP_DIR, `${id}.ogg`)
  const wavPath = path.join(TMP_DIR, `${id}.wav`)

  try {
    // 1. Download OGG from Telegram
    const fileInfo = await telegramChannel._call('getFile', { file_id: fileId })
    const fileUrl = `https://api.telegram.org/file/bot${telegramChannel.botToken}/${fileInfo.file_path}`
    const res = await fetch(fileUrl)
    const buffer = Buffer.from(await res.arrayBuffer())
    await fs.writeFile(oggPath, buffer)

    // 2. Convert OGG → WAV (16kHz mono for whisper)
    await execFileAsync('ffmpeg', [
      '-i', oggPath,
      '-ar', '16000',
      '-ac', '1',
      '-f', 'wav',
      '-y', wavPath,
    ])

    // 3. Transcribe with whisper
    const text = await runWhisper(wavPath)
    return text.trim()
  } finally {
    // Cleanup temp files
    await fs.unlink(oggPath).catch(() => {})
    await fs.unlink(wavPath).catch(() => {})
  }
}

/**
 * Convert text to voice OGG and return the file path.
 */
export async function textToVoice(text, voice = 'Samantha') {
  const id = Date.now()
  const aiffPath = path.join(TMP_DIR, `${id}.aiff`)
  const oggPath = path.join(TMP_DIR, `${id}_reply.ogg`)

  // 1. macOS say → AIFF
  await execFileAsync('say', ['-v', voice, '-o', aiffPath, text.slice(0, 2000)])

  // 2. AIFF → OGG Opus (Telegram requires this format)
  await execFileAsync('ffmpeg', [
    '-i', aiffPath,
    '-c:a', 'libopus',
    '-b:a', '48k',
    '-y', oggPath,
  ])

  await fs.unlink(aiffPath).catch(() => {})
  return oggPath
}

/**
 * Clean up a voice file after sending.
 */
export async function cleanupVoiceFile(filePath) {
  await fs.unlink(filePath).catch(() => {})
}

// --- Whisper ---

async function runWhisper(wavPath) {
  // Try openai-whisper first (Python)
  try {
    const { stdout } = await execFileAsync('whisper', [
      wavPath,
      '--model', 'base',
      '--language', 'en',
      '--output_format', 'txt',
      '--output_dir', TMP_DIR,
    ], { timeout: 60000 })

    // whisper outputs a .txt file next to the input
    const txtPath = wavPath.replace('.wav', '.txt')
    try {
      const text = await fs.readFile(txtPath, 'utf8')
      await fs.unlink(txtPath).catch(() => {})
      // Clean up other whisper output files
      for (const ext of ['.vtt', '.srt', '.tsv', '.json']) {
        await fs.unlink(wavPath.replace('.wav', ext)).catch(() => {})
      }
      return text
    } catch {
      return stdout.trim()
    }
  } catch {
    // Fallback: try whisper.cpp
    try {
      const { stdout } = await execFileAsync('whisper-cpp', [
        '-m', path.join(os.homedir(), '.cache', 'whisper', 'ggml-base.en.bin'),
        '-f', wavPath,
        '--no-timestamps',
      ], { timeout: 60000 })
      return stdout.trim()
    } catch (err) {
      throw new Error(`Whisper transcription failed: ${err.message}`)
    }
  }
}

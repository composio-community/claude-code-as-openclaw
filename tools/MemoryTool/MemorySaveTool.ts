import fs from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import { z } from 'zod/v4'
import { buildTool, type ToolDef } from '../../Tool.js'
import { lazySchema } from '../../utils/lazySchema.js'
import {
  MEMORY_SAVE_TOOL_NAME,
  MEMORY_SAVE_DESCRIPTION,
  MEMORY_SAVE_PROMPT,
} from './prompt.js'

const MEMORY_DIR = path.join(os.homedir(), '.claude', 'gateway', 'memory')

const inputSchema = lazySchema(() =>
  z.strictObject({
    file: z
      .enum(['MEMORY.md', 'diary'])
      .describe(
        'Target: "MEMORY.md" for long-term facts/preferences/rules, "diary" for today\'s events/decisions',
      ),
    content: z.string().describe('Content to write. For MEMORY.md: full file content (read first, add to it). For diary: the entry to append.'),
  }),
)
type InputSchema = ReturnType<typeof inputSchema>

const outputSchema = lazySchema(() =>
  z.object({
    file: z.string(),
    action: z.string(),
    size: z.number(),
  }),
)
type OutputSchema = ReturnType<typeof outputSchema>
export type Output = z.infer<OutputSchema>

function todayFilename(): string {
  const d = new Date()
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}.md`
}

export const MemorySaveTool = buildTool({
  name: MEMORY_SAVE_TOOL_NAME,
  searchHint: 'save information to persistent memory',
  maxResultSizeChars: 10_000,
  get inputSchema(): InputSchema {
    return inputSchema()
  },
  get outputSchema(): OutputSchema {
    return outputSchema()
  },
  isEnabled() {
    return true
  },
  isConcurrencySafe() {
    return false
  },
  isReadOnly() {
    return false
  },
  async description() {
    return MEMORY_SAVE_DESCRIPTION
  },
  async prompt() {
    return MEMORY_SAVE_PROMPT
  },
  async checkPermissions(input) {
    return { behavior: 'allow' as const, updatedInput: input }
  },
  async call({ file, content }) {
    await fs.mkdir(MEMORY_DIR, { recursive: true })

    if (file === 'diary') {
      // Append to today's diary
      const diaryPath = path.join(MEMORY_DIR, todayFilename())
      let existing = ''
      try {
        existing = await fs.readFile(diaryPath, 'utf8')
      } catch { /* new file */ }

      const timestamp = new Date().toLocaleTimeString('en-US', { hour12: false })
      const entry = `${existing ? '\n' : ''}[${timestamp}] ${content}`
      await fs.writeFile(diaryPath, existing + entry)

      const stat = await fs.stat(diaryPath)
      return {
        data: {
          file: todayFilename(),
          action: 'appended',
          size: stat.size,
        },
      }
    } else {
      // Write to MEMORY.md (full overwrite — caller should include existing content)
      const memPath = path.join(MEMORY_DIR, 'MEMORY.md')
      await fs.writeFile(memPath, content)

      const stat = await fs.stat(memPath)
      return {
        data: {
          file: 'MEMORY.md',
          action: 'written',
          size: stat.size,
        },
      }
    }
  },
  mapToolResultToToolResultBlockParam(output, toolUseID) {
    return {
      tool_use_id: toolUseID,
      type: 'tool_result',
      content: `Memory ${output.action}: ${output.file} (${output.size} bytes)`,
    }
  },
  renderToolUseMessage: () => 'Saving to memory...',
  renderToolResultMessage: () => null,
} satisfies ToolDef<InputSchema, Output>)

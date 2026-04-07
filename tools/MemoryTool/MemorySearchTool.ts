import { z } from 'zod/v4'
import { buildTool, type ToolDef } from '../../Tool.js'
import { lazySchema } from '../../utils/lazySchema.js'
import { searchMemoryFTS, getIndexStats, type SearchResult } from './memoryIndex.js'
import {
  MEMORY_SEARCH_TOOL_NAME,
  MEMORY_SEARCH_DESCRIPTION,
  MEMORY_SEARCH_PROMPT,
} from './prompt.js'

const inputSchema = lazySchema(() =>
  z.strictObject({
    query: z.string().describe('Search query — what you want to find in memory'),
  }),
)
type InputSchema = ReturnType<typeof inputSchema>

const outputSchema = lazySchema(() =>
  z.object({
    results: z.array(
      z.object({
        file: z.string(),
        startLine: z.number(),
        endLine: z.number(),
        text: z.string(),
        score: z.number(),
      }),
    ),
    stats: z.object({
      files: z.number(),
      chunks: z.number(),
    }),
  }),
)
type OutputSchema = ReturnType<typeof outputSchema>
export type Output = z.infer<OutputSchema>

export const MemorySearchTool = buildTool({
  name: MEMORY_SEARCH_TOOL_NAME,
  searchHint: 'search persistent memory for past context',
  maxResultSizeChars: 50_000,
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
    return true
  },
  isReadOnly() {
    return true
  },
  async description() {
    return MEMORY_SEARCH_DESCRIPTION
  },
  async prompt() {
    return MEMORY_SEARCH_PROMPT
  },
  async checkPermissions(input) {
    return { behavior: 'allow' as const, updatedInput: input }
  },
  async call({ query }) {
    const results = searchMemoryFTS(query, 10)
    const stats = getIndexStats()

    return {
      data: {
        results: results.map(r => ({
          file: r.file,
          startLine: r.startLine,
          endLine: r.endLine,
          text: r.text,
          score: Math.round(r.score * 100) / 100,
        })),
        stats: {
          files: stats.files,
          chunks: stats.chunks,
        },
      },
    }
  },
  mapToolResultToToolResultBlockParam(output, toolUseID) {
    if (output.results.length === 0) {
      return {
        tool_use_id: toolUseID,
        type: 'tool_result',
        content: `No results found. Index has ${output.stats.files} file(s), ${output.stats.chunks} chunk(s).`,
      }
    }
    const lines = output.results.map(
      (r: { file: string; startLine: number; endLine: number; text: string; score: number }) =>
        `[${r.file}:${r.startLine}-${r.endLine}] (relevance: ${r.score})\n${r.text}`,
    )
    return {
      tool_use_id: toolUseID,
      type: 'tool_result',
      content: `Found ${output.results.length} result(s) across ${output.stats.files} file(s), ${output.stats.chunks} chunk(s):\n\n` + lines.join('\n\n---\n\n'),
    }
  },
  renderToolUseMessage: () => 'Searching memory...',
  renderToolResultMessage: () => null,
} satisfies ToolDef<InputSchema, Output>)

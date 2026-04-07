export const MEMORY_SEARCH_TOOL_NAME = 'MemorySearch'
export const MEMORY_SAVE_TOOL_NAME = 'MemorySave'

export const MEMORY_SEARCH_DESCRIPTION =
  'Search persistent memory for facts, preferences, past events, and context from prior conversations. Uses hybrid keyword + semantic matching across all memory files (MEMORY.md, daily diary, etc). ALWAYS use this before saying you don\'t remember something.'

export const MEMORY_SAVE_DESCRIPTION =
  'Save information to persistent memory. Use "MEMORY.md" for long-term facts, preferences, rules. Use "diary" to append to today\'s diary (events, decisions, task completions). Memory persists across all conversations.'

export const MEMORY_SEARCH_PROMPT = `Search across all memory files for relevant information.

## When to use
- ALWAYS before answering questions about past interactions, preferences, or prior work
- ALWAYS before saying "I don't remember" or "I don't have context"
- When the user references something from a previous conversation
- When starting a task that might have prior context

## How it works
Searches MEMORY.md (long-term facts), daily diary files, and any other .md files in memory.
Uses keyword matching with synonym expansion for better recall.
Returns matching lines with surrounding context, ranked by relevance.`

export const MEMORY_SAVE_PROMPT = `Save information to persistent memory that should survive across conversations.

## When to use
- User corrects you or states a preference → save to MEMORY.md
- User shares personal info (name, role, project details) → save to MEMORY.md
- You complete a significant task → append to diary
- User explicitly asks you to remember something → save to MEMORY.md

## Files
- "MEMORY.md" — Long-term storage. Facts, preferences, rules. Keep under 100 lines. Be concise.
- "diary" — Appends to today's diary (YYYY-MM-DD.md). Events, decisions, observations.

## Rules
- When writing to MEMORY.md, read it first and include existing content plus your additions
- Don't save trivial information (greetings, small talk)
- Save corrections immediately — if the user says "actually I prefer X", save it now`

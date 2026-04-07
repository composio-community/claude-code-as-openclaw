# Claude Code Source Deep Dive

## What this report is

This is a reverse-engineering report of the codebase in this directory (TypeScript-heavy, no top-level `README`/`package.json` in this snapshot). It focuses on:

- What the system contains
- How requests flow through runtime
- The architectural patterns that make it robust
- The likely "secret sauce" (design choices that matter most)
- Risks, caveats, and missing pieces in this checkout

This appears to be a large internal Claude Code runtime, including CLI + TUI (Ink), agent orchestration, tool execution, permissions, MCP integration, memory systems, and remote session support.

---

## Repository anatomy

Top-level areas (approximate file counts in this snapshot):

- `utils/` (~564): cross-cutting runtime, permissions, session, telemetry, git, env, settings, hooks
- `components/` (~389): Ink/TUI rendering and interactive UX
- `commands/` (~207): slash-style commands and command plumbing
- `tools/` (~184): core tool implementations and schemas
- `services/` (~130): API, compact, MCP, analytics, team memory sync, LSP, etc.
- `hooks/` (~104): React/Ink hooks and interaction layers
- `ink/` (~96): terminal UI internals
- Smaller but important: `memdir/`, `remote/`, `entrypoints/`, `bootstrap/`, `query/`, `state/`

The size distribution strongly suggests a mature, production-hardened system optimized for real interactive use, not just SDK demos.

---

## High-level architecture

At a system level, Claude Code here is built around a loop:

1. **Bootstrap + init runtime safely**
2. **Assemble tools/commands/MCP/skills/policies**
3. **Build system prompt + context**
4. **Call model with streaming**
5. **Execute tool calls with strict permission/safety layers**
6. **Persist transcript/state, compact context, continue until terminal condition**

Primary files in that loop:

- `main.tsx`: central startup and wiring
- `setup.ts`: session/bootstrap initialization and safety gates
- `entrypoints/init.ts`: env/config/trust/telemetry/network setup
- `QueryEngine.ts`: conversation-level orchestration class
- `query.ts`: low-level query/tool execution loop
- `services/api/claude.ts`: request construction, streaming parsing, retries, model capabilities/betas
- `tools.ts` + `Tool.ts`: tool inventory, schema, execution shape, filtering

---

## Startup flow (cold start)

### 1) Early parallel startup work (`main.tsx`)

`main.tsx` intentionally starts performance-sensitive work before most imports finish:

- startup profiling checkpoints
- MDM reads in parallel
- keychain prefetch in parallel
- growthbook/feature machinery, policy limits, managed settings, plugin + MCP loading paths

This is a "hide latency under import time" approach, not naive sequential init.

### 2) Initialization (`entrypoints/init.ts`)

`init()` (memoized) handles:

- config enable/parse + safe env var application
- CA certs and proxy/mTLS setup
- graceful shutdown hooks
- async repo/IDE/environment detection
- optional remote managed settings + policy limits loading
- telemetry initialization strategy (deferred and trust-aware)
- optional upstream proxy startup for remote mode

Notable pattern: heavy telemetry/OpenTelemetry modules are lazily imported so CLI startup stays snappy.

### 3) Session setup (`setup.ts`)

`setup()` covers:

- Node version gate
- session ID switching
- optional UDS messaging socket startup
- worktree creation/selection + tmux integration
- hook config snapshot and file-change watcher init
- lazy background jobs (session memory, context collapse, team memory watcher)
- analytics sink init and startup beacons
- bypass-permissions safety checks (root/sandbox/network conditions)

This is where operational safety policy intersects with user ergonomics.

---

## Turn execution flow (core "brainstem")

### QueryEngine + query loop split

- `QueryEngine` owns conversation/session state across turns (messages, usage, denials, file state cache, replay behavior, persistence toggles).
- `query.ts` performs the per-turn iterative loop: API call -> parse stream -> run tools -> append results -> continue/stop.

This split is a clean architectural boundary:

- `QueryEngine`: lifecycle and state ownership
- `query.ts`: state-machine-like execution and transitions

### Streaming + tool interleaving

`query.ts` supports streaming model output while tool use blocks arrive, then routes tool execution through either:

- `services/tools/StreamingToolExecutor.ts` (live concurrent-safe execution)
- `services/tools/toolOrchestration.ts` (batch/ordered execution path)

Tool execution converges through `runToolUse` (`services/tools/toolExecution.ts`) for consistent validation, hooks, permission, and error behavior.

---

## Tools subsystem

### Tool model

In `Tool.ts`, each tool has:

- `name`, aliases
- `inputSchema` / optional `outputSchema`
- `call(...)`
- permission hooks (`checkPermissions`)
- execution hints (`isConcurrencySafe`, interrupt behavior, read-only flags, etc.)

### Tool inventory assembly (`tools.ts`)

`getAllBaseTools()` enumerates built-ins and feature-gated tools:

- file ops (`FileRead`, `FileEdit`, `FileWrite`, notebook edit)
- shell (`Bash`, optional PowerShell)
- search (`Glob`, `Grep` unless embedded binaries available)
- web (`WebFetch`, `WebSearch`)
- tasking (`TodoWrite`, task CRUD)
- MCP resource tools
- Agent tool/subagents
- optional workflow/monitor/repl/proactive tools behind flags

### Filtering before exposure

Crucial behavior: deny rules can remove tools **before** sending tool schemas to the model, reducing bad tool selection loops and leakage of unavailable capability.

---

## Permissions and safety model

The permission system is layered, not single-check:

1. **Pre-tool hooks** may block/annotate
2. **Rule-based checks** (allow/deny/ask from multiple sources)
3. **Tool-specific checks** (`checkPermissions`)
4. **Mode constraints** (auto/plan/bypass/etc.)
5. **Classifier-assisted approval paths** (feature-gated)
6. **Interactive prompt queue when needed**

Key files:

- `utils/permissions/permissions.ts`
- `hooks/useCanUseTool.tsx`
- `services/tools/toolHooks.ts`
- Bash safety modules under `tools/BashTool/*`

### Bash hardening

Bash has extra defenses:

- destructive command warnings
- read-only/path/mode validation modules
- sandbox strategy selection
- semantics parsing for multi-operation approval detail

### Important safety principle

A hook saying "allow" does not blindly bypass user policy; policy/rule checks still apply. This prevents accidental escalation via hook logic.

---

## Prompt construction and system behavior

Prompt logic is extensive and modular:

- `constants/prompts.ts`
- `constants/systemPromptSections.ts`

Key design:

- system prompt sections are memoized by section key
- explicit dynamic boundary marker separates cacheable static content from dynamic/session content
- support for style/language/output constraints, safety guidance, hooks context, MCP instructions, skills context, and model-specific controls

This is a major quality lever: prompt composition is treated as first-class architecture, not a static blob.

---

## Context management and compaction

One of the biggest differentiators in this codebase.

Systems involved:

- `services/compact/autoCompact.ts`
- `services/compact/compact.ts`
- `services/compact/microCompact.ts`
- `services/compact/grouping.ts`
- `query.ts` integrations for reactive/snip compact paths (feature-gated dynamic modules)

Behavior includes:

- proactive compaction as context grows
- API-round grouping (assistant message ID boundaries) for agentic long turns
- microcompact of bulky tool results
- reactive compact/retry pathways on prompt-too-long/media-limit failures
- bookkeeping metadata around compact boundaries for transcript continuity

This likely contributes heavily to "feels like unlimited context" in practice.

---

## Memory systems

### Local/project memory (`memdir/`)

`memdir/` implements:

- `MEMORY.md`-style loading and composition
- memory path/root logic (including remote overrides)
- typed memory manifests/scanning
- relevance picker (`findRelevantMemories.ts`) that uses LLM side-query to choose useful memories

### Team memory sync (`services/teamMemorySync/`)

Features:

- local watcher + debounced sync
- checksum-based delta upload
- pull/merge behavior
- secret scanning/guardrails before team sync writes

This is more than a local note file; it's a collaborative memory product layer.

---

## MCP, plugins, and skills ecosystem

### MCP stack

Core areas:

- `services/mcp/config.ts`
- `services/mcp/client.ts`
- `services/mcp/utils.ts`
- `commands/mcp/*`

Capabilities:

- merge multiple MCP config scopes (enterprise/user/project/local/plugin/claude.ai)
- dedup by signature
- project approval gating
- policy allow/deny filtering
- runtime fetch of tools/prompts/resources

### Plugins

Core areas:

- `utils/plugins/pluginLoader.ts`
- `services/plugins/*`

Patterns:

- cache-only startup path for speed
- full-load path for installs/refresh
- versioned plugin caches and cleanup strategies
- plugin-provided commands/agents/MCP integration

### Skills

Core areas:

- `skills/loadSkillsDir.ts`
- `skills/bundled/*`
- plugin markdown skill loading path

Supports bundled + user/project/managed + plugin + (feature-gated) MCP-derived skills.

---

## Agent/subagent architecture

`tools/AgentTool/AgentTool.tsx` is a sophisticated orchestrator, not a simple wrapper.

It supports:

- built-in + custom + plugin agent definitions
- schema-driven agent launch options
- foreground and background execution
- teammate/team spawning in swarm modes
- optional isolated worktree mode and remote launch paths
- progress forwarding and async lifecycle management
- per-agent memory and MCP requirement filtering

Agent definitions and precedence/overrides are handled in `tools/AgentTool/loadAgentsDir.ts`.

---

## Remote and distributed operation

Under `remote/` and related utils:

- websocket session subscription
- permission request/response bridging
- remote send/interrupt APIs
- adapter logic for SDK-style messages in remote mode

There is also teleported/CCR-oriented logic in utils/services suggesting cloud-backed continuation and remote execution environments.

---

## Reliability patterns ("secret sauce")

If I had to isolate what makes this system feel robust in real use, it is this combination:

1. **Single execution spine for tools**  
   Most paths converge to the same validation/permission/hook/call pipeline (`runToolUse`), reducing inconsistent edge-case behavior.

2. **Permission defense in depth**  
   Rules + hooks + tool checks + mode constraints + interactive gating + classifier integration.

3. **Context survival engineering**  
   Multi-layer compaction (snip/micro/reactive/proactive) integrated with query loop and transcripts.

4. **Prompt composition as infrastructure**  
   Sectioned, cached, dynamically bounded, and policy-aware system prompt assembly.

5. **Feature-gated modularity with lazy loads**  
   Many heavy or experimental paths are behind `feature(...)` gates and dynamic imports, allowing a single codebase to host many product variants without always paying startup/runtime cost.

6. **Operational pragmatism**  
   startup prefetching, cache-only plugin reads, asynchronous preconnect, warmups, and careful fail-open/fail-closed choices depending on surface.

7. **Strong transcript/session mechanics**  
   Persistent logs, replay utilities, compact boundary handling, and session recovery paths across modes.

---

## Security posture highlights

Strengths:

- explicit permission architecture
- shell tool hardening and sandbox awareness
- trust-aware telemetry/init flow
- policy-managed settings and managed MCP handling
- team memory secret guards

Potentially sensitive areas (normal for this product class):

- shell execution and file mutation tools
- MCP servers as external capability surface
- channel/relay approval paths (trust model critical)
- plugin install/cache pipeline
- remote execution/session control paths

---

## Notable caveats in this snapshot

A few modules are referenced as `.js` dynamic imports but corresponding `.ts` source was not obvious in this checkout (for example, some compaction variants and session transcript helpers). That likely means one of:

- generated/transpiled artifacts expected from another layer, or
- partial source snapshot.

So this report is accurate for visible architecture and call sites, but some gated internals are inferred from integration points rather than direct source inspection.

---

## Bottom line

This codebase is a production-grade agent runtime with:

- a deep tool ecosystem
- careful permission and safety controls
- advanced context/compaction machinery
- extensibility through MCP/plugins/skills/agents
- robust startup/session/telemetry architecture

The "secret sauce" is not one trick. It is the integration quality across many hard problems: tool reliability, permission UX, context longevity, extensibility, and performance-aware runtime engineering.


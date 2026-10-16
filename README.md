# Agentic Batch Loop Engine: Fault-Tolerant Batch Workflow Orchestrator for AI Agents

> **The "Iron Man Suit" for long-running agent tasks.** Checkpointed state, automatic retries, and clean concurrency for autonomous bulk workflows — resume at item 1,501 after a crash at 1,500.

## The Problem

AI agents handle single tasks well but fall apart at scale. Ask an agent to *"generate 25 SEO pages"* or *"process 500 CSV rows"* and it typically fails from:

- **Context window overflow** — item 1 is forgotten by item 10.
- **Timeouts** — the environment kills long-running processes.
- **Fragility** — one API error crashes the entire batch, losing all progress.

## The Solution

The Agentic Batch Loop Engine is a lightweight, host-native runtime that gives your agent **resilient memory**. It turns a failable single-shot action into a five-phase lifecycle — **Discover → Queue → Work → Checkpoint → Verify → Cleanup** — where every item is tracked, retried, and resumable.

## Architecture

```text
                    +------------------+
                    |     DISCOVER     |  scanner.ts: contentPatterns +
                    |  (intent-aware)  |  perspectives (developer/owner/user)
                    +--------+---------+
                             |  data.json (batch list)
                             v
                    +--------+---------+
                    |       QUEUE      |  pending -> processing
                    +--------+---------+
                             |
              +--------------+--------------+
              |                             |
     +--------v---------+          +--------v---------+
     |    WORKER 1      |   ...    |    WORKER N      |  concurrency: 1 = safe
     |  (idempotent)    |          |  (idempotent)    |  sequential; 5+ = fast I/O
     +--------+---------+          +--------+---------+
              |                             |
              +--------------+--------------+
                             v
                    +--------+---------+
                    |    CHECKPOINT    |  saved after EVERY item (atomic)
                    | checkpoint.json  |  completedCount / failedCount
                    +--------+---------+
                             |
          +------------------+-------------------+------------------+
          |                  |                   |                  |
          v                  v                   v                  v
   +------+------+    +------+------+    +------+------+    +------+------+
   |   RETRY     |    |  TIMEOUT    |    |  AWAITING   |    |   VERIFY    |
   | maxRetries  |    |itemTimeoutMs|    |   _AGENT    |    | re-scan for |
   | then failed |    | item=>failed|    | human parks |    | signature;  |
   +-------------+    +-------------+    | with prompt |    | then CLEANUP|
                                         +-------------+    | (user asked)|
                                                            +-------------+
   RESUME: restart from checkpoint.json — completed items are skipped.

   100k-item notes: keep ctx.log() lines short (logs accumulate per item);
   track progress by polling checkpoint.json externally (progress callback
   pattern); treat checkpoint mtime as a heartbeat — stale mtime = stalled
   run, safe to restart since completed work is never redone.
```

## Quick Start

### 1. Install

Clone into your project's skills directory — or register it with one command:

```bash
# In your project root
mkdir -p .agent/skills
git clone https://github.com/DG10-Agency/Agentic-Batch-Loop-Engine-by-DG10.Agency.git .agent/skills/batch-loop-engine
# No npm install needed inside the skill for the core engine!
```

```bash
npx skills add DG10-Agency/Agentic-Batch-Loop-Engine-by-DG10.Agency
```

> Zero-dependency core (v1.1.0): engine, scanner, logger, and LLM bridge
> are stdlib-only — `core/llm.ts` reads `process.env` directly, no imports
> to install. Callers load their own `.env` if they use files for config.

### 2. Run the 5-phase lifecycle

1. **Understand** — pin the target signature (e.g. files containing `<Button`).
2. **Discover** — build the batch list with the scanner:
   ```typescript
   const targets = scanProject({ rootDir: '.', contentPatterns: ['<Button'] });
   ```
3. **Apply** — run the engine with one idempotent worker per item.
4. **Verify** — re-scan for the signature; leftovers carry `lastError` in the checkpoint.
5. **Cleanup** — on `cleanupReady: true`, ask before deleting temp files.

## Core Concepts

### The Item

The unit of work — anything JSON-serializable. Statuses flow
`pending → processing → completed`, or `failed` after `maxRetries`, or
`awaiting_agent` when a human must step in (carries a `pendingPrompt`).

```typescript
{ id: "item-1", data: { filePath: "src/button.ts" }, status: "pending", attempts: 0 }
```

### The Worker

A function that takes **one item** and processes it. Two rules:

- **Idempotent** — safe to run twice (retries + resume guarantee at-least-once).
- **Contextual** — uses `ctx.log()` for a short audit trail per item.

### The Engine

The orchestrator: owns the queue, concurrency, retries, timeouts, and the
checkpoint file. Crash anywhere — restart and completed items are skipped.

## Configuration

| Option | Type | Default | What it does |
|---|---|---|---|
| `inputPath` | string | — | Path to the input `data.json` batch list. |
| `checkpointPath` | string | — | Where `checkpoint.json` state is saved (atomic tmp+rename writes). |
| `inputData` | array | — | Inline items instead of loading from file. |
| `concurrency` | number | `1` | Parallel workers. `1` = safe sequential; `5+` = fast I/O-bound tasks. |
| `maxRetries` | number | `3` | Retries per item before it is marked `failed`. Exact counters recomputed from item states on load. |
| `itemTimeoutMs` | number | none | Per-item timeout; exceeded items fail without stalling the batch. |
| `onProgress` / `progressEvery` | callback / number | off / `100` | `onProgress(done, total)` fires every N settled items and once at the end. |
| `awaiting_agent` drain | methods | — | `listAwaiting()` + `resolveAwaiting(id, result)` park and resume human-gated items without blocking the batch. |

```typescript
const engine = new LoopEngine({
  inputPath: './data.json',
  checkpointPath: './checkpoint.json',
  concurrency: 5,
  maxRetries: 3,
  itemTimeoutMs: 60000,
});
```

## 100k-Scale Guarantees

- **Atomic per-item checkpointing** — every completed item is durable before
  the next starts; a kill at item 99,999 loses at most one item.
- **Bounded retries + timeouts** — one poisoned item can never stall the batch.
- **Capped logs** — the engine keeps at most 20 log lines per item
  (`MAX_ITEM_LOGS`), dropping the oldest first and recording
  `logsDropped`; still keep `ctx.log()` lines short at 100k scale.
- **External progress + heartbeat** — poll `checkpoint.json`
  (`completedCount`/`failedCount`) for progress, or pass `onProgress` /
  `progressEvery`; its mtime is your heartbeat.
- **Human-in-the-loop without blocking** — `awaiting_agent` parks hard items
  with a prompt while the rest of the batch keeps moving.

## Scenarios

100+ ready-made starter prompts live in [SCENARIOS.md](./SCENARIOS.md):
security audits, SEO/content at scale, data enrichment, visual QA, and
developer-experience refactors.

## Audits Welcome, Execution Included: a Separate but Linked Skill

Finding problems and fixing them at scale are two different jobs. For the
**audit** half, we recommend the
**ready-to-ship-audit-agent-skill** — a deep production-readiness auditor
that scores codebases and emits prioritized fix-plans:

- Auditor skill: <https://github.com/DG10-Agency/ready-to-ship-audit-agent-skill>
- This engine: the runtime that **executes** those fix-plans item-by-item,
  with retries, evidence logs, and resume.

Typical flow: run the audit skill to get the fix-plan → feed each finding
as a batch item into this engine → verify → ship.

---
name: agentic-batch-loop-engine
description: Fault-tolerant batch loop engine for long agent jobs.
version: 0.1.0
author: shubham-dg10 (https://github.com/shubham-dg10)
license: MIT
platforms: [linux, macos, windows]
metadata:
  hermes:
    tags: [batch-processing, workflow-orchestrator, checkpoint-resume, retries, automation]
---

# Agentic Batch Loop Engine

Fault-tolerant runtime for **long-loop execution over thousands of items**
(files, records, URLs). State is checkpointed after *every* item, so a crash
at item 1,500 resumes at 1,501 — never from zero.

## When to Use

Use this skill when the task is a **long loop**: the same worker applied to
many items, where a single-shot agent would time out, overflow context, or
lose progress on the first error.

- Bulk file modification across hundreds/thousands of files.
- Batch data enrichment, migration, or CSV processing.
- AI content generation at scale (dozens of pages/posts).
- Security/refactor audits file-by-file with per-item findings.
- URL-by-URL QA, scraping, or screenshot passes.

### Anti-triggers (do NOT use)

- Single-file or single-task work — plain agent work, no engine needed.
- Real-time / interactive flows (chat, watch mode) — this engine is batch-only.
- Jobs needing items added mid-run (dynamic queue) — not supported; split into runs.
- Exactly-once side effects (sending email, charging) — retries make workers
  run at-least-once; use only with idempotent workers.

## Coexistence

When co-installed with breadth scanners or audit skills, **breadth scanners
run first** (they find targets fast in one pass); **this engine owns
long-loop execution** (it works through large target lists with retries,
timeouts, and resume). Scan first, loop second.

## The Lifecycle: Discover → Apply → Verify → Cleanup

### Phase 1: Understand & Research

Pin down intent: what is the target signature?

- *Intent*: replace `<OldButton` with `<NewButton color="blue" />`.
- *Signature*: files containing the string `<OldButton`.

### Phase 2: Intent-Aware Discovery

Build the batch list with `scanner.ts` + `contentPatterns` so only files
carrying the signature become items. Sort risk-first with `criticalDirs`.

```typescript
import { scanProject, generateInputFile } from '{path-to-skill}/core/scanner';

const targets = scanProject({
  rootDir: process.cwd(),
  extensions: ['.tsx', '.jsx'],
  contentPatterns: ['<OldButton'],
  perspectives: ['developer'],
});

generateInputFile(targets, './scripts/button-fix/data.json');
```

### Phase 3: Apply Modification

Run the engine with one idempotent worker per item. State saves after
*every* item — crash at 1,500, resume at 1,501.

```typescript
const engine = new LoopEngine({
  inputPath: './data.json',
  checkpointPath: './checkpoint.json',
  concurrency: 5,      // 1 = safe sequential; 5+ = fast I/O-bound
  maxRetries: 3,
  itemTimeoutMs: 60000,
});
```

Worker rules: idempotent (safe to run twice), short `ctx.log()` lines
(logs accumulate per item — cap them), return findings per item.
Failed items get `failed` status; items needing a human get
`awaiting_agent` with a `pendingPrompt` — the loop never blocks on them.

### Phase 4: Verify

Re-scan with the same signature. `<OldButton` gone everywhere = done.
Anything left is listed in `checkpoint.json` with `lastError` and
`attempts` per item — retry or investigate those, not the whole batch.

### Phase 5: Cleanup

`cleanupReady: true` in the checkpoint means 100% success. Ask first:

> "Done across 847 files. Delete the temp files (data.json,
> checkpoint.json, logs)?"

## Rules

1. **Host-native core**: engine, scanner, and logger use Node.js built-ins
   only — never `npm install` inside the skill folder.
2. **Zero-dependency core**: engine, scanner, logger, and LLM bridge use
   Node.js built-ins only — `core/llm.ts` reads `process.env` directly,
   no `dotenv` import. Never `npm install` inside the skill folder.
3. **FREE models only**: when the worker calls an LLM, prefer free-tier
   models and the agent's own quota via the Agent Bridge — never assume
   a paid key exists.
4. **Idempotency**: workers run at-least-once (retries + resume). A worker
   that corrupts on re-run is a bug in the worker, not the engine.
5. **At scale (100k items)**: keep `ctx.log()` lines short and few,
   poll `checkpoint.json` externally for progress/heartbeat, and keep
   concurrency I/O-bound (CPU-bound workers stay at 1–2).

## Reference: Scanner Perspectives

| Perspective | Focus |
|---|---|
| **developer** | Source code, components, API routes, library configs. |
| **owner** | `.env` files, Dockerfiles, CI workflows, billing logic. |
| **user** | `public/` assets, `robots.txt`, `sitemap.xml`, SEO metadata. |

## Reference: Checkpoint & Statuses

Item statuses: `pending` → `processing` → `completed` | `failed`
(`awaiting_agent` parks items needing a human with `pendingPrompt`).
`checkpoint.json` carries `completedCount`, `failedCount`,
`cleanupReady`, and `cleanupFiles`.

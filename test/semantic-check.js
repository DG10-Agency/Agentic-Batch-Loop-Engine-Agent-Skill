'use strict';
// Semantic check: exact accounting, awaiting drain API, log cap, onProgress,
// stateVersion, zero-dep. Stdlib only.
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const { LoopEngine } = require('../dist/core/engine.js');
const { AgentBridgeError } = require('../dist/core/llm.js');

const TMP = path.join(__dirname, 'tmp', 'semantic');
const CKPT = path.join(TMP, 'checkpoint.json');

fs.rmSync(TMP, { recursive: true, force: true });
fs.mkdirSync(TMP, { recursive: true });
// dummy inputPath satisfies the required field; inputData is what actually loads.
fs.writeFileSync(path.join(TMP, 'input.json'), '[]');

async function main() {
  const progressCalls = [];
  const engine = new LoopEngine({
    inputPath: path.join(TMP, 'input.json'),
    checkpointPath: CKPT,
    concurrency: 2,
    maxRetries: 1,
    progressEvery: 2,
    onProgress: (done, total) => progressCalls.push([done, total]),
    inputData: [{ n: 0 }, { n: 1 }, { n: 2 }, { n: 3 }, { n: 4 }, { n: 5 }],
  });

  const worker = async (item, ctx) => {
    if (item.n === 2) throw new AgentBridgeError([{ role: 'user', content: 'think' }]);
    if (item.n === 4) { ctx.log('chatty-start'); for (let i = 0; i < 30; i++) ctx.log(`line-${i}`); return 'ok-chatty'; }
    if (item.n === 5) throw new Error('always fails');
    return `ok-${item.n}`;
  };

  await engine.run(worker);

  const cp = JSON.parse(fs.readFileSync(CKPT, 'utf-8'));
  assert.strictEqual(cp.stateVersion, 1, 'stateVersion stamped');
  assert.strictEqual(cp.completedCount, 4, 'completed exact (4 ok incl. chatty)');
  assert.strictEqual(cp.failedCount, 1, 'failed exact (maxRetries=1)');

  // Awaiting drain API
  const awaiting = engine.listAwaiting();
  assert.strictEqual(awaiting.length, 1, 'one parked item');
  assert.strictEqual(awaiting[0].data.n, 2, 'parked item is n=2');
  assert.strictEqual(engine.resolveAwaiting('nope', 'x'), false, 'unknown id -> false');
  assert.strictEqual(engine.resolveAwaiting(awaiting[0].id, 'agent-result'), true, 'resolve with result');
  const cp2 = JSON.parse(fs.readFileSync(CKPT, 'utf-8'));
  assert.strictEqual(cp2.completedCount, 5, 'recount after resolve (no double count)');
  assert.strictEqual(engine.listAwaiting().length, 0, 'queue drained');

  // Log cap: newest 20 kept, oldest dropped with counter
  const chatty = cp2.items.find((i) => i.data.n === 4);
  assert.strictEqual(chatty.logs.length, 20, 'logs capped at 20');
  assert.strictEqual(chatty.logsDropped, 11, 'dropped oldest counted (31 logged - 20 kept)');
  assert.strictEqual(chatty.logs[19], 'line-29', 'newest entry kept');

  // onProgress: 6 settled, every 2 -> [2,6],[4,6],[6,6]
  assert.deepStrictEqual(progressCalls, [[2, 6], [4, 6], [6, 6]], 'progress every N + final');

  // Zero-dep: nothing in runtime dependencies (dotenv lie gone)
  const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'package.json'), 'utf-8'));
  assert.deepStrictEqual(pkg.dependencies || {}, {}, 'zero runtime dependencies');
  const llmSrc = fs.readFileSync(path.join(__dirname, '..', 'core', 'llm.ts'), 'utf-8');
  assert.ok(!/from ['"]dotenv['"]|require\(['"]dotenv['"]\)/.test(llmSrc), 'no dotenv import in llm.ts');

  // Resume is idempotent: re-run changes nothing, counts stay exact
  const engine2 = new LoopEngine({
    inputPath: path.join(TMP, 'input.json'),
    checkpointPath: CKPT,
    concurrency: 2,
    maxRetries: 1,
    inputData: [{ n: 0 }],
  });
  await engine2.run(worker);
  const cp3 = JSON.parse(fs.readFileSync(CKPT, 'utf-8'));
  assert.strictEqual(cp3.completedCount, 5, 'resume does not double-count');
  assert.strictEqual(cp3.failedCount, 1, 'resume keeps failed exact');

  console.log('semantic-check: PASS (accounting, drain API, log cap, progress, stateVersion, zero-dep, idempotent resume)');
}

main().catch((e) => { console.error('semantic-check: FAIL', e); process.exit(1); });

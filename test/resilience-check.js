'use strict';
// Resilience proof: real kill mid-run, then resume on the same checkpoint.
// Phase 1 (no RESUME): child crashes with exit 1 after 2 completions.
// Phase 2 (RESUME=1):   same script resumes -> all 10 complete, counts exact.
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const TMP = path.join(__dirname, 'tmp', 'resilience');
const CKPT = path.join(TMP, 'checkpoint.json');

fs.rmSync(TMP, { recursive: true, force: true });
fs.mkdirSync(TMP, { recursive: true });
fs.writeFileSync(path.join(TMP, 'input.json'), '[]');

function runChild(resume) {
  return spawnSync(process.execPath, [path.join(__dirname, 'crash-run.js'), CKPT], {
    env: { ...process.env, ...(resume ? { RESUME: '1' } : {}) },
    encoding: 'utf-8',
  });
}

const phase1 = runChild(false);
assert.notStrictEqual(phase1.status, 0, 'phase 1 must die mid-run (simulated kill)');
assert.ok(fs.existsSync(CKPT), 'checkpoint exists after kill');
// Atomic-write proof: the file left by the kill parses as whole JSON.
const mid = JSON.parse(fs.readFileSync(CKPT, 'utf-8'));
const midDone = mid.items.filter((i) => i.status === 'completed').length;
assert.ok(midDone >= 2, `progress survived the kill (completed=${midDone})`);
console.log(`resilience: killed mid-run, checkpoint intact with ${midDone} completed`);

const phase2 = runChild(true);
if (phase2.status !== 0) {
  console.error(phase2.stdout, phase2.stderr);
  assert.strictEqual(phase2.status, 0, 'phase 2 (resume) must exit 0');
}

const final = JSON.parse(fs.readFileSync(CKPT, 'utf-8'));
const completedItems = final.items.filter((i) => i.status === 'completed').length;
assert.strictEqual(completedItems, 10, 'all 10 items completed after resume');
assert.strictEqual(final.completedCount, 10, 'completedCount exact (no double count)');
assert.strictEqual(final.failedCount, 0, 'failedCount exact');
assert.ok(!fs.existsSync(`${CKPT}.tmp`), 'no tmp file left behind (atomic rename)');
console.log('resilience-check: PASS (kill mid-run -> resume -> 10/10, counts exact, no partial JSON)');

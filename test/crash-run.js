'use strict';
// Phase worker for the resilience proof. Run by resilience-check.js as a child:
//   - without RESUME=1: crashes (process.exit(1)) mid-run after 2 completions.
//   - with RESUME=1:    runs to completion on the same checkpoint file.
const path = require('path');
const { LoopEngine } = require('../dist/core/engine.js');

const CKPT = process.argv[2];
const TOTAL = 10;
const items = Array.from({ length: TOTAL }, (_, i) => ({ n: i }));

const engine = new LoopEngine({
  inputPath: path.join(path.dirname(CKPT), 'input.json'),
  checkpointPath: CKPT,
  concurrency: 2,
  maxRetries: 3,
  inputData: items,
});

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  await engine.run(async (item) => {
    if (process.env.RESUME !== '1') {
      // Crash once 2 items have settled (read from the checkpoint on disk).
      const cp = require('fs').existsSync(CKPT)
        ? JSON.parse(require('fs').readFileSync(CKPT, 'utf-8'))
        : { items: [] };
      const completed = cp.items.filter((i) => i.status === 'completed').length;
      if (completed >= 2) {
        console.log(`crash-run: simulating kill after ${completed} completions`);
        process.exit(1);
      }
    }
    await sleep(50);
    return `ok-${item.n}`;
  });
  console.log('crash-run: finished cleanly');
}

main().catch((e) => { console.error('crash-run: FAIL', e); process.exit(2); });

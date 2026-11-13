/* The stub JS kernel executes the "sub" and "add" action ops. */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const stub = path.join(root, 'fixtures', 'stub-core.mjs');

function arithIr(op) {
  return {
    ir: '0.1',
    app: 'Arith',
    state: [
      { name: 'total', type: 'int', init: 10 },
      { name: 'step', type: 'int', init: 3 },
    ],
    tree: {
      id: 0,
      kind: 'Button',
      props: { label: 'go' },
      children: [],
      events: { tap: { op, target: 'total', valueFrom: 'step' } },
    },
    theme: {},
  };
}

test('stub kernel subtracts sub and adds add state values', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'opurom-debug-sub-'));
  try {
    for (const [op, expected] of [['sub', 7], ['add', 13]]) {
      const file = path.join(dir, `${op}.opuir.json`);
      fs.writeFileSync(file, JSON.stringify(arithIr(op)));
      const run = spawnSync(process.execPath, [stub, file], {
        encoding: 'utf8',
        input: 'tap 0\nstate\nquit\n',
      });
      assert.equal(run.status, 0, run.stderr);
      assert.match(
        run.stdout,
        new RegExp(`"name":"total","value":${expected}`),
        `${op}: expected ${expected} in ${run.stdout}`,
      );
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { runArchCheck } from '../../src/core/arch-check.ts';

function makeTempProject(files: Record<string, string>): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'uplift-arch-'));
  for (const [rel, content] of Object.entries(files)) {
    const full = path.join(dir, rel);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, content);
  }
  return dir;
}

test('arch-check passes on clean layered modules', () => {
  const dir = makeTempProject({
    'src/shared/a.ts': 'export const A = 1;\n',
    'src/domain/b.ts': "import { A } from '../shared/a.ts';\nexport const B = A + 1;\n",
    'src/core/c.ts': "import fs from 'node:fs';\nimport { B } from '../domain/b.ts';\nexport const C = [fs, B];\n",
  });
  const res = runArchCheck(dir);
  assert.equal(res.ok, true);
  assert.equal(res.violations.length, 0);
});

test('arch-check rejects node:* in src/domain/ and third-party imports', () => {
  const dir = makeTempProject({
    'src/domain/bad.ts': "import fs from 'node:fs';\nimport lodash from 'lodash';\nexport const X = [fs, lodash];\n",
  });
  const res = runArchCheck(dir);
  assert.equal(res.ok, false);
  const rules = new Set(res.violations.map((v) => v.rule));
  assert.ok(rules.has('no-node-in-domain'));
  assert.ok(rules.has('zero-third-party-runtime-imports'));
});

test('arch-check detects circular dependencies and missing .ts extension', () => {
  const dir = makeTempProject({
    'src/domain/a.ts': "import { B } from './b.ts';\nexport const A = B;\n",
    'src/domain/b.ts': "import { A } from './a.ts';\nexport const B = A;\n",
    'src/core/c.ts': "import { A } from '../domain/a';\nexport const C = A;\n",
  });
  const res = runArchCheck(dir);
  assert.equal(res.ok, false);
  const rules = new Set(res.violations.map((v) => v.rule));
  assert.ok(rules.has('no-circular-dependencies'));
  assert.ok(rules.has('explicit-ts-extension'));
});

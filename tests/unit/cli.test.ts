import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

const CLI_PATH = path.resolve(process.cwd(), 'src', 'cli.ts');

function runCliCmd(
  args: readonly string[],
  cwd: string
): { readonly status: number | null; readonly stdout: string; readonly stderr: string } {
  const res = spawnSync(process.execPath, [CLI_PATH, ...args], {
    cwd,
    encoding: 'utf8',
  });
  return {
    status: res.status,
    stdout: res.stdout ?? '',
    stderr: res.stderr ?? '',
  };
}

test('CLI audit --json, publish, and query work end-to-end on a fixture repository', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'uplift-cli-'));
  fs.writeFileSync(
    path.join(tmp, 'package.json'),
    JSON.stringify({ name: 'fixture', dependencies: {}, scripts: { test: 'node --test' } })
  );
  fs.mkdirSync(path.join(tmp, 'tests'), { recursive: true });
  fs.writeFileSync(
    path.join(tmp, 'tests', 'sample.test.ts'),
    'import test from "node:test"; test("ok", () => {});\n'
  );

  // Seal lockfile on fixture
  const lockRes = runCliCmd(['proof', 'lock', '--repo', tmp, '--json'], tmp);
  assert.equal(lockRes.status, 0);
  const lockJson = JSON.parse(lockRes.stdout);
  assert.equal(lockJson.schemaVersion, 1);

  // Publish JSON API + cockpit into _site
  const pubRes = runCliCmd(
    ['publish', '--repo', tmp, '--out', path.join(tmp, '_site'), '--json'],
    tmp
  );
  assert.equal(pubRes.status, 0);
  assert.ok(fs.existsSync(path.join(tmp, '_site', 'data', 'status.json')));
  assert.ok(fs.existsSync(path.join(tmp, '_site', 'data', 'audit.json')));
  assert.ok(fs.existsSync(path.join(tmp, '_site', 'llms.txt')));
  assert.ok(fs.existsSync(path.join(tmp, '_site', 'index.html')));

  // Run first-class agentic query against published JSON directory
  const qRes = runCliCmd(
    [
      'query',
      'proof.ok',
      '--repo',
      tmp,
      '--data',
      path.join(tmp, '_site', 'data'),
    ],
    tmp
  );
  assert.equal(qRes.status, 0);
  const qJson = JSON.parse(qRes.stdout);
  assert.equal(qJson.found, true);
  assert.equal(qJson.value, true);
});

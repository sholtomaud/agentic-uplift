/**
 * Mechanical round-trip proof: every whole-file fix emitted by runUpliftAudit,
 * applied back onto a synthetic repository and re-scanned with the real local
 * scanner, must turn its targeted setup check green without regressing any
 * other check (pinned actions, least-privilege permissions, checkout
 * credentials, branch ruleset status-check names).
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { scanLocalRepository } from '../../src/core/local-scanner.ts';
import { DEFAULT_TEST_PATTERNS, DEFAULT_TEST_ROOTS } from '../../src/core/proof-io.ts';
import {
  buildManualUpliftCommands,
  requiredStatusCheckNames,
  runUpliftAudit,
} from '../../src/domain/audit-engine.ts';
import type { AuditCheck, AuditFix, RepoProfile } from '../../src/shared/audit-types.ts';

const BASE_CI = `name: CI
on:
  pull_request:
permissions:
  contents: read
jobs:
  test:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1 # v7.0.1
        with:
          persist-credentials: false
      - run: make test
`;

type Files = Readonly<Record<string, string>>;

const PROFILES: Readonly<Record<string, Files>> = {
  npm: {
    'package.json': JSON.stringify({ name: 'fx', dependencies: { left: '1.0.0' }, scripts: { test: 'node --test' } }),
    'package-lock.json': JSON.stringify({
      lockfileVersion: 3,
      packages: { '': { name: 'fx' }, 'node_modules/left': { hasInstallScript: true } },
    }),
    'tests/a.test.js': "import test from 'node:test'; test('a', () => {});\n",
  },
  python: {
    'requirements.txt': 'requests==2.32.0\n',
    'tests/test_a.py': 'def test_a():\n    assert True\n',
  },
  go: {
    'go.mod': 'module example.com/fx\n\ngo 1.23\n',
    'go.sum': '',
    'a_test.go': 'package fx\n',
  },
  rust: {
    'Cargo.toml': '[package]\nname = "fx"\nversion = "0.1.0"\n',
    'Cargo.lock': '',
    'tests/a.rs': '#[test]\nfn a() {}\n',
  },
  multi: {
    'package.json': JSON.stringify({ name: 'fx', dependencies: { left: '1.0.0' } }),
    'package-lock.json': JSON.stringify({ lockfileVersion: 3, packages: {} }),
    'requirements.txt': 'requests==2.32.0\n',
    'go.mod': 'module example.com/fx\n',
    'Cargo.toml': '[package]\nname = "fx"\n',
  },
  'zero-dep': {
    'package.json': JSON.stringify({ name: 'fx', dependencies: {} }),
    'tests/a.test.ts': "import test from 'node:test'; test('a', () => {});\n",
  },
};

function git(cwd: string, args: readonly string[]): void {
  const res = spawnSync('git', args, { cwd, encoding: 'utf8' });
  assert.equal(res.status, 0, `git ${args.join(' ')} failed: ${res.stderr}`);
}

function materialize(files: Files): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'uplift-roundtrip-'));
  git(dir, ['init', '-q', '-b', 'main']);
  const all: Record<string, string> = { '.github/workflows/ci.yml': BASE_CI, ...files };
  for (const [rel, content] of Object.entries(all)) {
    fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
    fs.writeFileSync(path.join(dir, rel), content);
  }
  return dir;
}

/** Only shell fixes that are safe and deterministic offline are executed. */
const SAFE_SHELL_FIXES = new Set(['git config core.hooksPath .githooks']);

function applyFix(dir: string, fix: AuditFix): boolean {
  if (fix.path === '') {
    if (fix.language !== 'shell' || !SAFE_SHELL_FIXES.has(fix.content)) return false;
    git(dir, fix.content.split(' ').slice(1));
    return true;
  }
  const target = path.join(dir, fix.path);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, fix.content, { mode: fix.path.startsWith('.githooks/') ? 0o755 : 0o644 });
  return true;
}

interface RoundTrip {
  readonly before: readonly AuditCheck[];
  readonly after: readonly AuditCheck[];
  readonly afterProfile: RepoProfile;
  readonly targeted: readonly string[];
  readonly unfixed: readonly string[];
  readonly regressed: readonly string[];
}

function roundTrip(files: Files, mutate: (fix: AuditFix) => AuditFix = (f) => f): RoundTrip {
  const dir = materialize(files);
  try {
    const before = runUpliftAudit(scanLocalRepository(dir, 'owner/fx'), 'local');
    const targeted: string[] = [];
    for (const check of before) {
      if (check.kind !== 'setup' || check.status === 'pass') continue;
      const fileFixes = check.fixes.filter((f) => f.path !== '');
      if (fileFixes.length === 0) continue;
      targeted.push(check.id);
      for (const fix of check.fixes) applyFix(dir, mutate(fix));
    }
    const afterProfile = scanLocalRepository(dir, 'owner/fx');
    const after = runUpliftAudit(afterProfile, 'local');
    const status = (checks: readonly AuditCheck[], id: string): string =>
      checks.find((c) => c.id === id)?.status ?? 'absent';
    const unfixed = targeted.filter((id) => status(after, id) !== 'pass');
    const regressed = before
      .filter((c) => c.status === 'pass' && status(after, c.id) !== 'pass')
      .map((c) => c.id);
    return { before, after, afterProfile, targeted, unfixed, regressed };
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

const GUARDED = ['pinned-actions', 'workflow-permissions', 'checkout-persist-credentials'] as const;

for (const [name, files] of Object.entries(PROFILES)) {
  test(`round-trip (${name}): every file fix turns its setup check green with zero regressions`, () => {
    const rt = roundTrip(files);
    assert.ok(rt.targeted.length >= 4, `expected several targeted checks, got ${rt.targeted.join(', ')}`);
    assert.deepEqual(rt.unfixed, [], `fixes did not pass: ${rt.unfixed.join(', ')}`);
    assert.deepEqual(rt.regressed, [], `checks regressed: ${rt.regressed.join(', ')}`);
    for (const id of GUARDED) {
      assert.equal(rt.after.find((c) => c.id === id)?.status, 'pass', `${id} after round-trip`);
    }
  });
}

test('round-trip: ruleset requires check names that the fixed workflows actually produce', () => {
  const dir = materialize(PROFILES.npm);
  try {
    // Before any proof-gate workflow exists, the ruleset names the check the fix will create.
    const before = scanLocalRepository(dir, 'owner/fx');
    const proposed = requiredStatusCheckNames(before);
    const gateFix = runUpliftAudit(before).find((c) => c.id === 'pr-tamper-gate')?.fixes[0];
    assert.ok(gateFix);
    applyFix(dir, gateFix);

    const after = scanLocalRepository(dir, 'owner/fx');
    const produced = after.workflows
      .filter((w) => w.triggers.includes('pull_request'))
      .flatMap((w) => (w.jobs ?? []).map((j) => j.checkName));
    for (const context of proposed) {
      assert.ok(produced.includes(context), `ruleset requires "${context}" but PR workflows produce ${produced.join(', ')}`);
    }
    const cmd = buildManualUpliftCommands(after, runUpliftAudit(after)).find((c) => c.id === 'branch-rules');
    assert.ok(cmd);
    for (const context of requiredStatusCheckNames(after)) {
      assert.ok(cmd.command.includes(`"context": "${context}"`));
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// --- Negative canaries: broken snippets must fail the round-trip assertions ---

test('canary: an unpinned action in a fix snippet is caught as a regression', () => {
  const rt = roundTrip(PROFILES.npm, (fix) => ({
    ...fix,
    content: fix.content.replace(/(actions\/proof-gate)@[0-9a-f]{40}[^\n]*/, '$1@v1'),
  }));
  assert.ok(rt.regressed.includes('pinned-actions'));
});

test('canary: a workflow snippet without permissions is caught as a regression', () => {
  const rt = roundTrip(PROFILES.python, (fix) =>
    fix.path.startsWith('.github/workflows/')
      ? { ...fix, content: fix.content.replace(/permissions:\n\s+contents: read\n/, '') }
      : fix
  );
  assert.ok(rt.regressed.includes('workflow-permissions'));
});

test('canary: a checkout snippet that persists credentials is caught as a regression', () => {
  const rt = roundTrip(PROFILES.go, (fix) =>
    fix.path.startsWith('.github/workflows/')
      ? { ...fix, content: fix.content.replace(/\n\s+with:\n\s+persist-credentials: false/, '') }
      : fix
  );
  assert.ok(rt.regressed.includes('checkout-persist-credentials'));
});

test('canary: a CODEOWNERS snippet missing workflow protection is caught as unfixed', () => {
  const rt = roundTrip(PROFILES.rust, (fix) =>
    fix.path === '.github/CODEOWNERS'
      ? { ...fix, content: fix.content.replace(/^\.github\/workflows\/.*$/m, '') }
      : fix
  );
  assert.ok(rt.unfixed.includes('codeowners-proof'));
});

test('canary: a mismatched ruleset check name is detected', () => {
  const dir = materialize(PROFILES.npm);
  try {
    const p = scanLocalRepository(dir, 'owner/fx');
    const fix = runUpliftAudit(p).find((c) => c.id === 'pr-tamper-gate')?.fixes[0];
    assert.ok(fix);
    applyFix(dir, { ...fix, content: fix.content.replace(/^(\s+)name: Proof Tamper Gate$/m, '$1name: Renamed Gate') });
    const produced = scanLocalRepository(dir, 'owner/fx')
      .workflows.flatMap((w) => (w.jobs ?? []).map((j) => j.checkName));
    assert.ok(!requiredStatusCheckNames(p).every((c) => produced.includes(c)));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('uplift-config fix never narrows test discovery below the scanner defaults', () => {
  const dir = materialize(PROFILES['zero-dep']);
  try {
    const fix = runUpliftAudit(scanLocalRepository(dir, 'owner/fx'))
      .find((c) => c.id === 'uplift-config')?.fixes[0];
    assert.ok(fix);
    const cfg: unknown = JSON.parse(fix.content);
    assert.ok(cfg && typeof cfg === 'object' && 'proofLock' in cfg);
    const lock = (cfg as { proofLock: { testRoots: string[]; testFilePatterns: string[] } }).proofLock;
    for (const r of DEFAULT_TEST_ROOTS) assert.ok(lock.testRoots.includes(r), `missing root ${r}`);
    for (const p of DEFAULT_TEST_PATTERNS) assert.ok(lock.testFilePatterns.includes(p), `missing pattern ${p}`);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

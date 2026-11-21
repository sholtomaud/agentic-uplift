import assert from 'node:assert/strict';
import test from 'node:test';
import { sha256Text } from '../../src/core/proof-io.ts';
import {
  buildProofLockfile,
  checkProofLockInvariants,
  createChangelogEntry,
  formatProofChangelogMarkdown,
  GENESIS_ATTESTATION,
  scanWeakeningDirectives,
  verifyFloorRatchet,
  verifyProofChangelogMarkdown,
  verifySnapshotAgainstLock,
} from '../../src/domain/proof-verifier.ts';

test('buildProofLockfile satisfies invariants and passes snapshot verification', () => {
  const harnessHash = sha256Text('harness-v1');
  const testHash = sha256Text('test-v1');
  const lock = buildProofLockfile(
    [
      { path: 'tests/a.test.ts', zone: 'tests', sha256: testHash },
      { path: '.githooks/pre-commit', zone: 'harness', sha256: harnessHash },
    ],
    { minUnitTests: 5, minPropertyTests: 2, minArchRules: 9, maxSkippedTests: 0 },
    sha256Text
  );

  assert.deepEqual(checkProofLockInvariants(lock, sha256Text), []);

  const okRes = verifySnapshotAgainstLock(
    {
      lock,
      lockedFileHashes: new Map([
        ['.githooks/pre-commit', harnessHash],
        ['tests/a.test.ts', testHash],
      ]),
      currentTestFiles: [
        { path: 'tests/a.test.ts', content: 'test("ok", () => {});' },
        { path: 'tests/new-additive.test.ts', content: 'test("new", () => {});' },
      ],
    },
    sha256Text
  );
  assert.equal(okRes.ok, true);
  assert.deepEqual(okRes.addedTestFiles, ['tests/new-additive.test.ts']);
});

test('verifySnapshotAgainstLock catches modified harness, deleted tests, and multi-language weakening', () => {
  const harnessHash = sha256Text('harness-v1');
  const testHash = sha256Text('test-v1');
  const lock = buildProofLockfile(
    [
      { path: '.githooks/pre-commit', zone: 'harness', sha256: harnessHash },
      { path: 'tests/a.test.ts', zone: 'tests', sha256: testHash },
    ],
    { minUnitTests: 5, minPropertyTests: 2, minArchRules: 9, maxSkippedTests: 0 },
    sha256Text
  );

  const tampered = verifySnapshotAgainstLock(
    {
      lock,
      lockedFileHashes: new Map<string, string | null>([
        ['.githooks/pre-commit', sha256Text('weakened-hook')],
        ['tests/a.test.ts', null],
      ]),
      currentTestFiles: [],
    },
    sha256Text
  );
  assert.equal(tampered.ok, false);
  const codes = new Set(tampered.violations.map((v) => v.code));
  assert.ok(codes.has('modified-harness-file'));
  assert.ok(codes.has('deleted-test-file'));

  const weakening = scanWeakeningDirectives([
    { path: 'tests/js.test.ts', content: 'test' + '.only("x", () => {})' },
    { path: 'tests/py_test.py', content: '@pytest.mark.' + 'skip\ndef test_x(): pass' },
    { path: 'tests/go_test.go', content: 'func TestX(t *testing.T) { t.' + 'Skip("later") }' },
    { path: 'tests/rs_test.rs', content: '#[' + 'ignore]\nfn test_x() {}' },
  ]);
  assert.equal(weakening.length, 4);
});

test('verifyFloorRatchet blocks lowering floors or raising skip ceiling', () => {
  const base = {
    minUnitTests: 10,
    minPropertyTests: 4,
    minArchRules: 9,
    maxSkippedTests: 0,
  };
  const regressed = {
    minUnitTests: 9,
    minPropertyTests: 4,
    minArchRules: 8,
    maxSkippedTests: 1,
  };
  const violations = verifyFloorRatchet(base, regressed);
  assert.equal(violations.length, 3);
});

test('PROOF_CHANGELOG.md hash chain validates intact entries and rejects edits', () => {
  const e1 = createChangelogEntry(
    {
      commit: 'abc1234',
      timestamp: '2026-11-21T00:00:00Z',
      rootSha256: sha256Text('root-1'),
      summary: 'Initial seal',
      verdict: 'PASS',
      previousAttestation: GENESIS_ATTESTATION,
    },
    sha256Text
  );
  const e2 = createChangelogEntry(
    {
      commit: 'def5678',
      timestamp: '2026-11-21T01:00:00Z',
      rootSha256: sha256Text('root-2'),
      summary: 'Added tests',
      verdict: 'PASS',
      previousAttestation: e1.attestationSha256,
    },
    sha256Text
  );

  const md = formatProofChangelogMarkdown([e1, e2]);
  const valid = verifyProofChangelogMarkdown(md, sha256Text);
  assert.equal(valid.valid, true);
  assert.equal(valid.entries.length, 2);

  const tampered = md.replace('Initial seal', 'Tampered summary');
  const invalid = verifyProofChangelogMarkdown(tampered, sha256Text);
  assert.equal(invalid.valid, false);
  assert.ok(invalid.errors.length > 0);
});

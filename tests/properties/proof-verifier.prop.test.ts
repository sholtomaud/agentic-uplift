import assert from 'node:assert/strict';
import test from 'node:test';
import { sha256Text } from '../../src/core/proof-io.ts';
import {
  buildProofLockfile,
  checkProofLockInvariants,
  verifyFloorRatchet,
  verifySnapshotAgainstLock,
} from '../../src/domain/proof-verifier.ts';
import { assertProperty, type Rng } from '../lib/property.ts';

test('property: any generated lockfile satisfies all ProofLock invariants and rejects unauthorized single-file tamper', () => {
  const fileEntryGen = {
    sample: (rng: Rng) => {
      const idx = rng.int(1, 50);
      const zone = rng.bool() ? ('harness' as const) : ('tests' as const);
      const filePath =
        zone === 'harness' ? `scripts/h${idx}.ts` : `tests/t${idx}.test.ts`;
      const content = `content-${idx}-${rng.int(0, 9999)}`;
      return { path: filePath, zone, content };
    },
  };

  assertProperty(
    'proof-lock-tamper-resistance',
    {
      sample: (rng) => {
        const count = rng.int(1, 6);
        const byPath = new Map<
          string,
          { readonly path: string; readonly zone: 'harness' | 'tests'; readonly content: string }
        >();
        for (let i = 0; i < count; i += 1) {
          const item = fileEntryGen.sample(rng);
          byPath.set(item.path, item);
        }
        return {
          files: [...byPath.values()],
          floors: {
            minUnitTests: rng.int(0, 50),
            minPropertyTests: rng.int(0, 20),
            minArchRules: rng.int(0, 15),
            maxSkippedTests: rng.int(0, 3),
          },
          tamperIdx: rng.int(0, Math.max(0, byPath.size - 1)),
        };
      },
    },
    ({ files, floors, tamperIdx }) => {
      const lockedEntries = files.map((f) => ({
        path: f.path,
        zone: f.zone,
        sha256: sha256Text(f.content),
      }));
      const lock = buildProofLockfile(lockedEntries, floors, sha256Text);
      assert.deepEqual(checkProofLockInvariants(lock, sha256Text), []);

      // Untampered snapshot always passes
      const cleanMap = new Map(lockedEntries.map((e) => [e.path, e.sha256]));
      const cleanRes = verifySnapshotAgainstLock(
        { lock, lockedFileHashes: cleanMap, currentTestFiles: [] },
        sha256Text
      );
      assert.equal(cleanRes.ok, true);

      // Modifying any single locked file MUST fail without authorization
      const target = lock.files[tamperIdx % lock.files.length];
      const tamperedMap = new Map(cleanMap);
      tamperedMap.set(target.path, sha256Text('mutated-by-unsupervised-agent'));
      const tamperedRes = verifySnapshotAgainstLock(
        { lock, lockedFileHashes: tamperedMap, currentTestFiles: [] },
        sha256Text
      );
      assert.equal(tamperedRes.ok, false);
    },
    { runs: 120 }
  );
});

test('property: floor ratchet rejects any strictly lower test floor or higher skip ceiling', () => {
  assertProperty(
    'floor-ratchet-monotonicity',
    {
      sample: (rng) => ({
        base: {
          minUnitTests: rng.int(1, 50),
          minPropertyTests: rng.int(1, 20),
          minArchRules: rng.int(1, 15),
          maxSkippedTests: rng.int(0, 5),
        },
        deltaUnit: rng.int(-5, 5),
        deltaProp: rng.int(-5, 5),
        deltaArch: rng.int(-5, 5),
        deltaSkip: rng.int(-2, 3),
      }),
    },
    ({ base, deltaUnit, deltaProp, deltaArch, deltaSkip }) => {
      const head = {
        minUnitTests: Math.max(0, base.minUnitTests + deltaUnit),
        minPropertyTests: Math.max(0, base.minPropertyTests + deltaProp),
        minArchRules: Math.max(0, base.minArchRules + deltaArch),
        maxSkippedTests: Math.max(0, base.maxSkippedTests + deltaSkip),
      };
      const violations = verifyFloorRatchet(base, head);
      const anyRegressed =
        head.minUnitTests < base.minUnitTests ||
        head.minPropertyTests < base.minPropertyTests ||
        head.minArchRules < base.minArchRules ||
        head.maxSkippedTests > base.maxSkippedTests;
      assert.equal(violations.length > 0, anyRegressed);
    },
    { runs: 150 }
  );
});

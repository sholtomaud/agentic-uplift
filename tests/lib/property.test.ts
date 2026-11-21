import assert from 'node:assert/strict';
import test from 'node:test';
import { assertProperty, createRng, gen } from './property.ts';

test('createRng is deterministic for identical seeds', () => {
  const a = createRng(42);
  const b = createRng(42);
  const seqA = Array.from({ length: 10 }, () => a.int(0, 1000));
  const seqB = Array.from({ length: 10 }, () => b.int(0, 1000));
  assert.deepEqual(seqA, seqB);
});

test('assertProperty shrinks failing inputs to minimal counterexample', () => {
  assert.throws(
    () => {
      assertProperty(
        'always-small-array',
        gen.array(gen.int(0, 10), 8),
        (arr) => {
          assert.ok(arr.length < 3, 'array too long');
        },
        { runs: 50, seed: 7 }
      );
    },
    (err: unknown) => {
      assert.ok(err instanceof Error);
      assert.match(err.message, /Minimal counterexample:/);
      return true;
    }
  );
});

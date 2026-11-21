import assert from 'node:assert/strict';
import test from 'node:test';
import {
  checkQueryInvariants,
  runAgentQuery,
} from '../../src/domain/query-engine.ts';
import { assertProperty } from '../lib/property.ts';

test('property: agentic JSON query filter counts match direct array filtering and satisfy invariants', () => {
  assertProperty(
    'query-filter-soundness',
    {
      sample: (rng) => {
        const statuses = ['pass', 'improve', 'missing', 'waiting'] as const;
        const n = rng.int(0, 15);
        const checks = Array.from({ length: n }, (_, idx) => ({
          id: `check-${idx}`,
          status: rng.pick(statuses),
          blocks_autonomy: rng.bool(0.4),
        }));
        const targetStatus = rng.pick(statuses);
        const targetBlocker = rng.bool();
        return { checks, targetStatus, targetBlocker };
      },
    },
    ({ checks, targetStatus, targetBlocker }) => {
      const bundle = { audit: { checks } };
      const expr = `audit.checks[status=${targetStatus},blocks_autonomy=${targetBlocker}].count`;
      const result = runAgentQuery(bundle, expr);
      assert.deepEqual(checkQueryInvariants(result), []);
      const expected = checks.filter(
        (c) => c.status === targetStatus && c.blocks_autonomy === targetBlocker
      ).length;
      assert.equal(result.found, true);
      assert.equal(result.value, expected);
    },
    { runs: 150 }
  );
});

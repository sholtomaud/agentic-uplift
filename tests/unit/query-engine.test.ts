import assert from 'node:assert/strict';
import test from 'node:test';
import {
  checkQueryInvariants,
  runAgentQuery,
} from '../../src/domain/query-engine.ts';

const SAMPLE_BUNDLE = {
  status: {
    summary: {
      autonomy: 'supervised',
      readiness_score: 82,
      proof_seal_ok: true,
    },
  },
  audit: {
    checks: [
      { id: 'proof-lock', status: 'pass', blocks_autonomy: true },
      { id: 'git-hooks', status: 'missing', blocks_autonomy: false },
      { id: 'pr-tamper-gate', status: 'missing', blocks_autonomy: true },
    ],
  },
};

test('query engine resolves nested dot paths and aggregates', () => {
  const r1 = runAgentQuery(SAMPLE_BUNDLE, 'status.summary.autonomy');
  assert.deepEqual(checkQueryInvariants(r1), []);
  assert.equal(r1.found, true);
  assert.equal(r1.value, 'supervised');

  const r2 = runAgentQuery(SAMPLE_BUNDLE, 'audit.checks.count');
  assert.equal(r2.found, true);
  assert.equal(r2.value, 3);
});

test('query engine filters arrays with multi-predicate expressions and projects fields', () => {
  const res = runAgentQuery(
    SAMPLE_BUNDLE,
    'audit.checks[status!=pass,blocks_autonomy=true].id'
  );
  assert.deepEqual(checkQueryInvariants(res), []);
  assert.equal(res.found, true);
  assert.deepEqual(res.value, ['pr-tamper-gate']);
});

test('query engine returns found=false and value=null on unknown paths', () => {
  const res = runAgentQuery(SAMPLE_BUNDLE, 'status.nonexistent.field');
  assert.deepEqual(checkQueryInvariants(res), []);
  assert.equal(res.found, false);
  assert.equal(res.value, null);
});

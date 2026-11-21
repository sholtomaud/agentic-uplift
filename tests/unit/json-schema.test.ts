import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { validateJsonSchema } from '../../src/core/json-schema.ts';
import { scanLocalRepository } from '../../src/core/local-scanner.ts';
import { verifyRepositoryProof } from '../../src/core/proof-io.ts';
import { buildAuditReport } from '../../src/domain/audit-engine.ts';
import { evaluateResolveGate } from '../../src/domain/resolve-gate.ts';
import type { GateReport } from '../../src/shared/gate-types.ts';
import type { StatusReport } from '../../src/shared/status-types.ts';

const ROOT = process.cwd();

function loadSchema(name: string): unknown {
  return JSON.parse(
    fs.readFileSync(path.join(ROOT, 'schemas', name), 'utf8')
  );
}

test('emitted status, audit, proof, and gate JSON strictly validate against schemas/*-v1.json', () => {
  const now = new Date('2026-11-21T08:00:00Z');
  const profile = scanLocalRepository(ROOT);
  const audit = buildAuditReport(profile, 'local', now);
  const proof = verifyRepositoryProof(ROOT, { now });
  const decision = evaluateResolveGate({
    issues: [],
    openPrs: [],
    ciFailingNow: [],
    proofSealOk: proof.ok,
    requireProofSeal: true,
    agenticMonthlySpend: null,
    agenticMonthlyBudget: null,
    requestedIssue: null,
    maxOpenAgentPrs: 2,
  });
  const gate: GateReport = {
    schema_version: 1,
    evaluated_at: '2026-11-21T08:00:00Z',
    repository: profile.repository,
    decision,
    constraints: {
      proof_seal_ok: proof.ok,
      require_proof_seal: true,
      open_agent_prs: 0,
      max_open_agent_prs: 2,
      ci_failing_now: [],
      agentic_monthly_spend: null,
      agentic_monthly_budget: null,
    },
  };
  const status: StatusReport = {
    schema_version: 1,
    generated_at: '2026-11-21T08:00:00Z',
    repository: profile.repository,
    mode: 'local',
    run_url: null,
    summary: {
      autonomy: audit.readiness.autonomy,
      readiness_score: audit.readiness.score,
      proof_seal_ok: proof.ok,
      blockers_count: audit.readiness.blockers.length,
      gate_proceed: decision.proceed,
      gate_reason: decision.reason,
    },
    repo: {
      default_branch: profile.defaultBranch,
      ecosystems: profile.ecosystems,
      languages: profile.languages,
      file_count: profile.fileCount,
      test_file_count: profile.testFileCount,
      zero_runtime_deps: profile.hasZeroRuntimeDeps,
    },
    issues: null,
    pulls: null,
    ci: null,
    delivery: null,
    readiness: audit.readiness,
    proof: {
      ok: proof.ok,
      root_sha256: proof.root_sha256,
      locked_files: proof.locked_files,
      violations_count: proof.violations.length,
      changelog_valid: proof.changelog.valid,
      changelog_entries: proof.changelog.count,
    },
    endpoints: {
      status: 'data/status.json',
      audit: 'data/audit.json',
      proof: 'data/proof.json',
      gate: 'data/gate.json',
      schemas: {
        status: 'schemas/status-v1.json',
        audit: 'schemas/audit-v1.json',
        proof: 'schemas/proof-v1.json',
        gate: 'schemas/gate-v1.json',
      },
    },
  };

  assert.deepEqual(validateJsonSchema(audit, loadSchema('audit-v1.json')), []);
  assert.deepEqual(validateJsonSchema(proof, loadSchema('proof-v1.json')), []);
  assert.deepEqual(validateJsonSchema(gate, loadSchema('gate-v1.json')), []);
  assert.deepEqual(
    validateJsonSchema(status, loadSchema('status-v1.json')),
    []
  );
});

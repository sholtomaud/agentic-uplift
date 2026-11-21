#!/usr/bin/env node
/**
 * Zero-dependency CLI entrypoint for `agentic-uplift`.
 * Designed for BOTH human operators and first-class programmatic agent queries (`--json`, `query`).
 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createGitHubClient } from './adapters/github-client.ts';
import { collectGitHubTelemetry } from './adapters/github-collector.ts';
import { publishUpliftSite } from './adapters/site-publisher.ts';
import { runArchCheck } from './core/arch-check.ts';
import { runStaticRulesCheck } from './core/check-rules.ts';
import { scanLocalRepository } from './core/local-scanner.ts';
import {
  appendProofChangelogEntry,
  currentGitCommitShort,
  generateAndWriteProofLock,
  loadLockfileFromDisk,
  loadUpliftConfig,
  verifyRepositoryProof,
} from './core/proof-io.ts';
import { buildAuditReport } from './domain/audit-engine.ts';
import { runAgentQuery } from './domain/query-engine.ts';
import { evaluateResolveGate } from './domain/resolve-gate.ts';
import type { AuditReport } from './shared/audit-types.ts';
import type { GateIssue, GatePr, GateReport } from './shared/gate-types.ts';
import type {
  MetricFloors,
  ObservedMetrics,
  ProofVerificationReport,
} from './shared/proof-types.ts';
import type {
  StatusReport,
  VerificationTierResult,
  VerifyReport,
} from './shared/status-types.ts';

const ACTION_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..'
);

function readFlag(args: readonly string[], name: string): string | undefined {
  const idx = args.indexOf(name);
  if (idx === -1 || idx + 1 >= args.length) return undefined;
  return args[idx + 1];
}

function hasFlag(args: readonly string[], name: string): boolean {
  return args.includes(name);
}

function parseOptionalNumber(raw: string | undefined): number | null {
  if (!raw || raw.trim() === '') return null;
  const parsed = Number(raw);
  return Number.isFinite(parsed) ? parsed : null;
}

function collectTestFilesInDir(dir: string, suffix: string): string[] {
  if (!fs.existsSync(dir)) return [];
  const files: string[] = [];
  const walk = (current: string): void => {
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.isFile() && entry.name.endsWith(suffix)) {
        files.push(full);
      }
    }
  };
  walk(dir);
  return files.sort();
}

function runNodeTestSuite(
  root: string,
  files: readonly string[]
): {
  readonly ok: boolean;
  readonly passed: number;
  readonly failed: number;
  readonly skipped: number;
  readonly output: string;
} {
  if (files.length === 0) {
    return { ok: true, passed: 0, failed: 0, skipped: 0, output: '' };
  }
  const res = spawnSync(
    process.execPath,
    ['--test', '--test-reporter=tap', ...files],
    {
      cwd: root,
      encoding: 'utf8',
    }
  );
  const output = `${res.stdout ?? ''}\n${res.stderr ?? ''}`;
  const passMatch = output.match(/# pass (\d+)/);
  const failMatch = output.match(/# fail (\d+)/);
  const skipMatch = output.match(/# skipped (\d+)/);
  const passed = passMatch ? Number.parseInt(passMatch[1], 10) : 0;
  const failed = failMatch ? Number.parseInt(failMatch[1], 10) : 0;
  const skipped = skipMatch ? Number.parseInt(skipMatch[1], 10) : 0;
  return {
    ok: res.status === 0 && failed === 0,
    passed,
    failed,
    skipped,
    output,
  };
}

function runVerificationPipeline(
  root: string,
  options: {
    readonly fast: boolean;
    readonly baseRef?: string;
    readonly allowTestChange: boolean;
    readonly allowHarnessChange: boolean;
  }
): VerifyReport {
  const tiers: VerificationTierResult[] = [];

  // Tier 1: Static anti-patterns
  const t1Start = Date.now();
  const staticRes = runStaticRulesCheck(root);
  tiers.push({
    tier: 1,
    id: 'static-rules',
    title: 'Static Escape-Hatch & Erasable-TS Rules',
    ok: staticRes.ok,
    duration_ms: Date.now() - t1Start,
    summary: staticRes.ok
      ? `${staticRes.filesChecked} file(s) clean (zero any, zero suppressions, erasable TS).`
      : `${staticRes.violations.length} static rule violation(s).`,
    details: staticRes.violations.map(
      (v) => `[${v.rule}] ${v.file}:${v.line} — ${v.message}`
    ),
  });

  // Tier 2: Architectural boundaries
  const t2Start = Date.now();
  const archRes = runArchCheck(root);
  tiers.push({
    tier: 2,
    id: 'arch-boundaries',
    title: 'Architectural Boundaries & Zero-Dep Graph',
    ok: archRes.ok,
    duration_ms: Date.now() - t2Start,
    summary: archRes.ok
      ? `${archRes.filesChecked} module(s) pass all ${archRes.ruleCount} boundary/cycle rules.`
      : `${archRes.violations.length} architectural violation(s).`,
    details: archRes.violations.map(
      (v) => `[${v.rule}] ${v.file}:${v.line} (${v.specifier}) — ${v.message}`
    ),
  });

  // Tier 3: Unit + property-based invariant proofs
  const t3Start = Date.now();
  const unitFiles = [
    ...collectTestFilesInDir(path.join(root, 'tests', 'lib'), '.test.ts'),
    ...collectTestFilesInDir(path.join(root, 'tests', 'unit'), '.test.ts'),
  ];
  const propFiles = collectTestFilesInDir(
    path.join(root, 'tests', 'properties'),
    '.prop.test.ts'
  );
  const unitRes = runNodeTestSuite(root, unitFiles);
  const propRes = runNodeTestSuite(root, propFiles);
  const testsOk = unitRes.ok && propRes.ok;
  const testDetails: string[] = [];
  if (!unitRes.ok) testDetails.push(`Unit test failures:\n${unitRes.output}`);
  if (!propRes.ok)
    testDetails.push(`Property proof failures:\n${propRes.output}`);

  tiers.push({
    tier: 3,
    id: 'tests-and-properties',
    title: 'Unit Tests & Property-Based Invariant Proofs',
    ok: testsOk,
    duration_ms: Date.now() - t3Start,
    summary: `${unitRes.passed} unit test(s) and ${propRes.passed} property proof(s) passed (${unitRes.skipped + propRes.skipped} skipped).`,
    details: testDetails,
  });

  const observedMetrics: ObservedMetrics = {
    unitTests: unitRes.passed,
    propertyTests: propRes.passed,
    archRules: archRes.ruleCount,
    skippedTests: unitRes.skipped + propRes.skipped,
  };

  // Tier 0: Cryptographic proof-lock + changelog chain + metric floor verification
  const t0Start = Date.now();
  const proofRes = verifyRepositoryProof(root, {
    baseRef: options.baseRef,
    allowTestChange: options.allowTestChange,
    allowHarnessChange: options.allowHarnessChange,
    observedMetrics,
  });
  tiers.unshift({
    tier: 0,
    id: 'proof-lock',
    title: 'Cryptographic Proof-Lock & Changelog Chain',
    ok: proofRes.ok,
    duration_ms: Date.now() - t0Start,
    summary: proofRes.ok
      ? `Seal INTACT (${proofRes.locked_files} locked files, ${proofRes.changelog.count} attested changelog entries).`
      : `${proofRes.violations.length} tamper/integrity violation(s).`,
    details: proofRes.violations.map(
      (v) => `[${v.code}] ${v.path} — ${v.message}`
    ),
  });

  return {
    schema_version: 1,
    verified_at: new Date().toISOString().replace(/\.\d+Z$/, 'Z'),
    ok: tiers.every((t) => t.ok),
    fast: options.fast,
    tiers,
    metrics: {
      unit_tests: observedMetrics.unitTests,
      property_tests: observedMetrics.propertyTests,
      arch_rules: observedMetrics.archRules,
      skipped_tests: observedMetrics.skippedTests,
    },
  };
}

async function computeControlPlaneBundle(
  root: string,
  options: {
    readonly useGitHub: boolean;
    readonly requestedIssue?: number | null;
    readonly maxOpenPrs?: number | null;
    readonly budget?: number | null;
    readonly spend?: number | null;
  }
): Promise<{
  readonly status: StatusReport;
  readonly audit: AuditReport;
  readonly proof: ProofVerificationReport;
  readonly gate: GateReport;
}> {
  const now = new Date();
  const nowIso = now.toISOString().replace(/\.\d+Z$/, 'Z');
  const config = loadUpliftConfig(root);
  const envRepo = process.env.GITHUB_REPOSITORY?.trim() || undefined;
  let profile = scanLocalRepository(root, envRepo);
  const proof = verifyRepositoryProof(root, { now });

  let mode: 'local' | 'github' = 'local';
  let issuesMetric = null;
  let pullsMetric = null;
  let ciMetric = null;
  let deliveryMetric = null;
  let openGateIssues: readonly GateIssue[] = [];
  let openGatePrs: readonly GatePr[] = [];

  const token =
    process.env.UPLIFT_TOKEN?.trim() || process.env.GITHUB_TOKEN?.trim() || '';
  if (options.useGitHub && envRepo && token) {
    mode = 'github';
    const client = createGitHubClient({
      token,
      apiUrl: process.env.GITHUB_API_URL?.trim() || 'https://api.github.com',
    });
    const extraLogins = (process.env.UPLIFT_AGENT_LOGINS ?? '')
      .split(/[\s,]+/)
      .filter(Boolean);
    const telemetry = await collectGitHubTelemetry(
      client,
      profile,
      envRepo,
      extraLogins,
      now
    );
    profile = {
      ...telemetry.profile,
      costConfigured:
        options.budget !== undefined && options.budget !== null
          ? true
          : telemetry.profile.costConfigured,
    };
    issuesMetric = telemetry.issues;
    pullsMetric = telemetry.pulls;
    ciMetric = telemetry.ci;
    deliveryMetric = telemetry.delivery;
    openGateIssues = telemetry.openGateIssues;
    openGatePrs = telemetry.openGatePrs;
  } else if (options.budget !== undefined && options.budget !== null) {
    profile = { ...profile, costConfigured: true };
  }

  const audit = buildAuditReport(profile, mode, now);

  const maxOpenAgentPrs =
    options.maxOpenPrs ?? config?.gate.maxOpenAgentPrs ?? 2;
  const requireProofSeal = config?.gate.requireProofSeal ?? true;
  const budget = options.budget ?? null;
  const spend = options.spend ?? null;

  const decision = evaluateResolveGate({
    issues: openGateIssues,
    openPrs: openGatePrs,
    ciFailingNow: profile.ciFailingNow,
    proofSealOk: proof.ok,
    requireProofSeal,
    agenticMonthlySpend: spend,
    agenticMonthlyBudget: budget,
    requestedIssue: options.requestedIssue ?? null,
    maxOpenAgentPrs,
  });

  const gate: GateReport = {
    schema_version: 1,
    evaluated_at: nowIso,
    repository: profile.repository,
    decision,
    constraints: {
      proof_seal_ok: proof.ok,
      require_proof_seal: requireProofSeal,
      open_agent_prs: openGatePrs.filter((pr) => pr.isAgent).length,
      max_open_agent_prs: maxOpenAgentPrs,
      ci_failing_now: profile.ciFailingNow,
      agentic_monthly_spend: spend,
      agentic_monthly_budget: budget,
    },
  };

  const serverUrl =
    process.env.GITHUB_SERVER_URL?.trim() || 'https://github.com';
  const runId = process.env.GITHUB_RUN_ID?.trim() || '';
  const runUrl =
    runId && envRepo ? `${serverUrl}/${envRepo}/actions/runs/${runId}` : null;

  const status: StatusReport = {
    schema_version: 1,
    generated_at: nowIso,
    repository: profile.repository,
    mode,
    run_url: runUrl,
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
    issues: issuesMetric,
    pulls: pullsMetric,
    ci: ciMetric,
    delivery: deliveryMetric,
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

  return { status, audit, proof, gate };
}

function installGitHooks(root: string): {
  readonly ok: boolean;
  readonly hooksPath: string;
  readonly message: string;
} {
  const hooksDir = path.join(root, '.githooks');
  fs.mkdirSync(hooksDir, { recursive: true });

  const preCommitPath = path.join(hooksDir, 'pre-commit');
  if (!fs.existsSync(preCommitPath)) {
    fs.writeFileSync(
      preCommitPath,
      [
        '#!/usr/bin/env bash',
        'set -euo pipefail',
        'echo "[agentic-uplift] pre-commit gate: running deterministic verification..."',
        'npm run verify:fast',
        '',
      ].join('\n'),
      { mode: 0o755 }
    );
  } else {
    fs.chmodSync(preCommitPath, 0o755);
  }

  const prePushPath = path.join(hooksDir, 'pre-push');
  if (!fs.existsSync(prePushPath)) {
    fs.writeFileSync(
      prePushPath,
      [
        '#!/usr/bin/env bash',
        'set -euo pipefail',
        'echo "[agentic-uplift] pre-push gate: running full verification & proof seal..."',
        'npm run verify',
        '',
      ].join('\n'),
      { mode: 0o755 }
    );
  } else {
    fs.chmodSync(prePushPath, 0o755);
  }

  const res = spawnSync('git', ['config', 'core.hooksPath', '.githooks'], {
    cwd: root,
    encoding: 'utf8',
  });
  return {
    ok: res.status === 0,
    hooksPath: '.githooks',
    message:
      res.status === 0
        ? 'Configured git core.hooksPath=.githooks and ensured executable pre-commit & pre-push hooks.'
        : `Failed to set git core.hooksPath: ${res.stderr}`,
  };
}

function serveStaticDir(dir: string, port: number): void {
  const mimeTypes: Readonly<Record<string, string>> = {
    '.html': 'text/html; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.js': 'text/javascript; charset=utf-8',
    '.json': 'application/json; charset=utf-8',
    '.txt': 'text/plain; charset=utf-8',
    '.svg': 'image/svg+xml',
  };

  const server = http.createServer((req, res) => {
    const rawUrl = (req.url ?? '/').split('?')[0];
    const rel = rawUrl === '/' ? 'index.html' : rawUrl.replace(/^\/+/, '');
    const resolved = path.resolve(dir, rel);
    if (!resolved.startsWith(path.resolve(dir))) {
      res.writeHead(403);
      res.end('Forbidden');
      return;
    }
    const target =
      fs.existsSync(resolved) && fs.statSync(resolved).isFile()
        ? resolved
        : path.join(dir, 'index.html');
    if (!fs.existsSync(target)) {
      res.writeHead(404);
      res.end('Not found');
      return;
    }
    const ext = path.extname(target).toLowerCase();
    res.writeHead(200, {
      'Content-Type': mimeTypes[ext] ?? 'application/octet-stream',
    });
    fs.createReadStream(target).pipe(res);
  });

  server.listen(port, '127.0.0.1', () => {
    console.log(
      `agentic-uplift cockpit serving ${dir} at http://127.0.0.1:${port}`
    );
  });
}

function writeGitHubOutputs(gate: GateReport): void {
  const outputPath = process.env.GITHUB_OUTPUT?.trim();
  if (!outputPath) return;
  const lines = [
    `proceed=${gate.decision.proceed ? 'true' : 'false'}`,
    `reason=${gate.decision.reason}`,
    `issue_number=${gate.decision.issue ? String(gate.decision.issue.number) : ''}`,
    `proof_seal_ok=${gate.constraints.proof_seal_ok ? 'true' : 'false'}`,
  ];
  fs.appendFileSync(outputPath, `${lines.join('\n')}\n`);
}

function printUsage(): void {
  console.log(
    [
      'agentic-uplift — Zero-dependency repo uplift, proof-lock, SRE & agentic query CLI',
      '',
      'Commands:',
      '  verify [--json] [--fast] [--base <ref>] [--allow-test-change] [--allow-harness-change]',
      '  audit [--json] [--only-failing] [--impact high|medium|low] [--github]',
      '  proof check [--json] [--base <ref>] [--allow-test-change] [--allow-harness-change]',
      '  proof lock [--json]',
      '  proof attest --summary "<text>" [--verdict PASS] [--json]',
      '  gate [--json] [--max-open-prs N] [--budget N] [--spend N] [--issue N] [--github] [--github-output]',
      '  status [--json] [--github]',
      '  publish [--out _site] [--github] [--json]',
      '  query <expr> [--data <dir>]',
      '  hooks install [--json]',
      '  serve [--port 4173] [--dir _site]',
    ].join('\n')
  );
}

export async function runCli(argv: readonly string[]): Promise<number> {
  const [command, subcommand] = argv;
  const jsonMode = hasFlag(argv, '--json');
  const root = path.resolve(readFlag(argv, '--repo') ?? process.cwd());

  if (!command || command === '--help' || command === '-h') {
    printUsage();
    return 0;
  }

  if (command === 'verify') {
    const report = runVerificationPipeline(root, {
      fast: hasFlag(argv, '--fast'),
      baseRef: readFlag(argv, '--base'),
      allowTestChange: hasFlag(argv, '--allow-test-change'),
      allowHarnessChange: hasFlag(argv, '--allow-harness-change'),
    });
    if (jsonMode) {
      console.log(JSON.stringify(report, null, 2));
    } else {
      for (const tier of report.tiers) {
        const badge = tier.ok ? 'PASS' : 'FAIL';
        console.log(
          `[Tier ${tier.tier} ${badge}] ${tier.title} (${tier.duration_ms}ms) — ${tier.summary}`
        );
        for (const detail of tier.details) {
          console.error(`  ${detail}`);
        }
      }
      console.log(
        report.ok
          ? '\nVerification PASSED across all tiers.'
          : '\nVerification FAILED.'
      );
    }
    return report.ok ? 0 : 1;
  }

  if (command === 'proof') {
    if (subcommand === 'lock') {
      const existing = loadLockfileFromDisk(root);
      const archRes = runArchCheck(root);
      const unitFiles = [
        ...collectTestFilesInDir(path.join(root, 'tests', 'lib'), '.test.ts'),
        ...collectTestFilesInDir(path.join(root, 'tests', 'unit'), '.test.ts'),
      ];
      const propFiles = collectTestFilesInDir(
        path.join(root, 'tests', 'properties'),
        '.prop.test.ts'
      );
      const unitRes = runNodeTestSuite(root, unitFiles);
      const propRes = runNodeTestSuite(root, propFiles);
      const floors: MetricFloors = {
        minUnitTests: Math.max(
          existing?.metricFloors.minUnitTests ?? 0,
          unitRes.passed
        ),
        minPropertyTests: Math.max(
          existing?.metricFloors.minPropertyTests ?? 0,
          propRes.passed
        ),
        minArchRules: Math.max(
          existing?.metricFloors.minArchRules ?? 0,
          archRes.ruleCount
        ),
        maxSkippedTests:
          existing?.metricFloors.maxSkippedTests ??
          unitRes.skipped + propRes.skipped,
      };
      const lock = generateAndWriteProofLock(root, floors);
      if (jsonMode) {
        console.log(JSON.stringify(lock, null, 2));
      } else {
        console.log(
          `Sealed proof-lock.json (${lock.files.length} files, rootSha256=${lock.rootSha256.slice(0, 16)}…, floors=${JSON.stringify(floors)})`
        );
      }
      return 0;
    }

    if (subcommand === 'attest') {
      const proof = verifyRepositoryProof(root);
      if (!proof.ok || !proof.root_sha256) {
        const msg = 'Cannot attest: proof-lock verification is not clean.';
        if (jsonMode) console.log(JSON.stringify({ ok: false, error: msg }));
        else console.error(msg);
        return 1;
      }
      const summary =
        readFlag(argv, '--summary') ?? 'Verified 4-tier proof seal';
      const verdict = readFlag(argv, '--verdict') ?? 'PASS';
      const entry = appendProofChangelogEntry(root, {
        commit: currentGitCommitShort(root),
        timestamp: new Date().toISOString().replace(/\.\d+Z$/, 'Z'),
        rootSha256: proof.root_sha256,
        summary,
        verdict,
      });
      if (jsonMode) console.log(JSON.stringify(entry, null, 2));
      else {
        console.log(
          `Appended attestation ${entry.attestationSha256.slice(0, 16)}… to PROOF_CHANGELOG.md`
        );
      }
      return 0;
    }

    // Default: `proof check`
    const report = verifyRepositoryProof(root, {
      baseRef: readFlag(argv, '--base'),
      allowTestChange: hasFlag(argv, '--allow-test-change'),
      allowHarnessChange: hasFlag(argv, '--allow-harness-change'),
    });
    if (jsonMode) {
      console.log(JSON.stringify(report, null, 2));
    } else if (report.ok) {
      console.log(
        `Proof lock INTACT (${report.source}, ${report.locked_files} files, root=${report.root_sha256?.slice(0, 16)}…).`
      );
    } else {
      console.error(
        `PROOF TAMPER CHECK FAILED (${report.violations.length} violation(s)):`
      );
      for (const v of report.violations) {
        console.error(`  [${v.code}] ${v.path} — ${v.message}`);
      }
    }
    return report.ok ? 0 : 1;
  }

  if (command === 'audit') {
    const bundle = await computeControlPlaneBundle(root, {
      useGitHub: hasFlag(argv, '--github'),
    });
    const onlyFailing = hasFlag(argv, '--only-failing');
    const impactFilter = readFlag(argv, '--impact');
    const filteredChecks = bundle.audit.checks.filter((c) => {
      if (onlyFailing && c.status === 'pass') return false;
      if (impactFilter && c.impact !== impactFilter) return false;
      return true;
    });
    const out: AuditReport = { ...bundle.audit, checks: filteredChecks };
    if (jsonMode) {
      console.log(JSON.stringify(out, null, 2));
    } else {
      console.log(
        `Readiness: ${out.readiness.score}% (${out.readiness.autonomy}) — ${out.readiness.passed}/${out.readiness.total} passed, ${out.readiness.blockers.length} autonomy blocker(s)`
      );
      for (const c of out.checks) {
        const tag = c.status.toUpperCase().padEnd(7);
        const blocker = c.blocks_autonomy && c.status !== 'pass' ? ' [BLOCKER]' : '';
        console.log(`  ${tag} [${c.impact}] ${c.id}${blocker}: ${c.evidence}`);
      }
      const pending = out.manual_commands.filter((m) => m.status !== 'done');
      if (pending.length > 0) {
        console.log('\nManual Uplift Commands (gh CLI / local):');
        for (const m of pending) {
          console.log(`\n  [${m.status.toUpperCase()}] ${m.title}`);
          for (const line of m.command.split('\n')) {
            console.log(`    ${line}`);
          }
        }
      }
    }
    return 0;
  }

  if (command === 'gate') {
    const bundle = await computeControlPlaneBundle(root, {
      useGitHub: hasFlag(argv, '--github'),
      requestedIssue: parseOptionalNumber(
        readFlag(argv, '--issue') ?? process.env.REQUESTED_ISSUE
      ),
      maxOpenPrs: parseOptionalNumber(
        readFlag(argv, '--max-open-prs') ?? process.env.MAX_OPEN_AGENT_PRS
      ),
      budget: parseOptionalNumber(
        readFlag(argv, '--budget') ?? process.env.MONTHLY_AGENTIC_BUDGET
      ),
      spend: parseOptionalNumber(
        readFlag(argv, '--spend') ?? process.env.MONTHLY_AGENTIC_SPEND
      ),
    });
    if (hasFlag(argv, '--github-output')) {
      writeGitHubOutputs(bundle.gate);
    }
    if (jsonMode) {
      console.log(JSON.stringify(bundle.gate, null, 2));
    } else {
      console.log(
        `Gate: proceed=${bundle.gate.decision.proceed} (${bundle.gate.decision.reason}) — ${bundle.gate.decision.message}`
      );
    }
    return 0;
  }

  if (command === 'status') {
    const bundle = await computeControlPlaneBundle(root, {
      useGitHub: hasFlag(argv, '--github'),
    });
    if (jsonMode) {
      console.log(JSON.stringify(bundle.status, null, 2));
    } else {
      const s = bundle.status.summary;
      console.log(
        `${bundle.status.repository} | autonomy=${s.autonomy} | readiness=${s.readiness_score}% | proof=${s.proof_seal_ok ? 'INTACT' : 'BROKEN'} | blockers=${s.blockers_count} | gate=${s.gate_reason}`
      );
    }
    return 0;
  }

  if (command === 'publish') {
    const outDir = path.resolve(root, readFlag(argv, '--out') ?? '_site');
    const bundle = await computeControlPlaneBundle(root, {
      useGitHub: hasFlag(argv, '--github'),
      budget: parseOptionalNumber(process.env.MONTHLY_AGENTIC_BUDGET),
      spend: parseOptionalNumber(process.env.MONTHLY_AGENTIC_SPEND),
    });
    const published = publishUpliftSite(root, ACTION_ROOT, outDir, bundle);
    if (jsonMode) {
      console.log(JSON.stringify(published, null, 2));
    } else {
      console.log(
        `Published JSON API + Web Components cockpit to ${published.outDir} (${published.filesWritten.join(', ')})`
      );
    }
    return 0;
  }

  if (command === 'query') {
    const expression = subcommand ?? '';
    if (!expression) {
      console.error('Usage: node src/cli.ts query <expression> [--data <dir>]');
      return 1;
    }
    const dataDir = readFlag(argv, '--data');
    let bundle: Record<string, unknown>;
    if (dataDir && fs.existsSync(path.resolve(root, dataDir))) {
      const base = path.resolve(root, dataDir);
      const readIfExists = (name: string): unknown => {
        const p = path.join(base, name);
        return fs.existsSync(p)
          ? JSON.parse(fs.readFileSync(p, 'utf8'))
          : null;
      };
      bundle = {
        status: readIfExists('status.json'),
        audit: readIfExists('audit.json'),
        proof: readIfExists('proof.json'),
        gate: readIfExists('gate.json'),
      };
    } else {
      bundle = await computeControlPlaneBundle(root, { useGitHub: false });
    }
    const result = runAgentQuery(bundle, expression);
    console.log(JSON.stringify(result, null, 2));
    return result.found ? 0 : 1;
  }

  if (command === 'hooks' && subcommand === 'install') {
    const res = installGitHooks(root);
    if (jsonMode) console.log(JSON.stringify(res, null, 2));
    else console.log(res.message);
    return res.ok ? 0 : 1;
  }

  if (command === 'serve') {
    const dir = path.resolve(root, readFlag(argv, '--dir') ?? '_site');
    if (!fs.existsSync(path.join(dir, 'data', 'status.json'))) {
      const bundle = await computeControlPlaneBundle(root, {
        useGitHub: false,
      });
      publishUpliftSite(root, ACTION_ROOT, dir, bundle);
    }
    const port = Number.parseInt(readFlag(argv, '--port') ?? '4173', 10);
    serveStaticDir(dir, Number.isFinite(port) ? port : 4173);
    return 0;
  }

  console.error(`Unknown command: ${command}`);
  printUsage();
  return 1;
}

if (import.meta.main) {
  runCli(process.argv.slice(2)).then((code) => {
    process.exitCode = code;
  });
}

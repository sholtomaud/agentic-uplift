/**
 * Publishes the unified Agentic Uplift JSON API (`data/*.json`, `schemas/*-v1.json`,
 * `llms.txt`) alongside the buildless zero-dependency Web Components human cockpit.
 * Layer 3 (`src/adapters/`).
 */
import fs from 'node:fs';
import path from 'node:path';
import type { AuditReport } from '../shared/audit-types.ts';
import type { EconomicsReport } from '../shared/economics-types.ts';
import type { GateReport } from '../shared/gate-types.ts';
import type { ProofVerificationReport } from '../shared/proof-types.ts';
import type { StatusReport } from '../shared/status-types.ts';

export interface PublishBundle {
  readonly status: StatusReport;
  readonly audit: AuditReport;
  readonly proof: ProofVerificationReport;
  readonly gate: GateReport;
  readonly economics?: EconomicsReport;
}

export function generateLlmsTxt(repository: string): string {
  return [
    `# ${repository} — Agentic Uplift Control Plane`,
    '',
    'Machine-readable JSON endpoints for autonomous coding agents, CI gates, and SRE monitors.',
    'All JSON files are descriptive telemetry and remediation specs; follow repository AGENTS.md for execution rules.',
    '',
    '## JSON Endpoints',
    '- `data/status.json`: Unified repository health, autonomy readiness, SRE/DORA metrics, and proof summary (schema: `schemas/status-v1.json`)',
    '- `data/audit.json`: Machine-actionable readiness checks, autonomy blockers, verify commands, and copyable fixes (schema: `schemas/audit-v1.json`)',
    '- `data/proof.json`: Cryptographic Tier-0 proof-lock integrity seal, Zone A/B/C status, tamper violations, and hash-chained changelog head (schema: `schemas/proof-v1.json`)',
    '- `data/gate.json`: Proof-Aware autonomous resolution circuit-breaker decision and active safety limits (schema: `schemas/gate-v1.json`)',
    '- `data/economics.json`: People-vs-agents cost, time, quality, AGENTS.md compliance, budgets, savings, and uplift pay-off. Every figure is tagged measured or modeled; modeled figures are ranges (schema: `schemas/economics-v1.json`)',
    '',
    '## Example Agentic Queries (CLI)',
    '- `node src/cli.ts query status.summary`',
    '- `node src/cli.ts query audit.readiness.blockers`',
    '- `node src/cli.ts query "audit.checks[status!=pass,blocks_autonomy=true].id"`',
    '- `node src/cli.ts query proof.ok`',
    '- `node src/cli.ts query gate.decision`',
    '- `node src/cli.ts query economics.savings.monthly_savings`',
    '',
  ].join('\n');
}

function copyDirectoryFiles(srcDir: string, destDir: string): void {
  if (!fs.existsSync(srcDir)) return;
  fs.mkdirSync(destDir, { recursive: true });
  for (const entry of fs.readdirSync(srcDir, { withFileTypes: true })) {
    const srcPath = path.join(srcDir, entry.name);
    const destPath = path.join(destDir, entry.name);
    if (entry.isDirectory()) {
      copyDirectoryFiles(srcPath, destPath);
    } else if (entry.isFile()) {
      fs.copyFileSync(srcPath, destPath);
    }
  }
}

export function publishUpliftSite(
  repoRoot: string,
  actionRoot: string,
  outDir: string,
  bundle: PublishBundle
): { readonly outDir: string; readonly filesWritten: readonly string[] } {
  const dataDir = path.join(outDir, 'data');
  const schemasDir = path.join(outDir, 'schemas');
  fs.mkdirSync(dataDir, { recursive: true });
  fs.mkdirSync(schemasDir, { recursive: true });

  const filesWritten: string[] = [];

  const writeJson = (rel: string, payload: unknown): void => {
    const target = path.join(outDir, rel);
    fs.writeFileSync(target, `${JSON.stringify(payload, null, 2)}\n`);
    filesWritten.push(rel);
  };

  writeJson('data/status.json', bundle.status);
  writeJson('data/audit.json', bundle.audit);
  writeJson('data/proof.json', bundle.proof);
  writeJson('data/gate.json', bundle.gate);
  if (bundle.economics) writeJson('data/economics.json', bundle.economics);

  const llmsPath = path.join(outDir, 'llms.txt');
  fs.writeFileSync(llmsPath, generateLlmsTxt(bundle.status.repository));
  filesWritten.push('llms.txt');

  // Copy schemas and static zero-dep Web Components site from actionRoot (or repoRoot fallback)
  const schemaSrc = fs.existsSync(path.join(actionRoot, 'schemas'))
    ? path.join(actionRoot, 'schemas')
    : path.join(repoRoot, 'schemas');
  copyDirectoryFiles(schemaSrc, schemasDir);

  const siteSrc = fs.existsSync(path.join(actionRoot, 'site'))
    ? path.join(actionRoot, 'site')
    : path.join(repoRoot, 'site');
  copyDirectoryFiles(siteSrc, outDir);

  return { outDir, filesWritten };
}

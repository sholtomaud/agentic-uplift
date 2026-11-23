/**
 * Zero-dependency offline local repository scanner.
 * Inspects any local git repository and produces a normalized RepoProfile
 * for the unified Agentic Uplift audit engine.
 * Layer 2 (`src/core/`).
 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import {
  AGENT_DOC_TOPICS,
  type AgentDocTopic,
  type RepoProfile,
  type WorkflowSummary,
} from '../shared/audit-types.ts';
import { isRecord } from '../shared/contracts.ts';
import { summarizeWorkflowJobs } from '../domain/workflow-jobs.ts';
import { discoverTestFiles, verifyRepositoryProof } from './proof-io.ts';

function toPosix(filePath: string): string {
  return filePath.split(path.sep).join('/');
}

const EXT_TO_LANG: Readonly<Record<string, string>> = {
  '.ts': 'TypeScript',
  '.tsx': 'TypeScript',
  '.js': 'JavaScript',
  '.mjs': 'JavaScript',
  '.py': 'Python',
  '.go': 'Go',
  '.rs': 'Rust',
  '.java': 'Java',
  '.rb': 'Ruby',
  '.sh': 'Shell',
};

const TOPIC_PATTERNS: Readonly<Record<AgentDocTopic, RegExp>> = {
  'build-and-test': /\b(?:npm\s+test|pytest|go\s+test|cargo\s+test|build|verify)\b/i,
  tdd: /\b(?:test[- ]first|tdd|failing\s+test|property[- ]based)\b/i,
  'verification-gates': /\b(?:proof-lock|tamper|pre-commit|verify|invariant|arch)\b/i,
  issues: /\b(?:issue|fixes\s+#|triage|label)\b/i,
  'commits-and-prs': /\b(?:pull\s+request|conventional\s+commit|feat:|fix:)\b/i,
  security: /\b(?:secret|untrusted|security|least[- ]privilege|credential)\b/i,
  attribution: /\b(?:co-authored-by|assisted-by|attribution)\b/i,
};

function scanFiles(root: string): string[] {
  const results: string[] = [];
  const walk = (dir: string): void => {
    if (!fs.existsSync(dir)) return;
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (
        entry.name === '.git' ||
        entry.name === 'node_modules' ||
        entry.name === 'dist' ||
        entry.name === 'coverage'
      ) {
        continue;
      }
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full);
      } else if (entry.isFile()) {
        results.push(toPosix(path.relative(root, full)));
      }
    }
  };
  walk(root);
  return results.sort();
}

function parseWorkflowSummary(
  relPath: string,
  content: string
): WorkflowSummary {
  const triggers: string[] = [];
  if (/\bpull_request\b/.test(content)) triggers.push('pull_request');
  if (/\bpush\b/.test(content)) triggers.push('push');
  if (/\bschedule\b/.test(content)) triggers.push('schedule');
  if (/\bworkflow_dispatch\b/.test(content)) triggers.push('workflow_dispatch');
  if (/\bissues\b/.test(content)) triggers.push('issues');

  const hasTests =
    /\b(?:npm\s+(?:run\s+)?(?:test|verify)|node\s+--test|node\s+src\/cli\.ts\s+verify|pytest|go\s+test|cargo\s+test)\b/.test(
      content
    );
  const hasProofGate =
    /\bproof-gate\b|\bproof\s+check\b|--verify-pr-base|proof-lock\.ts/.test(
      content
    );
  const hasResolveGate = /\bresolve-gate\b|cli\.ts\s+gate\b/.test(content);
  const hasPermissions = /^\s*permissions\s*:/m.test(content);

  const unpinnedActions: string[] = [];
  const usesRegex = /^\s*-?\s*uses\s*:\s*([^\s#]+)/gm;
  for (const match of content.matchAll(usesRegex)) {
    const ref = match[1].trim().replace(/^['"]|['"]$/g, '');
    // Local composite actions (`./...`) or docker references don't use GitHub SHAs
    if (ref.startsWith('./') || ref.startsWith('docker://')) continue;
    if (!/@[0-9a-f]{40}$/i.test(ref)) {
      unpinnedActions.push(ref);
    }
  }

  return {
    path: relPath,
    triggers,
    hasTests,
    hasProofGate,
    hasResolveGate,
    hasPermissions,
    unpinnedActions,
    jobs: summarizeWorkflowJobs(content),
  };
}

function readTextIfExists(root: string, rel: string): string | null {
  const full = path.join(root, rel);
  return fs.existsSync(full) ? fs.readFileSync(full, 'utf8') : null;
}

function detectNpmIgnoreScripts(root: string): boolean {
  const npmrc = readTextIfExists(root, '.npmrc');
  if (npmrc && /^\s*ignore-scripts\s*=\s*true\s*$/m.test(npmrc)) return true;
  const yarnrc = readTextIfExists(root, '.yarnrc.yml');
  if (yarnrc && /^\s*enableScripts\s*:\s*false\s*$/m.test(yarnrc)) return true;
  const pnpm = readTextIfExists(root, 'pnpm-workspace.yaml');
  if (pnpm && /^\s*ignoreScripts\s*:\s*true\s*$/m.test(pnpm)) return true;
  return false;
}

function readInstallScriptPackages(root: string): string[] {
  const lock = readTextIfExists(root, 'package-lock.json');
  if (!lock) return [];
  try {
    const parsed: unknown = JSON.parse(lock);
    if (!isRecord(parsed) || !isRecord(parsed.packages)) return [];
    const names = new Set<string>();
    for (const [key, value] of Object.entries(parsed.packages)) {
      if (!key || !isRecord(value) || value.hasInstallScript !== true) continue;
      const idx = key.lastIndexOf('node_modules/');
      names.add(idx === -1 ? key : key.slice(idx + 'node_modules/'.length));
    }
    return [...names].sort();
  } catch {
    return [];
  }
}

function detectGitRepositoryName(root: string): string {
  const res = spawnSync('git', ['remote', 'get-url', 'origin'], {
    cwd: root,
    encoding: 'utf8',
  });
  if (res.status === 0 && res.stdout.trim()) {
    const remote = res.stdout.trim();
    const match = remote.match(/[:/]([^/:]+\/[^/]+?)(?:\.git)?$/);
    if (match) return match[1];
  }
  return path.basename(root);
}

function detectDefaultBranch(root: string): string {
  const res = spawnSync('git', ['symbolic-ref', '--short', 'HEAD'], {
    cwd: root,
    encoding: 'utf8',
  });
  return res.status === 0 && res.stdout.trim() ? res.stdout.trim() : 'main';
}

function isHooksPathConfigured(root: string): boolean {
  const res = spawnSync('git', ['config', '--get', 'core.hooksPath'], {
    cwd: root,
    encoding: 'utf8',
  });
  return res.status === 0 && res.stdout.trim().length > 0;
}

function readPackageZeroRuntimeDeps(root: string): boolean | null {
  const pkgPath = path.join(root, 'package.json');
  if (!fs.existsSync(pkgPath)) return null;
  try {
    const parsed: unknown = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
    if (!isRecord(parsed)) return null;
    if (!('dependencies' in parsed) || parsed.dependencies === undefined) {
      return true;
    }
    if (!isRecord(parsed.dependencies)) return false;
    return Object.keys(parsed.dependencies).length === 0;
  } catch {
    return null;
  }
}

export function scanLocalRepository(
  root: string,
  repositoryOverride?: string
): RepoProfile {
  const files = scanFiles(root);
  const fileSet = new Set(files);

  const langSet = new Set<string>();
  for (const rel of files) {
    const ext = path.extname(rel).toLowerCase();
    const lang = EXT_TO_LANG[ext];
    if (lang) langSet.add(lang);
  }

  const ecosystems: string[] = [];
  if (fileSet.has('package.json')) ecosystems.push('npm');
  if (fileSet.has('pyproject.toml') || fileSet.has('requirements.txt')) {
    ecosystems.push('python');
  }
  if (fileSet.has('go.mod')) ecosystems.push('go');
  if (fileSet.has('Cargo.toml')) ecosystems.push('cargo');

  const hasLockfile =
    fileSet.has('package-lock.json') ||
    fileSet.has('pnpm-lock.yaml') ||
    fileSet.has('yarn.lock') ||
    fileSet.has('poetry.lock') ||
    fileSet.has('uv.lock') ||
    fileSet.has('go.sum') ||
    fileSet.has('Cargo.lock');

  const workflowFiles = files.filter(
    (f) => f.startsWith('.github/workflows/') && /\.ya?ml$/.test(f)
  );
  const workflows: WorkflowSummary[] = workflowFiles.map((wf) =>
    parseWorkflowSummary(wf, fs.readFileSync(path.join(root, wf), 'utf8'))
  );

  const hasProofLock = fileSet.has('proof-lock.json');
  const hasProofChangelog = fileSet.has('PROOF_CHANGELOG.md');
  const proofReport =
    hasProofLock || hasProofChangelog ? verifyRepositoryProof(root) : null;

  const codeownersFile = fileSet.has('.github/CODEOWNERS')
    ? '.github/CODEOWNERS'
    : fileSet.has('CODEOWNERS')
      ? 'CODEOWNERS'
      : null;
  let codeownersProtectsProof = false;
  if (codeownersFile) {
    const content = fs.readFileSync(path.join(root, codeownersFile), 'utf8');
    codeownersProtectsProof =
      /proof-lock\.json/.test(content) && /\.github\/workflows/.test(content);
  }

  const hasAgentsMd = fileSet.has('AGENTS.md');
  const agentsMdTopics: AgentDocTopic[] = [];
  if (hasAgentsMd) {
    const content = fs.readFileSync(path.join(root, 'AGENTS.md'), 'utf8');
    for (const topic of AGENT_DOC_TOPICS) {
      if (TOPIC_PATTERNS[topic].test(content)) {
        agentsMdTopics.push(topic);
      }
    }
  }

  const dependabotPath = fileSet.has('.github/dependabot.yml')
    ? '.github/dependabot.yml'
    : fileSet.has('.github/dependabot.yaml')
      ? '.github/dependabot.yaml'
      : null;
  let hasDependabotCooldown = false;
  if (dependabotPath) {
    const content = fs.readFileSync(path.join(root, dependabotPath), 'utf8');
    hasDependabotCooldown = /cooldown\s*:/.test(content);
  }

  const testFiles = discoverTestFiles(root);
  const hasIssueForms = files.some(
    (f) => f.startsWith('.github/ISSUE_TEMPLATE/') && /\.ya?ml$/.test(f)
  );

  return {
    repository: repositoryOverride || detectGitRepositoryName(root),
    defaultBranch: detectDefaultBranch(root),
    ecosystems,
    languages: [...langSet].sort(),
    fileCount: files.length,
    testFileCount: testFiles.length,
    hasLockfile,
    hasProofLock,
    proofLockValid: hasProofLock ? (proofReport?.ok ?? false) : null,
    hasProofChangelog,
    proofChangelogValid: hasProofChangelog
      ? (proofReport?.changelog.valid ?? false)
      : null,
    hasPreCommitHook: fileSet.has('.githooks/pre-commit'),
    hasPrePushHook: fileSet.has('.githooks/pre-push'),
    hooksPathConfigured: isHooksPathConfigured(root),
    hasCodeowners: codeownersFile !== null,
    codeownersProtectsProof,
    hasAgentsMd,
    agentsMdTopics,
    hasClaudeMd: fileSet.has('CLAUDE.md'),
    hasSecurityPolicy:
      fileSet.has('SECURITY.md') || fileSet.has('.github/SECURITY.md'),
    hasIssueForms,
    hasPrTemplate:
      fileSet.has('.github/pull_request_template.md') ||
      fileSet.has('.github/PULL_REQUEST_TEMPLATE.md'),
    hasDependabot: dependabotPath !== null,
    hasDependabotCooldown,
    hasCodeql: workflows.some((w) => /codeql/i.test(w.path)),
    hasScorecard: workflows.some((w) => /scorecard/i.test(w.path)),
    hasDependencyReview: workflows.some((w) =>
      /dependency-review/i.test(w.path)
    ),
    hasUpliftConfig: fileSet.has('uplift.config.json'),
    hasZeroRuntimeDeps: readPackageZeroRuntimeDeps(root),
    npmIgnoreScripts: detectNpmIgnoreScripts(root),
    installScriptPackages: readInstallScriptPackages(root),
    branchProtectionEnabled: null,
    workflows,
    ciPassRate: null,
    ciFailingNow: [],
    closedIssuesCount: null,
    linkedFixShare: null,
    agentAttributionCount: null,
    costConfigured: false,
  };
}

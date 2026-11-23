import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { scanLocalRepository } from '../../src/core/local-scanner.ts';
import { buildAuditReport, runUpliftAudit } from '../../src/domain/audit-engine.ts';
import { summarizeWorkflowJobs } from '../../src/domain/workflow-jobs.ts';
import type { AuditCheck, RepoProfile, WorkflowJobSummary } from '../../src/shared/audit-types.ts';

const CHECKOUT = 'actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1';

function job(overrides: Partial<WorkflowJobSummary> = {}): WorkflowJobSummary {
  return {
    name: 'build',
    checkName: 'build',
    usesSecrets: false,
    usesAgentApiKey: false,
    isAgentJob: false,
    agentShellTools: false,
    installsPackages: false,
    runsPackageScripts: false,
    usesCheckout: true,
    checkoutPersistsCredentials: false,
    pushes: false,
    socketFirewall: false,
    ...overrides,
  };
}

function profile(
  jobs: readonly WorkflowJobSummary[],
  overrides: Partial<RepoProfile> = {}
): RepoProfile {
  return {
    repository: 'owner/repo',
    defaultBranch: 'main',
    ecosystems: ['npm'],
    languages: ['TypeScript'],
    fileCount: 10,
    testFileCount: 1,
    hasLockfile: true,
    hasProofLock: false,
    proofLockValid: null,
    hasProofChangelog: false,
    proofChangelogValid: null,
    hasPreCommitHook: false,
    hasPrePushHook: false,
    hooksPathConfigured: false,
    hasCodeowners: false,
    codeownersProtectsProof: false,
    hasAgentsMd: false,
    agentsMdTopics: [],
    hasClaudeMd: false,
    hasSecurityPolicy: false,
    hasIssueForms: false,
    hasPrTemplate: false,
    hasDependabot: false,
    hasDependabotCooldown: false,
    hasCodeql: false,
    hasScorecard: false,
    hasDependencyReview: false,
    hasUpliftConfig: false,
    hasZeroRuntimeDeps: false,
    npmIgnoreScripts: false,
    installScriptPackages: [],
    branchProtectionEnabled: null,
    workflows: [
      {
        path: '.github/workflows/ci.yml',
        triggers: ['pull_request'],
        hasTests: true,
        hasProofGate: false,
        hasResolveGate: false,
        hasPermissions: true,
        unpinnedActions: [],
        jobs,
      },
    ],
    ciPassRate: null,
    ciFailingNow: [],
    closedIssuesCount: null,
    linkedFixShare: null,
    agentAttributionCount: null,
    costConfigured: false,
    ...overrides,
  };
}

function check(p: RepoProfile, id: string): AuditCheck {
  const found = runUpliftAudit(p).find((c) => c.id === id);
  assert.ok(found, `check ${id} missing`);
  return found;
}

// --- Workflow job analysis ---

test('summarizeWorkflowJobs extracts per-job secret, install, agent, checkout and firewall signals', () => {
  const yaml = `name: CI
on: [pull_request]
permissions:
  contents: read
jobs:
  build:
    runs-on: ubuntu-latest
    steps:
      - uses: ${CHECKOUT} # v7
      - run: npm ci
      - run: npm test
        env:
          NPM_TOKEN: \${{ secrets.NPM_PUBLISH_TOKEN }}
  lint:
    runs-on: ubuntu-latest
    steps:
      - uses: ${CHECKOUT}
        with:
          persist-credentials: false
      - uses: SocketDev/action@ba6de6cc0565af1f42295590380973573297e31f
        with:
          mode: firewall
      - run: sfw npm ci
      - run: echo \${{ secrets.GITHUB_TOKEN }}
  agent:
    runs-on: ubuntu-latest
    steps:
      - uses: anthropics/claude-code-action@0000000000000000000000000000000000000000
        with:
          anthropic_api_key: \${{ secrets.ANTHROPIC_API_KEY }}
          claude_args: --allowedTools "Bash(*)"
`;
  const jobs = summarizeWorkflowJobs(yaml);
  assert.deepEqual(jobs.map((j) => j.name), ['build', 'lint', 'agent']);
  const [build, lint, agent] = jobs;

  assert.equal(build.usesSecrets, true);
  assert.equal(build.installsPackages, true);
  assert.equal(build.runsPackageScripts, true);
  assert.equal(build.checkoutPersistsCredentials, true);
  assert.equal(build.socketFirewall, false);
  assert.equal(build.isAgentJob, false);

  assert.equal(lint.usesSecrets, false, 'GITHUB_TOKEN alone is not a repository secret');
  assert.equal(lint.checkoutPersistsCredentials, false);
  assert.equal(lint.socketFirewall, true);
  assert.equal(lint.installsPackages, true);

  assert.equal(agent.isAgentJob, true);
  assert.equal(agent.usesAgentApiKey, true);
  assert.equal(agent.agentShellTools, true);
  assert.equal(agent.usesCheckout, false);
});

test('summarizeWorkflowJobs treats secrets: inherit and workflow-level env secrets as reachable', () => {
  const yaml = `on: push
env:
  DEPLOY_KEY: \${{ secrets.DEPLOY_KEY }}
jobs:
  a:
    runs-on: ubuntu-latest
    steps:
      - run: pip install -r requirements.txt
  b:
    uses: ./.github/workflows/reusable.yml
    secrets: inherit
`;
  const [a, b] = summarizeWorkflowJobs(yaml);
  assert.equal(a.usesSecrets, true);
  assert.equal(a.installsPackages, true);
  assert.equal(b.usesSecrets, true);
});

test('summarizeWorkflowJobs marks jobs with contents: write or git push as pushing', () => {
  const yaml = `on: push
jobs:
  release:
    runs-on: ubuntu-latest
    permissions:
      contents: write
    steps:
      - uses: ${CHECKOUT}
  readonly:
    runs-on: ubuntu-latest
    steps:
      - uses: ${CHECKOUT}
`;
  const [release, readonlyJob] = summarizeWorkflowJobs(yaml);
  assert.equal(release.pushes, true);
  assert.equal(readonlyJob.pushes, false);
  assert.equal(readonlyJob.checkoutPersistsCredentials, true);
});

test('summarizeWorkflowJobs ignores commented-out secrets and returns [] without jobs', () => {
  const yaml = `on: push
jobs:
  a:
    runs-on: ubuntu-latest
    steps:
      # - run: echo \${{ secrets.OLD_TOKEN }}
      - run: npm ci
`;
  assert.equal(summarizeWorkflowJobs(yaml)[0].usesSecrets, false);
  assert.deepEqual(summarizeWorkflowJobs('name: empty\non: push\n'), []);
});

// --- install-scripts ---

test('install-scripts passes for zero-dep, non-npm, or ignore-scripts repos', () => {
  assert.equal(check(profile([], { hasZeroRuntimeDeps: true }), 'install-scripts').status, 'pass');
  assert.equal(check(profile([], { ecosystems: ['go'] }), 'install-scripts').status, 'pass');
  assert.equal(check(profile([], { npmIgnoreScripts: true }), 'install-scripts').status, 'pass');
});

test('install-scripts improves and names lockfile packages with install scripts', () => {
  const c = check(
    profile([], { installScriptPackages: ['esbuild', 'sharp'] }),
    'install-scripts'
  );
  assert.equal(c.status, 'improve');
  assert.match(c.evidence, /esbuild, sharp/);
  assert.deepEqual(c.fixes, [{ path: '.npmrc', language: 'text', content: 'ignore-scripts=true\n' }]);
});

// --- secrets-in-package-jobs ---

test('secrets-in-package-jobs: waiting without workflows, pass when separated, improve when combined', () => {
  assert.equal(check(profile([], { workflows: [] }), 'secrets-in-package-jobs').status, 'waiting');
  assert.equal(
    check(profile([job({ usesSecrets: true }), job({ name: 't', installsPackages: true })]), 'secrets-in-package-jobs').status,
    'pass'
  );
  const c = check(profile([job({ usesSecrets: true, runsPackageScripts: true })]), 'secrets-in-package-jobs');
  assert.equal(c.status, 'improve');
  assert.match(c.evidence, /\.github\/workflows\/ci\.yml#build/);
});

// --- agent-jobs-isolated ---

test('agent-jobs-isolated: pass without agents or when isolated, improve when key meets packages or Bash', () => {
  assert.equal(check(profile([job()]), 'agent-jobs-isolated').status, 'pass');
  const agent = { isAgentJob: true, usesAgentApiKey: true };
  assert.equal(check(profile([job(agent)]), 'agent-jobs-isolated').status, 'pass');
  assert.equal(check(profile([job({ ...agent, agentShellTools: true })]), 'agent-jobs-isolated').status, 'improve');
  assert.equal(check(profile([job({ ...agent, installsPackages: true })]), 'agent-jobs-isolated').status, 'improve');
  assert.equal(check(profile([], { workflows: [] }), 'agent-jobs-isolated').status, 'waiting');
});

// --- checkout-persist-credentials ---

test('checkout-persist-credentials ignores pushing jobs and flags non-pushing ones', () => {
  assert.equal(check(profile([job()]), 'checkout-persist-credentials').status, 'pass');
  assert.equal(
    check(profile([job({ checkoutPersistsCredentials: true, pushes: true })]), 'checkout-persist-credentials').status,
    'pass'
  );
  const c = check(profile([job({ checkoutPersistsCredentials: true })]), 'checkout-persist-credentials');
  assert.equal(c.status, 'improve');
  assert.equal(c.impact, 'low');
});

// --- socket-firewall (#7) ---

test('socket-firewall is not applicable for zero-dep or unsupported ecosystems', () => {
  const installing = [job({ installsPackages: true })];
  const zero = check(profile(installing, { hasZeroRuntimeDeps: true }), 'socket-firewall');
  assert.equal(zero.status, 'pass');
  assert.match(zero.evidence, /not applicable/);
  const go = check(profile(installing, { ecosystems: ['go'] }), 'socket-firewall');
  assert.equal(go.status, 'pass');
  assert.match(go.evidence, /not applicable/);
});

test('socket-firewall passes when installs are screened and improves with a pinned snippet otherwise', () => {
  assert.equal(
    check(profile([job({ installsPackages: true, socketFirewall: true })]), 'socket-firewall').status,
    'pass'
  );
  const c = check(profile([job({ installsPackages: true })]), 'socket-firewall');
  assert.equal(c.status, 'improve');
  assert.equal(c.fixes.length, 1);
  assert.match(c.fixes[0].content, /SocketDev\/action@[0-9a-f]{40}/);
  assert.match(c.fixes[0].content, /mode: firewall/);
  assert.match(c.fixes[0].content, /sfw npm ci/);
  assert.match(c.fixes[0].content, /cache/i);
});

// --- Leakage & local scanner integration ---

test('secret names never leak into audit JSON', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'uplift-secrets-'));
  fs.mkdirSync(path.join(tmp, '.github', 'workflows'), { recursive: true });
  fs.writeFileSync(path.join(tmp, 'package.json'), JSON.stringify({ name: 'x', dependencies: { a: '1' } }));
  fs.writeFileSync(
    path.join(tmp, '.github', 'workflows', 'ci.yml'),
    `on: pull_request
permissions: {}
jobs:
  build:
    runs-on: ubuntu-latest
    steps:
      - uses: ${CHECKOUT}
      - run: npm ci
        env:
          SUPER_SECRET_DEPLOY_TOKEN: \${{ secrets.SUPER_SECRET_DEPLOY_TOKEN }}
          ANTHROPIC_API_KEY: \${{ secrets.ANTHROPIC_API_KEY }}
`
  );
  try {
    const p = scanLocalRepository(tmp, 'owner/repo');
    // manual_commands legitimately suggest `gh secret set ANTHROPIC_API_KEY`, so inspect profile + checks.
    const json = JSON.stringify({ p, checks: buildAuditReport(p, 'local', new Date(0)).checks });
    assert.doesNotMatch(json, /SUPER_SECRET_DEPLOY_TOKEN/);
    assert.doesNotMatch(json, /ANTHROPIC_API_KEY/);
    assert.equal(check(p, 'secrets-in-package-jobs').status, 'improve');
    assert.equal(check(p, 'agent-jobs-isolated').status, 'improve');
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('local scanner reads ignore-scripts settings and lockfile install-script packages', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'uplift-npmrc-'));
  fs.writeFileSync(path.join(tmp, 'package.json'), JSON.stringify({ name: 'x', dependencies: { esbuild: '1' } }));
  fs.writeFileSync(
    path.join(tmp, 'package-lock.json'),
    JSON.stringify({
      lockfileVersion: 3,
      packages: {
        '': { name: 'x' },
        'node_modules/esbuild': { hasInstallScript: true },
        'node_modules/@scope/pkg': { hasInstallScript: true },
        'node_modules/plain': {},
      },
    })
  );
  try {
    let p = scanLocalRepository(tmp, 'owner/repo');
    assert.equal(p.npmIgnoreScripts, false);
    assert.deepEqual(p.installScriptPackages, ['@scope/pkg', 'esbuild']);
    fs.writeFileSync(path.join(tmp, '.yarnrc.yml'), 'enableScripts: false\n');
    p = scanLocalRepository(tmp, 'owner/repo');
    assert.equal(p.npmIgnoreScripts, true);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

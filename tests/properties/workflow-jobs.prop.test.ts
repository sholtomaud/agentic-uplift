import assert from 'node:assert/strict';
import test from 'node:test';
import { runUpliftAudit } from '../../src/domain/audit-engine.ts';
import { summarizeWorkflowJobs } from '../../src/domain/workflow-jobs.ts';
import { assertProperty } from '../lib/property.ts';

interface JobSpec {
  readonly secret: boolean;
  readonly install: boolean;
  readonly firewall: boolean;
  readonly checkout: boolean;
  readonly persistFalse: boolean;
  readonly push: boolean;
  readonly secretName: string;
}

function renderJob(name: string, spec: JobSpec): string {
  const lines = [`  ${name}:`, '    runs-on: ubuntu-latest'];
  if (spec.push) lines.push('    permissions:', '      contents: write');
  lines.push('    steps:');
  if (spec.checkout) {
    lines.push('      - uses: actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1 # v7.0.1');
    if (spec.persistFalse) lines.push('        with:', '          persist-credentials: false');
  }
  if (spec.firewall) {
    lines.push(
      '      - uses: SocketDev/action@ba6de6cc0565af1f42295590380973573297e31f # v1.3.2',
      '        with:',
      '          mode: firewall'
    );
  }
  lines.push(`      - run: ${spec.install ? (spec.firewall ? 'sfw npm ci' : 'npm ci') : 'echo ok'}`);
  if (spec.secret) {
    lines.push('        env:', `          VALUE: \${{ secrets.${spec.secretName} }}`);
  }
  return lines.join('\n');
}

test('property: job analysis recovers every generated signal, never leaks secret names, and audit statuses agree', () => {
  assertProperty(
    'workflow-job-signal-roundtrip',
    {
      sample: (rng): JobSpec[] => {
        const count = rng.int(1, 4);
        const specs: JobSpec[] = [];
        for (let i = 0; i < count; i += 1) {
          specs.push({
            secret: rng.bool(0.5),
            install: rng.bool(0.5),
            firewall: rng.bool(0.4),
            checkout: rng.bool(0.7),
            persistFalse: rng.bool(0.5),
            push: rng.bool(0.3),
            secretName: `ZZ_SECRET_${rng.int(1000, 9999)}`,
          });
        }
        return specs;
      },
    },
    (specs) => {
      const yaml = [
        'name: Generated',
        'on: [pull_request]',
        'permissions:',
        '  contents: read',
        'jobs:',
        ...specs.map((s, i) => renderJob(`job${i}`, s)),
        '',
      ].join('\n');
      const jobs = summarizeWorkflowJobs(yaml);
      assert.equal(jobs.length, specs.length);
      specs.forEach((spec, i) => {
        const j = jobs[i];
        assert.equal(j.name, `job${i}`);
        assert.equal(j.usesSecrets, spec.secret);
        assert.equal(j.installsPackages, spec.install);
        assert.equal(j.socketFirewall, spec.firewall);
        assert.equal(j.usesCheckout, spec.checkout);
        assert.equal(j.checkoutPersistsCredentials, spec.checkout && !spec.persistFalse);
        assert.equal(j.pushes, spec.push);
        assert.equal(j.isAgentJob, false);
      });

      const profileJson = JSON.stringify(jobs);
      for (const spec of specs) assert.ok(!profileJson.includes(spec.secretName));

      const checks = runUpliftAudit({
        repository: 'o/r', defaultBranch: 'main', ecosystems: ['npm'], languages: [],
        fileCount: 1, testFileCount: 0, hasLockfile: true, hasProofLock: false,
        proofLockValid: null, hasProofChangelog: false, proofChangelogValid: null,
        hasPreCommitHook: false, hasPrePushHook: false, hooksPathConfigured: false,
        hasCodeowners: false, codeownersProtectsProof: false, hasAgentsMd: false,
        agentsMdTopics: [], hasClaudeMd: false, hasSecurityPolicy: false,
        hasIssueForms: false, hasPrTemplate: false, hasDependabot: false,
        hasDependabotCooldown: false, hasCodeql: false, hasScorecard: false,
        hasDependencyReview: false, hasUpliftConfig: false, hasZeroRuntimeDeps: false,
        branchProtectionEnabled: null,
        workflows: [{ path: 'w.yml', triggers: ['pull_request'], hasTests: false, hasProofGate: false,
          hasResolveGate: false, hasPermissions: true, unpinnedActions: [], jobs }],
        ciPassRate: null, ciFailingNow: [], closedIssuesCount: null, linkedFixShare: null,
        agentAttributionCount: null, costConfigured: false,
      });
      const status = (id: string): string => checks.find((c) => c.id === id)?.status ?? 'absent';
      assert.equal(status('secrets-in-package-jobs'), specs.some((s) => s.secret && s.install) ? 'improve' : 'pass');
      assert.equal(status('socket-firewall'), specs.some((s) => s.install && !s.firewall) ? 'improve' : 'pass');
      assert.equal(
        status('checkout-persist-credentials'),
        specs.some((s) => s.checkout && !s.persistFalse && !s.push) ? 'improve' : 'pass'
      );
      assert.ok(!JSON.stringify(checks).includes('ZZ_SECRET_'));
    }
  );
});

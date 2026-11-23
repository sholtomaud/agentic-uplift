import assert from 'node:assert/strict';
import test from 'node:test';
import { computeIssueMetrics, isAgentLogin, type RawIssueSample } from '../../src/domain/metrics.ts';
import { assertProperty } from '../lib/property.ts';

const AGENTS = ['claude', 'copilot', 'codex', 'devin', 'antigravity', 'gemini', 'cursor', 'amp'];
const LETTERS = 'bfhjklqwxz';

test('property: agent names match only as whole login tokens', () => {
  assertProperty(
    'agent-login-token-boundaries',
    {
      sample: (rng) => {
        const word = (): string =>
          Array.from({ length: rng.int(1, 5) }, () => rng.pick([...LETTERS])).join('');
        return { agent: rng.pick(AGENTS), prefix: word(), suffix: word(), sep: rng.pick(['-', '_', '.']) };
      },
    },
    ({ agent, prefix, suffix, sep }) => {
      assert.equal(isAgentLogin(`${prefix}${agent}${suffix}`), false, 'embedded substring is not an agent');
      assert.equal(isAgentLogin(`${prefix}${sep}${agent}${sep}${suffix}`), true, 'delimited token is an agent');
      assert.equal(isAgentLogin(`${prefix}${suffix}`), false, 'no agent token');
    }
  );
});

test('property: closed issues partition exactly into agent, agent-assisted, and human closures', () => {
  assertProperty(
    'issue-closure-partition',
    {
      sample: (rng): RawIssueSample[] =>
        Array.from({ length: rng.int(0, 30) }, () => {
          const isClosed = rng.bool(0.7);
          const byAgent = isClosed && rng.bool(0.3);
          return {
            state: isClosed ? 'closed' : 'open',
            createdAt: '2026-11-01T00:00:00Z',
            closedAt: isClosed ? '2026-11-02T00:00:00Z' : null,
            closedByAgent: byAgent,
            closedAgentAssisted: isClosed && !byAgent && rng.bool(0.4),
            openedByAgent: rng.bool(0.3),
            fixReferenced: rng.bool(0.5),
          };
        }),
    },
    (issues) => {
      const m = computeIssueMetrics(issues, Date.parse('2026-11-23T00:00:00Z'));
      assert.equal(m.closed_by_agent + m.closed_agent_assisted + m.closed_by_human, m.closed);
      assert.ok(m.opened_by_agent <= issues.length);
      if (m.agent_resolution_share !== null) {
        assert.ok(m.agent_resolution_share >= 0 && m.agent_resolution_share <= 1);
      } else {
        assert.equal(m.closed, 0);
      }
    }
  );
});

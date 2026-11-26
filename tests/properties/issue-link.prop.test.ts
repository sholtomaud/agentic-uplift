import assert from 'node:assert/strict';
import test from 'node:test';
import {
  claimCommentText,
  evaluateIssueLink,
  referencedIssues,
  type IssueLinkInput,
  type IssueLookup,
} from '../../src/domain/issue-link.ts';
import { assertProperty } from '../lib/property.ts';

const BRANCHES = ['feat/42-x', 'fix/issue-7', 'claude/thread-abc', 'main', '9-quick', null] as const;
const MESSAGES = ['feat: x', 'fix: y\n\nFixes #42', 'docs: z (#7)', "Merge branch 'main'", 'chore: w GH-9'] as const;

test('property: issue-link verdict never passes a commit that lacks a verified branch claim', () => {
  assertProperty(
    'issue-link-safety-invariants',
    {
      sample: (rng): IssueLinkInput => {
        const branch = rng.pick(BRANCHES);
        const message = rng.pick(MESSAGES);
        const offline = rng.bool(0.2);
        const lookups: IssueLookup[] = referencedIssues(branch, message).map((n) => {
          const kind = rng.pick(['found', 'not_found', 'unavailable'] as const);
          if (kind === 'not_found') return { kind, number: n };
          if (kind === 'unavailable') return { kind, number: n, reason: 'timeout' };
          const claims = rng.bool() && branch ? [claimCommentText(branch)] : ['LGTM'];
          return { kind, number: n, state: 'open', isPullRequest: rng.bool(0.2), comments: claims.map((body) => ({ author: 'a', body })) };
        });
        return { branch, message, lookups: offline ? null : lookups, strict: rng.bool() };
      },
    },
    (input) => {
      const v = evaluateIssueLink(input);
      if (v.status === 'pass') {
        assert.ok(v.claimed_by !== null && input.lookups !== null);
        const holder = input.lookups.find((l) => l.kind === 'found' && l.number === v.claimed_by);
        assert.ok(holder && holder.kind === 'found' && !holder.isPullRequest);
        assert.ok(input.branch && holder.comments.some((c) => c.body === claimCommentText(input.branch ?? '')));
      }
      if (v.status === 'missing_reference') assert.equal(v.ok, false);
      if (v.status === 'unverified') assert.equal(v.ok, !input.strict);
      if (v.status === 'missing_claim') assert.equal(v.ok, false);
      if (v.ok && v.status !== 'skipped' && v.status !== 'unverified') assert.equal(v.status, 'pass');
      if (v.status !== 'skipped') assert.ok(v.issues.length > 0 || v.status === 'missing_reference');
    }
  );
});

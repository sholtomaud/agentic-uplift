import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  collectIssueLookups,
  detectCurrentBranch,
  detectRepositorySlug,
  resolveGitHubToken,
} from '../../src/adapters/issue-link-collector.ts';

const CLI_PATH = path.resolve(process.cwd(), 'src', 'cli.ts');

async function withServer(
  handler: http.RequestListener,
  fn: (apiUrl: string) => Promise<void>
): Promise<void> {
  const server = http.createServer(handler);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  try {
    await fn(`http://127.0.0.1:${port}`);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

function json(res: http.ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(body));
}

test('collectIssueLookups reads the issue, its comments and flags pull requests', async () => {
  await withServer(
    (req, res) => {
      const url = req.url ?? '';
      if (url === '/repos/o/r/issues/42') return json(res, 200, { number: 42, state: 'open' });
      if (url === '/repos/o/r/issues/43') return json(res, 200, { number: 43, state: 'open', pull_request: {} });
      if (url.startsWith('/repos/o/r/issues/42/comments'))
        return json(res, 200, [{ user: { login: 'dev' }, body: 'Picking up as branch 42-x' }]);
      if (url.startsWith('/repos/o/r/issues/43/comments')) return json(res, 200, []);
      return json(res, 404, {});
    },
    async (apiUrl) => {
      const lookups = await collectIssueLookups([42, 43, 44], { slug: 'o/r', token: 't', apiUrl });
      assert.deepEqual(lookups[0], {
        kind: 'found',
        number: 42,
        state: 'open',
        isPullRequest: false,
        comments: [{ author: 'dev', body: 'Picking up as branch 42-x' }],
      });
      assert.equal(lookups[1].kind === 'found' && lookups[1].isPullRequest, true);
      assert.deepEqual(lookups[2], { kind: 'not_found', number: 44 });
    }
  );
});

test('collectIssueLookups treats 404 without a token and 403 as unavailable, not missing', async () => {
  await withServer(
    (req, res) => json(res, (req.url ?? '').endsWith('/1') ? 404 : 403, {}),
    async (apiUrl) => {
      const [anon404, limited] = await collectIssueLookups([1, 2], { slug: 'o/r', token: '', apiUrl });
      assert.equal(anon404.kind, 'unavailable');
      assert.equal(limited.kind, 'unavailable');
    }
  );
});

test('collectIssueLookups turns network failures and timeouts into unavailable lookups', async () => {
  const refused = await collectIssueLookups([5], { slug: 'o/r', token: 't', apiUrl: 'http://127.0.0.1:1' });
  assert.equal(refused[0].kind, 'unavailable');
  await withServer(
    () => {
      /* never answers */
    },
    async (apiUrl) => {
      const slow = await collectIssueLookups([6], { slug: 'o/r', token: 't', apiUrl, timeoutMs: 100 });
      assert.equal(slow[0].kind === 'unavailable' && slow[0].reason.includes('timed out'), true);
    }
  );
});

test('resolveGitHubToken prefers UPLIFT_TOKEN, then GH_TOKEN, then GITHUB_TOKEN', () => {
  assert.equal(resolveGitHubToken({ UPLIFT_TOKEN: 'a', GH_TOKEN: 'b', GITHUB_TOKEN: 'c' }), 'a');
  assert.equal(resolveGitHubToken({ GH_TOKEN: 'b', GITHUB_TOKEN: 'c' }), 'b');
  assert.equal(resolveGitHubToken({ GITHUB_TOKEN: 'c' }), 'c');
});

function makeRepo(branch: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'uplift-issue-link-'));
  const run = (args: readonly string[]): void => {
    spawnSync('git', args, { cwd: dir, encoding: 'utf8' });
  };
  run(['init', '-q', '-b', branch]);
  run(['remote', 'add', 'origin', 'git@github.com:acme/widgets.git']);
  return dir;
}

test('detectCurrentBranch and detectRepositorySlug read the local git repository', () => {
  const dir = makeRepo('feat/42-x');
  assert.equal(detectCurrentBranch(dir), 'feat/42-x');
  assert.equal(detectRepositorySlug(dir), 'acme/widgets');
});

test('CLI issue-link check: blocks a commit with no issue and warns when offline', () => {
  const dir = makeRepo('feat/42-x');
  const msgFile = path.join(dir, 'MSG');
  const run = (message: string, extra: readonly string[] = []) => {
    fs.writeFileSync(msgFile, message);
    return spawnSync(
      process.execPath,
      [CLI_PATH, 'issue-link', 'check', '--message-file', msgFile, '--repo', dir, '--json', ...extra],
      { cwd: dir, encoding: 'utf8', env: { ...process.env, UPLIFT_ISSUE_LINK_STRICT: '' } }
    );
  };

  const noRef = run('feat: x', ['--branch', 'feat/x', '--offline']);
  assert.equal(noRef.status, 1);
  assert.equal(JSON.parse(noRef.stdout).status, 'missing_reference');

  const offline = run('feat: x', ['--offline']);
  assert.equal(offline.status, 0);
  assert.equal(JSON.parse(offline.stdout).status, 'unverified');

  const strict = run('feat: x', ['--offline', '--strict']);
  assert.equal(strict.status, 1);

  const merge = run("Merge branch 'main'", ['--branch', 'feat/x', '--offline', '--strict']);
  assert.equal(merge.status, 0);
});

test('collectIssueLookups explains a rejected token instead of calling GitHub unreachable', async () => {
  await withServer(
    (_req, res) => json(res, 401, {}),
    async (apiUrl) => {
      const [lookup] = await collectIssueLookups([1], { slug: 'o/r', token: 'bad', apiUrl });
      assert.equal(lookup.kind === 'unavailable' && lookup.reason.includes('rejected the token'), true);
    }
  );
});

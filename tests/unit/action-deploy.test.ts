import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

const ACTION_PATH = path.resolve(process.cwd(), 'action.yml');

function stepBlock(yaml: string, id: string): string {
  const start = yaml.search(new RegExp(`^\\s+id:\\s*${id}\\s*$`, 'm'));
  assert.ok(start >= 0, `step with id "${id}" not found`);
  const before = yaml.lastIndexOf('    - name:', start);
  const after = yaml.indexOf('    - name:', start);
  return yaml.slice(before, after === -1 ? undefined : after);
}

test('action.yml uploads the pages artifact with an id and waits on its artifact_id', () => {
  const yaml = fs.readFileSync(ACTION_PATH, 'utf8');
  const upload = stepBlock(yaml, 'upload');
  assert.match(upload, /actions\/upload-pages-artifact@[0-9a-f]{40}/);
  assert.match(yaml, /ARTIFACT_ID:\s*\$\{\{\s*steps\.upload\.outputs\.artifact_id\s*\}\}/);
});

test('action.yml settles after REST visibility before deploying', () => {
  const yaml = fs.readFileSync(ACTION_PATH, 'utf8');
  const waitIdx = yaml.indexOf('Wait for GitHub Pages Artifact Indexing');
  const deployIdx = yaml.search(/^\s+id:\s*deploy\s*$/m);
  assert.ok(waitIdx >= 0 && deployIdx > waitIdx);
  assert.match(yaml.slice(waitIdx, deployIdx), /sleep 5/);
});

test('action.yml retries deploy-pages once after 15s when the first attempt fails', () => {
  const yaml = fs.readFileSync(ACTION_PATH, 'utf8');
  const first = stepBlock(yaml, 'deploy');
  assert.match(first, /continue-on-error:\s*true/);
  assert.match(first, /actions\/deploy-pages@[0-9a-f]{40}/);

  const retry = stepBlock(yaml, 'deploy-retry');
  assert.match(retry, /steps\.deploy\.outcome == 'failure'/);
  assert.match(retry, /actions\/deploy-pages@[0-9a-f]{40}/);
  assert.doesNotMatch(retry, /continue-on-error/);

  const retryIdx = yaml.search(/^\s+id:\s*deploy-retry\s*$/m);
  const between = yaml.slice(yaml.search(/^\s+id:\s*deploy\s*$/m), retryIdx);
  assert.match(between, /sleep 15/);
});

test('action.yml page-url output is wired to either deploy attempt', () => {
  const yaml = fs.readFileSync(ACTION_PATH, 'utf8');
  assert.match(
    yaml,
    /page-url:[\s\S]*?value:\s*\$\{\{\s*steps\.deploy\.outputs\.page_url\s*\|\|\s*steps\.deploy-retry\.outputs\.page_url\s*\}\}/
  );
});

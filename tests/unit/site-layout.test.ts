import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

const CSS_PATH = path.resolve(process.cwd(), 'site', 'styles.css');

test('site/styles.css guards against CSS Grid horizontal blowout from preformatted code blocks', () => {
  const css = fs.readFileSync(CSS_PATH, 'utf8');
  assert.match(css, /uplift-cockpit\s*\{[^}]*display:\s*block/s);
  assert.match(css, /\.shell\s*\{[^}]*grid-template-columns:\s*minmax\(0,\s*1fr\)/s);
  assert.match(css, /\.cmd-card\s*\{[^}]*min-width:\s*0/s);
  assert.match(css, /pre\.code-block\s*\{[^}]*max-width:\s*100%/s);
  assert.match(css, /pre\.code-block\s*\{[^}]*overflow:\s*auto/s);
});

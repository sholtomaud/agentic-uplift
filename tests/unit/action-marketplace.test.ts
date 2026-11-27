import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

const ACTION_PATH = path.resolve(process.cwd(), 'action.yml');

const VALID_BRANDING_COLORS = new Set([
  'white',
  'black',
  'yellow',
  'blue',
  'green',
  'orange',
  'red',
  'purple',
  'gray-dark',
]);

function readScalarOrFoldedField(yaml: string, key: string): string {
  const folded = yaml.match(
    new RegExp(`^${key}:\\s*[>|]-?\\s*\\n((?:[ \\t]+.*\\n?)+)`, 'm')
  );
  if (folded) {
    return folded[1]
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean)
      .join(' ');
  }
  const single = yaml.match(new RegExp(`^${key}:\\s*(.+)\\s*$`, 'm'));
  if (!single) {
    return '';
  }
  return single[1].trim().replace(/^['"]|['"]$/g, '');
}

test('root action.yml meets GitHub Marketplace metadata constraints', () => {
  const yaml = fs.readFileSync(ACTION_PATH, 'utf8');

  const name = readScalarOrFoldedField(yaml, 'name');
  assert.ok(name.length > 0 && name.length <= 100, `action name length must be 1..100, got ${name.length}`);

  const description = readScalarOrFoldedField(yaml, 'description');
  assert.ok(
    description.length > 0 && description.length <= 125,
    `GitHub Marketplace requires action.yml description <= 125 chars, got ${description.length}: "${description}"`
  );

  const author = readScalarOrFoldedField(yaml, 'author');
  assert.ok(author.length > 0, 'action.yml must declare author');

  const brandingMatch = yaml.match(
    /^branding:\s*\n(?:[ \t]+.+\n?)+/m
  );
  assert.ok(brandingMatch, 'action.yml must declare branding');

  const iconMatch = brandingMatch[0].match(/^\s+icon:\s*([a-z0-9-]+)\s*$/m);
  const colorMatch = brandingMatch[0].match(/^\s+color:\s*([a-z0-9-]+)\s*$/m);
  assert.ok(iconMatch, 'branding.icon must be set');
  assert.ok(
    colorMatch && VALID_BRANDING_COLORS.has(colorMatch[1]),
    `branding.color must be a supported Marketplace color, got "${colorMatch?.[1] ?? ''}"`
  );
});

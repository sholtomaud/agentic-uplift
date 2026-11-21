import assert from 'node:assert/strict';
import test from 'node:test';
import { checkSourceContent } from '../../src/core/check-rules.ts';

test('checkSourceContent accepts clean erasable TypeScript including prose strings', () => {
  const src = `
export type Mode = 'local' | 'github';
export function greet(mode: Mode): string {
  const label = 'property: any valid input works';
  return mode + label;
}
`;
  const violations = checkSourceContent('src/domain/clean.ts', src);
  assert.equal(violations.length, 0);
});

test('checkSourceContent flags explicit any, suppression directives, non-erasable enum, and DOM globals in domain', () => {
  const bad = [
    '// ' + '@ts-' + 'ignore',
    'export ' + 'enum Color { Red }',
    'export function bad(x: ' + 'any) { return window.location; }',
  ].join('\n');
  const violations = checkSourceContent('src/domain/bad.ts', bad);
  const rules = new Set(violations.map((v) => v.rule));
  assert.ok(rules.has('no-suppression-directives'));
  assert.ok(rules.has('erasable-ts-only'));
  assert.ok(rules.has('no-explicit-any'));
  assert.ok(rules.has('no-dom-in-pure-layers'));
});

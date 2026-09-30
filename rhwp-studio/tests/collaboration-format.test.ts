import test from 'node:test';
import assert from 'node:assert/strict';
import { formatOperations, parseFormatOperation } from '../src/embed/collaboration-format.ts';
import { planFormatting, applyFormatting, type CollaborationFormatWasm } from '../src/embed/collaboration-format-apply.ts';
import type { CollaborationManifestRegionV1 } from '../src/embed/collaboration-live-contract.ts';
import { isUnsupportedLiveFormat } from '../src/embed/collaboration-format-boundary.ts';

test('format capture emits only the changed property and preserves styled run boundaries', () => {
  const before: CollaborationManifestRegionV1 = { id: 'b:0:0', kind: 'body', text: 'abcd', paragraph: { alignment: 'left' },
    runs: [{ start: 0, end: 2, properties: { bold: false, italic: true, fontSize: 1100 } },
      { start: 2, end: 4, properties: { bold: true, italic: false, fontSize: 1200 } }] };
  const after: CollaborationManifestRegionV1 = { ...before, runs: before.runs.map((run) => ({ ...run, properties: { ...run.properties, bold: true } })) };
  assert.deepEqual(formatOperations(before, after), [{ type: 'format', version: 1, scope: 'character', offset: 0, count: 2, marks: { bold: true } }]);
});

test('native formatting maps UTF-16 ranges into scalar offsets in multiple cell paragraphs', () => {
  const operation = { type: 'format', version: 1, scope: 'character', offset: 1, count: 5, marks: { textColor: '#ff0000' } } as const;
  const ranges = planFormatting('a😀\nbc', operation);
  assert.deepEqual(ranges, [{ paragraph: 0, start: 1, end: 2 }, { paragraph: 1, start: 0, end: 2 }]);
  assert.ok(ranges);
  const calls: unknown[] = [];
  const wasm: CollaborationFormatWasm = {
    applyCharFormat: () => { throw new Error('wrong body address'); },
    applyParaFormat: () => { throw new Error('wrong paragraph operation'); },
    applyParaFormatInCell: () => { throw new Error('wrong paragraph operation'); },
    applyCharFormatInCell: (...args) => { calls.push(args); return '{}'; },
  };
  applyFormatting(wasm, { address: { kind: 'cell', section: 0, paragraph: 2, control: 0, cell: 1, cellParagraph: 0 }, operation, ranges });
  assert.deepEqual(calls, [[0, 2, 0, 1, 0, 1, 2, '{"textColor":"#ff0000"}'], [0, 2, 0, 1, 1, 0, 2, '{"textColor":"#ff0000"}']]);
});

test('native parser rejects style keys and payloads outside the supported format contract', () => {
  const operation = { type: 'format', version: 1, scope: 'character', offset: 0, count: 1, marks: { bold: true } };
  assert.equal(parseFormatOperation({ ...operation, marks: { fontId: 999 } }), null);
  assert.equal(parseFormatOperation({ ...operation, marks: { textColor: 'url(secret)' } }), null);
  assert.equal(parseFormatOperation({ ...operation, version: 2 }), null);
  assert.equal(planFormatting('😀', { ...operation, type: 'format', version: 1, scope: 'character', offset: 1 }), null);
});

test('unsupported formatting commands are blocked only in live collaboration', () => {
  for (const command of ['format:underline', 'format:char-shape', 'format:apply-style', 'edit:format-paste', 'table:border-each']) {
    assert.equal(isUnsupportedLiveFormat(command, true), true);
    assert.equal(isUnsupportedLiveFormat(command, false), false);
  }
  for (const command of ['format:bold', 'format:italic', 'format:align-center'])
    assert.equal(isUnsupportedLiveFormat(command, true), false);
});

test('changed-text marks use scalar-safe offsets and retain shifted tail marks', () => {
  const before: CollaborationManifestRegionV1 = { id: 'b:0:0', kind: 'body', text: '😀tail', paragraph: {},
    runs: [{ start: 0, end: 2, properties: { bold: false } }, { start: 2, end: 6, properties: { italic: true } }] };
  const after: CollaborationManifestRegionV1 = { ...before, text: '😁tail',
    runs: [{ start: 0, end: 2, properties: { bold: true } }, { start: 2, end: 6, properties: { italic: true } }] };
  const operations = formatOperations(before, after);
  assert.deepEqual(operations, [{ type: 'format', version: 1, scope: 'character', offset: 0, count: 2, marks: { bold: true } }]);
  assert.ok(operations.every((operation) => planFormatting(after.text, operation) !== null));
});

test('adjacent identical character changes compact without including an unchanged gap', () => {
  const before: CollaborationManifestRegionV1 = { id: 'b:0:0', kind: 'body', text: 'abcdef', paragraph: {},
    runs: [{ start: 0, end: 6, properties: { bold: false } }] };
  const after: CollaborationManifestRegionV1 = { ...before, runs: [
    { start: 0, end: 1, properties: { bold: true, fontSize: 1000 } },
    { start: 1, end: 2, properties: { bold: true, fontSize: 1200 } },
    { start: 2, end: 4, properties: { bold: false } },
    { start: 4, end: 6, properties: { bold: true } },
  ] };
  assert.deepEqual(formatOperations(before, after), [
    { type: 'format', version: 1, scope: 'character', offset: 0, count: 2, marks: { bold: true } },
    { type: 'format', version: 1, scope: 'character', offset: 4, count: 2, marks: { bold: true } },
  ]);
});

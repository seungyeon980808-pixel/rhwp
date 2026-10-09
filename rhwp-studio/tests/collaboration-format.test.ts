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

test('확장 서식은 변경한 속성만 캡처하고 네이티브 셀 서식으로 전달한다', () => {
  const before: CollaborationManifestRegionV1 = { id: 'c:0:0:0:0', kind: 'cell', text: '문서', paragraph: {},
    runs: [{ start: 0, end: 2, properties: { underline: false, fontSize: 1000, ratios: Array(7).fill(100), spacings: Array(7).fill(0) } }] };
  const marks = { underline: true, fontSize: 1200, ratios: Array(7).fill(99), spacings: Array(7).fill(-1) };
  const after = { ...before, runs: [{ start: 0, end: 2, properties: marks }] };
  const operations = formatOperations(before, after);
  assert.deepEqual(operations, [{ type: 'format', version: 1, scope: 'character', offset: 0, count: 2, marks }]);
  const operation = parseFormatOperation(operations[0]); assert.ok(operation);
  const calls: unknown[] = [];
  const wasm = { applyCharFormatInCell: (...args: unknown[]) => { calls.push(args); return '{}'; } } as CollaborationFormatWasm;
  const ranges = planFormatting(after.text, operation); assert.ok(ranges);
  applyFormatting(wasm, { address: { kind: 'cell', section: 0, paragraph: 0, control: 0, cell: 0, cellParagraph: 0 }, operation, ranges });
  assert.deepEqual(JSON.parse((calls[0] as string[]).at(-1)!), marks);
  for (const invalid of [{ fontSize: 0 }, { fontSize: Infinity }, { ratios: [100] }, { spacings: Array(7).fill(-129) }, { underline: 'yes' }])
    assert.equal(parseFormatOperation({ ...operations[0], marks: invalid }), null);
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
  for (const command of ['format:char-shape', 'format:apply-style', 'edit:format-paste', 'table:border-each']) {
    assert.equal(isUnsupportedLiveFormat(command, true), true);
    assert.equal(isUnsupportedLiveFormat(command, false), false);
  }
  for (const command of ['format:bold', 'format:italic', 'format:underline', 'format:char-spacing-increase', 'format:char-ratio-decrease', 'format:font-size-increase', 'format:align-center'])
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
    { type: 'format', version: 1, scope: 'character', offset: 0, count: 1, marks: { bold: true, fontSize: 1000 } },
    { type: 'format', version: 1, scope: 'character', offset: 1, count: 1, marks: { bold: true, fontSize: 1200 } },
    { type: 'format', version: 1, scope: 'character', offset: 4, count: 2, marks: { bold: true } },
  ]);
});

test('normal attributes reset to false and paragraph indent emits native units without touching alignment', () => {
  const before: CollaborationManifestRegionV1 = { id: 'b:0:0', kind: 'body', text: 'ab', paragraph: { alignment: 'right', indent: 0, lineSpacing: 160 },
    runs: [{ start: 0, end: 2, properties: { superscript: true, subscript: false, emboss: true, shadowType: 2 } }] };
  const after = { ...before, paragraph: { ...before.paragraph, indent: 40 / 3, lineSpacing: 180 },
    runs: [{ start: 0, end: 2, properties: { superscript: false, subscript: false, emboss: false, shadowType: 0 } }] };
  const ops = formatOperations(before, after);
  assert.deepEqual(ops, [
    { type: 'format', version: 1, scope: 'character', offset: 0, count: 2, marks: { superscript: false, emboss: false, shadowType: 0 } },
    { type: 'format', version: 1, scope: 'paragraph', offset: 0, count: 2, marks: { lineSpacing: 180, indent: 2000 } },
  ]);
  for (const op of ops) assert.deepEqual(parseFormatOperation(op), op);
  for (const marks of [{ indent: 2_000_001 }, { indent: 0.5 }, { lineSpacingType: 'bogus' }, { fontId: 1 }, {}])
    assert.equal(parseFormatOperation({ ...ops[1], marks }), null);
  for (const marks of [{ superscript: 1 }, { outlineType: 7 }, { shadowType: 3 }, { underlineType: 'Middle' }, { shadeColor: 'red' }])
    assert.equal(parseFormatOperation({ ...ops[0], marks }), null);
  for (const id of ['normal', 'superscript', 'subscript', 'indent', 'outdent', 'line-spacing-increase', 'line-spacing-decrease'])
    assert.equal(isUnsupportedLiveFormat(`format:${id}`, true), false);
});

test('new plain text does not replay native default decorations but can clear an inherited superscript', () => {
  const defaults = { superscript: false, subscript: false, strikethrough: false, emboss: false, engrave: false, outlineType: 0, shadowType: 0, underlineType: 'None', shadeColor: '#ffffff' };
  const before: CollaborationManifestRegionV1 = { id: 'b:0:0', kind: 'body', text: 'a', paragraph: {}, runs: [{ start: 0, end: 1, properties: defaults }] };
  const after = { ...before, text: 'ab', runs: [{ start: 0, end: 2, properties: defaults }] };
  assert.deepEqual(formatOperations(before, after), []);
  const styledBefore = { ...before, runs: [{ start: 0, end: 1, properties: { ...defaults, superscript: true } }] };
  const styledAfter = { ...after, runs: [styledBefore.runs[0], { start: 1, end: 2, properties: defaults }] };
  assert.deepEqual(formatOperations(styledBefore, styledAfter), [
    { type: 'format', version: 1, scope: 'character', offset: 1, count: 1, marks: { superscript: false } },
  ]);
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { collaborationEditRegions } from '../src/embed/collaboration-edit-permissions.ts';
import type { DocumentPosition } from '../src/core/types.ts';
const body: DocumentPosition = { sectionIndex: 0, paragraphIndex: 2, charOffset: 0 };
const cell: DocumentPosition = { ...body, parentParaIndex: 3, controlIndex: 0, cellIndex: 4, cellParaIndex: 0 };

test('live editing checks every paragraph of a forward or reversed selection', () => {
  const other = { ...body, paragraphIndex: 4 };
  assert.deepEqual(collaborationEditRegions(body, other), ['b:0:2', 'b:0:3', 'b:0:4']);
  assert.deepEqual(collaborationEditRegions(other, body), ['b:0:2', 'b:0:3', 'b:0:4']);
});
test('all text paragraphs within one cell use the complete cell permission', () => {
  assert.deepEqual(collaborationEditRegions(cell, { ...cell, cellParaIndex: 2, charOffset: 6 }), ['c:0:3:0:4']);
});
test('unsupported mixed and incomplete selections fail closed', () => {
  for (const [start, end] of [
    [body, { ...body, sectionIndex: 1 }], [body, cell], [cell, { ...cell, cellIndex: 5 }],
    [{ ...cell, controlIndex: undefined }, cell], [{ ...body, isTextBox: true }, body],
  ] as [DocumentPosition, DocumentPosition][]) assert.equal(collaborationEditRegions(start, end), null);
});

test('nested cell text inherits its outer cell permission', () => {
  const nested = {...cell, controlIndex:7, cellIndex:8, cellPath:[
    {controlIndex:0,cellIndex:4,cellParaIndex:0}, {controlIndex:7,cellIndex:8,cellParaIndex:0}]};
  assert.deepEqual(collaborationEditRegions(nested,nested),['c:0:3:0:4']);
});

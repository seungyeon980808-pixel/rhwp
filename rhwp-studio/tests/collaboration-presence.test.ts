import test from 'node:test';
import assert from 'node:assert/strict';
import { readCollaborationPresence } from '../src/embed/collaboration-presence.ts';

test('retains the second cell paragraph without changing the cell region ID', () => {
  const cursor = { sectionIndex: 0, paragraphIndex: 2, parentParaIndex: 2,
    controlIndex: 0, cellIndex: 0, cellParaIndex: 1, charOffset: 6 };
  const presence = readCollaborationPresence({ getCursorPosition: () => cursor, getSelection: () => null });
  assert.deepEqual(presence, { regionId: 'c:0:2:0:0', anchorOffset: 6, focusOffset: 6,
    anchorCellParagraphIndex: 1, focusCellParagraphIndex: 1 });
});

test('retains a cross-region anchor when equal offsets occur in different paragraphs', () => {
  const start = { sectionIndex: 0, paragraphIndex: 2, charOffset: 3 };
  const end = { sectionIndex: 0, paragraphIndex: 5, charOffset: 3 };
  const presence = readCollaborationPresence({ getCursorPosition: () => end, getSelection: () => ({ start, end }) });
  assert.deepEqual(presence, { regionId: 'b:0:5', anchorRegionId: 'b:0:2', anchorOffset: 3, focusOffset: 3 });
});

test('preserves the backward direction of a cross-region selection', () => {
  const start = { sectionIndex: 0, paragraphIndex: 2, charOffset: 1 };
  const end = { sectionIndex: 0, paragraphIndex: 5, charOffset: 8 };
  const presence = readCollaborationPresence({ getCursorPosition: () => start, getSelection: () => ({ start, end }) });
  assert.deepEqual(presence, { regionId: 'b:0:2', anchorRegionId: 'b:0:5', anchorOffset: 8, focusOffset: 1 });
});

test('reports unsupported text boxes explicitly', () => {
  const cursor = { sectionIndex: 0, paragraphIndex: 2, charOffset: 1, isTextBox: true };
  assert.throws(() => readCollaborationPresence({ getCursorPosition: () => cursor, getSelection: () => null }),
    /unsupported-presence:text-box/);
});

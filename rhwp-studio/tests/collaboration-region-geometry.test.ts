import test from 'node:test';
import assert from 'node:assert/strict';
import { getCollaborationRegionRects, parseCollaborationGeometryRequest,
  type CollaborationGeometryContext } from '../src/embed/collaboration-region-geometry.ts';

function context(): CollaborationGeometryContext {
  return {
    zoom: 1.1,
    regions: [
      { id: 'b:0:2', kind: 'body', label: 'start', text: 'start' },
      { id: 'b:0:5', kind: 'body', label: 'end', text: 'end' },
      { id: 'c:0:3:0:0', kind: 'cell', label: 'cell', text: 'first\nsecond' },
    ],
    wasm: {
      getParagraphLength: () => 10,
      getCellParagraphLength: () => 6,
      getCellParagraphCount: () => 2,
      getTableCellBboxes: () => [{ cellIdx: 0, row: 0, col: 0, rowSpan: 1, colSpan: 1,
        pageIndex: 0, x: 2, y: 10, w: 120, h: 80 }],
      getCursorRect: () => ({ pageIndex: 0, x: 2, y: 3, height: 4 }),
      getCursorRectInCell: (_sec, _para, _ctrl, _cell, paragraph, offset) => ({ pageIndex: paragraph, x: offset, y: 20, height: 10 }),
      getSelectionRects: (_sec, startPara, startOffset, endPara, endOffset) => [
        { pageIndex: startPara, x: startOffset, y: 10, width: 20, height: 10 },
        { pageIndex: endPara, x: endOffset, y: 30, width: 40, height: 10 },
      ],
      getSelectionRectsInCell: (_sec, _para, _ctrl, _cell, startPara, startOffset, endPara, endOffset) => [
        { pageIndex: startPara, x: startOffset, y: 10, width: 20, height: 10 },
        { pageIndex: endPara, x: endOffset, y: 30, width: 40, height: 10 },
      ],
    },
  };
}

test('second cell paragraph caret uses its native paragraph and page', () => {
  const result = getCollaborationRegionRects({ regionId: 'c:0:3:0:0', selection: {
    anchorOffset: 3, focusOffset: 3, anchorCellParagraphIndex: 1, focusCellParagraphIndex: 1,
  } }, context());
  assert.deepEqual(result.pages, [{ pageIndex: 1, rects: [{ x: 3.3000000000000003, y: 22, width: 0, height: 11 }] }]);
});

test('backward cross-region selection sorts endpoints before requesting native page-local geometry', () => {
  const result = getCollaborationRegionRects({ regionId: 'b:0:2', selection: {
    anchorRegionId: 'b:0:5', anchorOffset: 8, focusOffset: 3,
  } }, context());
  assert.deepEqual(result.pages, [
    { pageIndex: 2, rects: [{ x: 3.3000000000000003, y: 11, width: 22, height: 11 }] },
    { pageIndex: 5, rects: [{ x: 8.8, y: 33, width: 44, height: 11 }] },
  ]);
});

test('same cell multi-paragraph selection keeps separate native page rectangles', () => {
  const result = getCollaborationRegionRects({ regionId: 'c:0:3:0:0', selection: {
    anchorOffset: 2, focusOffset: 4, anchorCellParagraphIndex: 0, focusCellParagraphIndex: 1,
  } }, context());
  assert.deepEqual(result.pages.map((page) => page.pageIndex), [0, 1]);
  assert.equal(result.pages[1]?.rects[0]?.x, 4.4);
});

test('out-of-range cell paragraphs fail rather than borrowing first-paragraph geometry', () => {
  assert.throws(() => getCollaborationRegionRects({ regionId: 'c:0:3:0:0', selection: {
    anchorOffset: 0, focusOffset: 1, anchorCellParagraphIndex: 2, focusCellParagraphIndex: 2,
  } }, context()), /unsupported-geometry/);
});

test('unknown selection fields and malformed paragraph indices fail at the RPC boundary', () => {
  for (const extra of [{ focusCellParagraphIndex: -1 }, { anchorRegionId: 'b:0:NaN' }, { geometry: [] }]) {
    assert.throws(() => parseCollaborationGeometryRequest({ regionId: 'b:0:2', selection: {
      anchorOffset: 0, focusOffset: 1, ...extra,
    } }));
  }
});

test('cell/body mixed selection fails explicitly without guessing native geometry', () => {
  assert.throws(() => getCollaborationRegionRects({ regionId: 'c:0:3:0:0', selection: {
    anchorRegionId: 'b:0:2', anchorOffset: 0, focusOffset: 1,
  } }, context()), /unsupported-geometry/);
});

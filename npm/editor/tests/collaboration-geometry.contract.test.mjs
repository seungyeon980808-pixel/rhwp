import test from 'node:test';
import assert from 'node:assert/strict';
import { RhwpEditor } from '../index.js';
import { routeEmbedRequest } from '../../../rhwp-studio/src/embed/rpc-router.ts';
import { getCollaborationRegionRects, CollaborationGeometryError } from '../../../rhwp-studio/src/embed/collaboration-region-geometry.ts';

const response = {
  schemaVersion: 1, regionId: 'b:0:14',
  pages: [{ pageIndex: 2, rects: [{ x: 10, y: 20, width: 90, height: 15 }, { x: 10, y: 35, width: 40, height: 15 }] }],
};

function harness(handler = async () => response) {
  const requests = [];
  const editor = new RhwpEditor({ remove() {} }, {
    supports: () => true,
    request(method, params) {
      requests.push({ method, params });
      return routeEmbedRequest(method, params, { getCollaborationRegionRects: handler });
    },
    destroy() {},
  });
  return { editor, requests };
}

test('returns multi-line page rectangles when the geometry RPC succeeds', async () => {
  // Given: a live router with two measured lines on page three.
  const { editor, requests } = harness();
  // When: the public method requests a region.
  const result = await editor.getCollaborationRegionRects({ regionId: 'b:0:14' });
  // Then: the request and response retain the frozen wire shapes.
  assert.deepEqual(requests, [{ method: 'getCollaborationRegionRects', params: { regionId: 'b:0:14' } }]);
  assert.deepEqual(result, response);
});

test('rejects when the requested region does not exist', async () => {
  // Given: an empty region catalog in the actual geometry handler.
  const { editor } = harness((request) => getCollaborationRegionRects(request, { regions: [], wasm: {}, zoom: 1 }));
  // When/Then: unknown regions propagate the typed error, never empty success.
  await assert.rejects(editor.getCollaborationRegionRects({ regionId: 'b:0:99999' }),
    (error) => error instanceof CollaborationGeometryError && error.code === 'region-not-found');
});

for (const regionId of ['invalid', 'b:-1:2', 'b:0:1.5', 'c:0:1:2', 'b:0:9007199254740992']) {
  test(`rejects malformed region ${regionId} before sending RPC`, async () => {
    // Given: a public editor transport.
    const { editor, requests } = harness();
    // When/Then: malformed ids never reach the transport.
    await assert.rejects(editor.getCollaborationRegionRects({ regionId }),
      (error) => error instanceof TypeError && error.code === 'invalid-region-id');
    assert.deepEqual(requests, []);
  });
}

test('rejects malformed input when callers bypass the npm guard', async () => {
  // Given: a direct RPC caller.
  const handlers = { getCollaborationRegionRects: async () => response };
  // When/Then: the router independently enforces its boundary.
  await assert.rejects(routeEmbedRequest('getCollaborationRegionRects', { regionId: 'b:0:14', extra: true }, handlers),
    (error) => error instanceof CollaborationGeometryError && error.code === 'invalid-region-id');
});

for (const invalid of [
  { ...response, regionId: 'b:0:15' },
  { ...response, pages: [] },
  { ...response, pages: [{ pageIndex: 0, rects: [{ x: 0, y: 0, width: -1, height: 1 }] }] },
  { ...response, pages: [{ pageIndex: 0, rects: [{ x: NaN, y: 0, width: 1, height: 1 }] }] },
]) {
  test('rejects malformed geometry returned by Studio', async () => {
    // Given: an invalid Studio response.
    const { editor } = harness(async () => invalid);
    // When/Then: the response boundary rejects unusable geometry.
    await assert.rejects(editor.getCollaborationRegionRects({ regionId: 'b:0:14' }), TypeError);
  });
}

test('scales every engine line without adding page scroll offsets', () => {
  // Given: authoritative layout rectangles spanning two nonadjacent pages.
  const wasm = {
    getParagraphLength: () => 7,
    getSelectionRects: () => [
      { pageIndex: 0, x: 10, y: 20, width: 30, height: 12 },
      { pageIndex: 3, x: 15, y: 25, width: 35, height: 14 },
    ],
  };
  // When: geometry is requested at 150% zoom.
  const result = getCollaborationRegionRects({ regionId: 'b:0:14' }, {
    regions: [{ id: 'b:0:14', kind: 'body', label: 'body', text: 'content' }], wasm, zoom: 1.5,
  });
  // Then: exact line geometry remains relative to each page container.
  assert.deepEqual(result.pages, [
    { pageIndex: 0, rects: [{ x: 15, y: 30, width: 45, height: 18 }] },
    { pageIndex: 3, rects: [{ x: 22.5, y: 37.5, width: 52.5, height: 21 }] },
  ]);
});

test('reports missing layout when an existing region has no rectangles', () => {
  // Given: a real region whose layout is unavailable.
  const wasm = { getParagraphLength: () => 1, getSelectionRects: () => [] };
  // When: its geometry is measured.
  const result = getCollaborationRegionRects({ regionId: 'b:0:14' }, {
    regions: [{ id: 'b:0:14', kind: 'body', label: 'body', text: 'x' }], wasm, zoom: 1,
  });
  // Then: missing evidence is explicitly reported.
  assert.deepEqual(result.missing, ['layout-rectangles-unavailable']);
});

test('measures a cell text selection through the existing cell selection API', () => {
  // Given: a single-paragraph cell with two layout lines.
  const calls = [];
  const wasm = {
    getCellParagraphCount: () => 1,
    getCellParagraphLength: () => 8,
    getSelectionRectsInCell(...args) {
      calls.push(args);
      return [
        { pageIndex: 1, x: 20, y: 40, width: 70, height: 14 },
        { pageIndex: 1, x: 20, y: 54, width: 25, height: 14 },
      ];
    },
  };
  // When: selected text is measured, independently of the cell boundary.
  const result = getCollaborationRegionRects({ regionId: 'c:0:5:2:3',
    selection: { anchorOffset: 0, focusOffset: 8 } }, {
    regions: [{ id: 'c:0:5:2:3', kind: 'cell', label: 'cell', text: 'abcdefgh' }], wasm, zoom: 1,
  });
  // Then: the cell address and both line rectangles are preserved.
  assert.deepEqual(calls, [[0, 5, 2, 3, 0, 0, 0, 8]]);
  assert.deepEqual(result.pages, [{ pageIndex: 1, rects: [
    { x: 20, y: 40, width: 70, height: 14 },
    { x: 20, y: 54, width: 25, height: 14 },
  ] }]);
});

test('encloses an empty merged cell using its native boundary on every page', () => {
  const calls = [];
  const wasm = {
    getTableCellBboxes(...args) {
      calls.push(args);
      return [
        { cellIdx: 4, pageIndex: 1, x: 0, y: 0, w: 30, h: 20 },
        { cellIdx: 3, row: 0, col: 0, rowSpan: 2, colSpan: 3, pageIndex: 1, x: 20, y: 40, w: 270, h: 180 },
        { cellIdx: 3, row: 0, col: 0, rowSpan: 2, colSpan: 3, pageIndex: 2, x: 20, y: 10, w: 270, h: 80 },
      ];
    },
    getCellParagraphCount() { throw new Error('Empty cells must not depend on text geometry'); },
    getSelectionRectsInCell() { throw new Error('No text rectangles for cell boundaries'); },
  };
  const result = getCollaborationRegionRects({ regionId: 'c:0:5:2:3' }, {
    regions: [{ id: 'c:0:5:2:3', kind: 'cell', label: 'cell', text: '' }], wasm, zoom: 1.5,
  });
  assert.deepEqual(calls, [[0, 5, 2, 0]]);
  assert.deepEqual(result.pages, [
    { pageIndex: 1, rects: [{ x: 30, y: 60, width: 405, height: 270 }] },
    { pageIndex: 2, rects: [{ x: 30, y: 15, width: 405, height: 120 }] },
  ]);
  assert.equal(result.missing, undefined);
});

test('reports missing cell boundaries without falling back to text or a different cell', () => {
  const result = getCollaborationRegionRects({ regionId: 'c:0:5:2:3' }, {
    regions: [{ id: 'c:0:5:2:3', kind: 'cell', label: 'cell', text: 'text' }],
    wasm: { getTableCellBboxes: () => [{ cellIdx: 4, pageIndex: 0, x: 0, y: 0, w: 40, h: 40 }] }, zoom: 1,
  });
  assert.deepEqual(result.pages, []);
  assert.deepEqual(result.missing, ['layout-rectangles-unavailable']);
});

test('cell carets remain at their text position rather than using the cell boundary', () => {
  const result = getCollaborationRegionRects({ regionId: 'c:0:5:2:3',
    selection: { anchorOffset: 2, focusOffset: 2 } }, {
    regions: [{ id: 'c:0:5:2:3', kind: 'cell', label: 'cell', text: 'text' }], zoom: 2,
    wasm: { getCellParagraphCount: () => 1, getCellParagraphLength: () => 4,
      getCursorRectInCell: () => ({ pageIndex: 0, x: 30, y: 40, height: 12 }),
      getTableCellBboxes() { throw new Error('Caret must use text geometry'); } },
  });
  assert.deepEqual(result.pages, [{ pageIndex: 0, rects: [{ x: 60, y: 80, width: 0, height: 24 }] }]);
});

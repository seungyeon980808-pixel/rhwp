import test from 'node:test';
import assert from 'node:assert/strict';
import { RhwpEditor } from '../index.js';
import { routeEmbedRequest } from '../../../rhwp-studio/src/embed/rpc-router.ts';
import { readCollaborationPresence } from '../../../rhwp-studio/src/embed/collaboration-presence.ts';
import { getCollaborationRegionRects } from '../../../rhwp-studio/src/embed/collaboration-region-geometry.ts';

test('native body cursor and backward selection retain the actual focus offset over RPC', async () => {
  const start = { sectionIndex: 0, paragraphIndex: 3, charOffset: 2 };
  const end = { ...start, charOffset: 9 };
  const editor = new RhwpEditor({ remove() {} }, {
    supports: () => true, destroy() {},
    request: (method, params) => routeEmbedRequest(method, params, {
      getCollaborationPresence: async () => readCollaborationPresence({
        getCursorPosition: () => start, getSelection: () => ({ start, end }),
      }),
    }),
  });

  const result = await editor.getCollaborationPresence();

  assert.deepEqual(result, { regionId: 'b:0:3', anchorOffset: 9, focusOffset: 2 });
});

test('collapsed cell cursor keeps the native top-level cell address', () => {
  const input = { getCursorPosition: () => ({ sectionIndex: 1, paragraphIndex: 0,
    parentParaIndex: 5, controlIndex: 2, cellIndex: 4, cellParaIndex: 0, charOffset: 7 }),
    getSelection: () => null };

  const result = readCollaborationPresence(input);

  assert.deepEqual(result, { regionId: 'c:1:5:2:4', anchorOffset: 7, focusOffset: 7 });
});

test('extended presence survives both public editor and RPC boundaries', async () => {
  const start = { sectionIndex: 0, paragraphIndex: 3, charOffset: 2 };
  const end = { sectionIndex: 0, paragraphIndex: 4, charOffset: 2 };
  const editor = new RhwpEditor({ remove() {} }, {
    supports: () => true, destroy() {},
    request: (method, params) => routeEmbedRequest(method, params, {
      getCollaborationPresence: async () => readCollaborationPresence({
        getCursorPosition: () => end, getSelection: () => ({ start, end }),
      }),
    }),
  });
  assert.deepEqual(await editor.getCollaborationPresence(), {
    regionId: 'b:0:4', anchorRegionId: 'b:0:3', anchorOffset: 2, focusOffset: 2,
  });
});

test('multi-paragraph geometry request survives both public editor and RPC boundaries', async () => {
  const selection = { anchorOffset: 1, focusOffset: 2, anchorCellParagraphIndex: 0, focusCellParagraphIndex: 1 };
  let received;
  const editor = new RhwpEditor({ remove() {} }, {
    supports: () => true, destroy() {},
    request: (method, params) => routeEmbedRequest(method, params, {
      getCollaborationRegionRects: async (request) => {
        received = request;
        return { schemaVersion: 1, regionId: request.regionId,
          pages: [{ pageIndex: 0, rects: [{ x: 1, y: 2, width: 3, height: 4 }] }] };
      },
    }),
  });
  await editor.getCollaborationRegionRects({ regionId: 'c:0:3:0:0', selection });
  assert.deepEqual(received, { regionId: 'c:0:3:0:0', selection });
});

test('caret offsets use cursor geometry at the receiving viewport zoom', () => {
  const calls = [];
  const context = { zoom: 1.5, regions: [{ id: 'b:0:3', kind: 'body' }], wasm: {
    getParagraphLength: () => 20,
    getCursorRect: (...args) => { calls.push(args); return { pageIndex: 2, x: 40, y: 60, height: 12 }; },
  } };

  const result = getCollaborationRegionRects({ regionId: 'b:0:3',
    selection: { anchorOffset: 7, focusOffset: 7 } }, context);

  assert.deepEqual(calls, [[0, 3, 7]]);
  assert.deepEqual(result.pages, [{ pageIndex: 2, rects: [{ x: 60, y: 90, width: 0, height: 18 }] }]);
});

test('backward multiline selection requests just the selected offsets and preserves every line', () => {
  const calls = [];
  const context = { zoom: 2, regions: [{ id: 'b:0:3', kind: 'body' }], wasm: {
    getParagraphLength: () => 20,
    getSelectionRects: (...args) => { calls.push(args); return [
      { pageIndex: 0, x: 10, y: 20, width: 30, height: 12 },
      { pageIndex: 1, x: 0, y: 10, width: 20, height: 12 },
    ]; },
  } };

  const result = getCollaborationRegionRects({ regionId: 'b:0:3',
    selection: { anchorOffset: 18, focusOffset: 2 } }, context);

  assert.deepEqual(calls, [[0, 3, 2, 3, 18]]);
  assert.deepEqual(result.pages, [
    { pageIndex: 0, rects: [{ x: 20, y: 40, width: 60, height: 24 }] },
    { pageIndex: 1, rects: [{ x: 0, y: 20, width: 40, height: 24 }] },
  ]);
});

test('rejects stale out-of-range and hostile negative offsets without guessing geometry', async () => {
  const handlers = { getCollaborationRegionRects: async (request) => getCollaborationRegionRects(request, {
    zoom: 1, regions: [{ id: 'b:0:3', kind: 'body' }], wasm: { getParagraphLength: () => 4 },
  }) };

  for (const anchorOffset of [-1, 999]) {
    await assert.rejects(routeEmbedRequest('getCollaborationRegionRects', {
      regionId: 'b:0:3', selection: { anchorOffset, focusOffset: 0 },
    }, handlers), (error) => error.code === 'unsupported-geometry');
  }
});

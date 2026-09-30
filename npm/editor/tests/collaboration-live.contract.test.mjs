import test from 'node:test';
import assert from 'node:assert/strict';

import { RhwpEditor } from '../index.js';

function createHarness(resultByMethod = {}) {
  const requests = [];
  const transport = {
    supports(capability) { return capability === 'collaboration-live-v1'; },
    request(method, params) {
      requests.push({ method, params });
      return Promise.resolve(resultByMethod[method]);
    },
    destroy() {},
  };
  return { editor: new RhwpEditor({ remove() {} }, transport), requests };
}

test('live collaboration applies UTF-16 operations through the narrow RPC', async () => {
  // Given: a live Studio and an emoji-bearing body paragraph.
  const request = {
    regionId: 'b:0:2', expectedText: 'a😀b', origin: 'remote-b',
    ops: [{ type: 'insert', offset: 3, text: 'X' }],
  };
  const applied = { schemaVersion: 1, ok: true, text: 'a😀Xb', revision: 8 };
  const harness = createHarness({
    beginLiveCollaboration: { schemaVersion: 1, readOnly: false },
    applyCollaborationOps: applied,
  });

  // When: live mode begins and the host applies one operation.
  const begin = await harness.editor.beginLiveCollaboration();
  const result = await harness.editor.applyCollaborationOps(request);

  // Then: input remains enabled and the UTF-16 operation is preserved exactly.
  assert.deepEqual(begin, { schemaVersion: 1, readOnly: false });
  assert.deepEqual(result, applied);
  assert.deepEqual(harness.requests, [
    { method: 'beginLiveCollaboration', params: {} },
    { method: 'applyCollaborationOps', params: request },
  ]);
});

test('live collaboration rejects malformed offsets before RPC', async () => {
  // Given: a Studio advertising live collaboration.
  const harness = createHarness();

  // When/Then: a fractional offset is rejected at the public boundary.
  await assert.rejects(harness.editor.applyCollaborationOps({
    regionId: 'b:0:0', expectedText: 'a', origin: 'remote',
    ops: [{ type: 'insert', offset: 0.5, text: 'x' }],
  }), /valid ops/u);
  assert.deepEqual(harness.requests, []);
});

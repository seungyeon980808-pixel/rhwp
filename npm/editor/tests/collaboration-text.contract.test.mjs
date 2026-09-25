import test from 'node:test';
import assert from 'node:assert/strict';

import { RhwpEditor } from '../index.js';

function createHarness(resultByMethod = {}) {
  const requests = [];
  const transport = {
    supports(capability) {
      return capability === 'collaboration-text-v1';
    },
    request(method, params) {
      requests.push({ method, params });
      return Promise.resolve(resultByMethod[method]);
    },
    destroy() {},
  };
  return { editor: new RhwpEditor({ remove() {} }, transport), requests };
}

test('collaboration v1 begins permanent read-only mode through one parameterless RPC', async () => {
  // Given: a Studio advertising collaboration-text-v1.
  const harness = createHarness({
    beginCollaboration: { schemaVersion: 1, readOnly: true },
  });

  // When: the host begins collaboration.
  const result = await harness.editor.beginCollaboration();

  // Then: the strict v1 acknowledgement and only its RPC are observable.
  assert.deepEqual(result, { schemaVersion: 1, readOnly: true });
  assert.deepEqual(harness.requests, [{ method: 'beginCollaboration', params: {} }]);
});

test('collaboration v1 returns strict body and cell region DTOs', async () => {
  // Given: deterministic regions from the frozen document structure.
  const regions = [
    { id: 'b:0:2', kind: 'body', label: 'Body 1.3', text: 'alpha' },
    { id: 'c:0:4:0:1', kind: 'cell', label: 'Cell 1.5.1.2', text: 'beta' },
  ];
  const harness = createHarness({ getCollaborationRegions: regions });

  // When: the host inspects collaboration regions.
  const result = await harness.editor.getCollaborationRegions();

  // Then: the DTOs and parameterless RPC are preserved exactly.
  assert.deepEqual(result, regions);
  assert.deepEqual(harness.requests, [{ method: 'getCollaborationRegions', params: {} }]);
});

test('collaboration v1 applies expected-text replacement through the narrow RPC', async () => {
  // Given: a server-authorized replacement and a successful engine result.
  const request = { regionId: 'b:0:2', expectedText: 'alpha', text: 'changed' };
  const applied = {
    schemaVersion: 1,
    ok: true,
    region: { id: 'b:0:2', kind: 'body', label: 'Body 1.3', text: 'changed' },
    revision: 7,
  };
  const harness = createHarness({ applyCollaborationText: applied });

  // When: the host applies the replacement.
  const result = await harness.editor.applyCollaborationText(request);

  // Then: no broader mutation shape is sent.
  assert.deepEqual(result, applied);
  assert.deepEqual(harness.requests, [{ method: 'applyCollaborationText', params: request }]);
});

test('collaboration v1 fails closed without capability or with malformed input', async () => {
  // Given: a Studio without collaboration and a Studio with collaboration.
  const unsupported = createHarness();
  unsupported.editor._transport.supports = () => false;
  const supported = createHarness();

  // When/Then: neither unsupported nor newline-bearing requests reach Studio.
  await assert.rejects(unsupported.editor.beginCollaboration(), /collaboration text v1 is not supported/i);
  await assert.rejects(
    supported.editor.applyCollaborationText({ regionId: 'b:0:0', expectedText: 'a', text: 'a\nb' }),
    /single-line plain text/i,
  );
  assert.deepEqual(unsupported.requests, []);
  assert.deepEqual(supported.requests, []);
});

import test from 'node:test';
import assert from 'node:assert/strict';

import { RhwpEditor } from '../index.js';

function createHarness(capabilities, result = { ok: true }) {
  const requests = [];
  const transport = {
    supports(capability) {
      return capabilities.includes(capability);
    },
    request(method, params) {
      requests.push({ method, params });
      return Promise.resolve(result);
    },
    destroy() {},
  };
  return { editor: new RhwpEditor({ remove() {} }, transport), requests };
}

test('history undo v1 sends one parameterless trusted RPC and returns its strict result', async () => {
  const harness = createHarness(['history-undo-v1']);

  assert.deepEqual(await harness.editor.undo(), { ok: true });
  assert.deepEqual(harness.requests, [{ method: 'undo', params: {} }]);
});

test('history undo v1 fails closed when Studio lacks the capability', async () => {
  const harness = createHarness([]);

  await assert.rejects(harness.editor.undo(), /history undo v1 is not supported/i);
  assert.deepEqual(harness.requests, []);
});

test('history undo v1 rejects malformed Studio results', async () => {
  const harness = createHarness(['history-undo-v1'], { ok: false, reason: 'arbitrary' });

  await assert.rejects(harness.editor.undo(), /invalid history undo result/i);
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { EditorTransport } from '../transport.js';
import { RhwpEditor } from '../index.js';
import { installEmbedRuntime } from '../../../rhwp-studio/src/embed/runtime.ts';
import { getCollaborationRegionRects } from '../../../rhwp-studio/src/embed/collaboration-region-geometry.ts';

async function runtimeHarness() {
  let onMessage;
  const parentWindow = { addEventListener() {}, removeEventListener() {} };
  const hostWindow = {
    addEventListener(_event, listener) { onMessage = listener; },
    removeEventListener() {},
  };
  const stop = installEmbedRuntime({
    hostWindow, parentWindow,
    handlers: {
      getCollaborationRegionRects: (request) => getCollaborationRegionRects(request, {
        regions: [], wasm: {}, zoom: 1,
      }),
    },
  });
  const transport = new EditorTransport({ contentWindow: {
    postMessage(data, _origin, ports) {
      onMessage({ data, ports, source: parentWindow, origin: 'https://host.example' });
    },
  } }, 'https://studio.example', { window: parentWindow, requestTimeoutMs: 1000, handshakeTimeoutMs: 1000 });
  await transport.connect();
  return {
    editor: new RhwpEditor({ remove() {} }, transport), transport,
    close() { transport.destroy(); stop(); },
  };
}

test('preserves not-found code through runtime and MessagePort transport', async () => {
  // Given: the actual embed runtime connected to the actual npm transport.
  const harness = await runtimeHarness();
  try {
    // When/Then: the public method preserves the domain code over the wire.
    await assert.rejects(harness.editor.getCollaborationRegionRects({ regionId: 'b:0:999999' }),
      (error) => error.code === 'region-not-found');
  } finally { harness.close(); }
});

test('preserves invalid-id code through runtime when the public guard is bypassed', async () => {
  // Given: a direct transport caller using the actual embed runtime.
  const harness = await runtimeHarness();
  try {
    // When/Then: malformed RPC input retains its distinct domain code.
    await assert.rejects(harness.transport.request('getCollaborationRegionRects', { regionId: 'malformed' }),
      (error) => error.code === 'invalid-region-id');
  } finally { harness.close(); }
});

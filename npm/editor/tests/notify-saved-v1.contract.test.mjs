import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { EditorTransport } from '../transport.js';
import { RhwpEditor } from '../index.js';

function createStudio(capabilities, result) {
  const requests = [];
  let server;
  const contentWindow = {
    postMessage(message, _targetOrigin, ports) {
      server = ports[0];
      server.onmessage = ({ data }) => {
        requests.push(data);
        server.postMessage({
          type: 'rhwp-response', version: 1, sessionId: data.sessionId,
          id: data.id, result,
        });
      };
      server.start();
      server.postMessage({
        type: 'rhwp-connected', version: 1, sessionId: message.sessionId,
        capabilities,
      });
    },
  };
  return { contentWindow, requests, closeServer: () => server?.close() };
}

async function connectEditor(contentWindow) {
  const transport = new EditorTransport(
    { contentWindow },
    'https://studio.example/app',
    {
      window: { addEventListener() {}, removeEventListener() {} },
      requestTimeoutMs: 100,
      handshakeTimeoutMs: 100,
    },
  );
  await transport.connect();
  return { transport, editor: new RhwpEditor({}, transport) };
}

test('notify-saved-v1 광고 시 notifySaved는 fileName을 전달하고 결과를 반환한다', async () => {
  const { contentWindow, requests, closeServer } = createStudio(
    ['transferable-array-buffer', 'notify-saved-v1'],
    { ok: true, wasDirty: true },
  );
  const { transport, editor } = await connectEditor(contentWindow);

  try {
    assert.deepEqual(await editor.notifySaved('b.hwp'), { ok: true, wasDirty: true });
    assert.deepEqual(await editor.notifySaved(), { ok: true, wasDirty: true });

    assert.equal(requests.length, 2);
    assert.equal(requests[0].method, 'notifySaved');
    assert.deepEqual(requests[0].params, { fileName: 'b.hwp' });
    assert.equal(requests[1].method, 'notifySaved');
    assert.deepEqual(requests[1].params, {});
  } finally {
    transport.destroy();
    closeServer();
  }
});

test('notify-saved-v1 미광고 시 notifySaved는 요청 없이 명시적으로 실패한다', async () => {
  const { contentWindow, requests, closeServer } = createStudio(
    ['transferable-array-buffer'],
    { ok: true, wasDirty: true },
  );
  const { transport, editor } = await connectEditor(contentWindow);

  try {
    await assert.rejects(async () => editor.notifySaved(), /notifySaved is not supported/);
    assert.equal(requests.length, 0);
  } finally {
    transport.destroy();
    closeServer();
  }
});

test('index.d.ts는 notifySaved 선언과 저장 계약 JSDoc을 포함한다', () => {
  const declarations = readFileSync(
    fileURLToPath(new URL('../index.d.ts', import.meta.url)),
    'utf8',
  );
  assert.match(
    declarations,
    /notifySaved\(fileName\?: string\): Promise<\{ ok: true; wasDirty: boolean \}>/,
  );
});

test('revisioned-save-v1은 검증 바이트와 revision을 받고 동일 revision일 때만 저장 완료를 통지한다', async () => {
  const responses = [
    { schemaVersion: 1, bytes: new Uint8Array([7, 8]), revision: 12 },
    { ok: false, reason: 'document-changed', currentRevision: 13 },
  ];
  const { contentWindow, requests, closeServer } = createStudio(
    ['transferable-array-buffer', 'revisioned-save-v1'],
    null,
  );
  let responseIndex = 0;
  const originalPostMessage = contentWindow.postMessage;
  contentWindow.postMessage = function postMessage(message, targetOrigin, ports) {
    originalPostMessage.call(this, message, targetOrigin, ports);
    const server = ports[0];
    const originalHandler = server.onmessage;
    server.onmessage = ({ data }) => {
      requests.push(data);
      server.postMessage({
        type: 'rhwp-response', version: 1, sessionId: data.sessionId,
        id: data.id, result: responses[responseIndex++],
      });
    };
    void originalHandler;
  };
  const { transport, editor } = await connectEditor(contentWindow);

  try {
    assert.deepEqual(await editor.exportDocumentForSave('hwp'), responses[0]);
    assert.deepEqual(await editor.notifySavedIfUnchanged(12, 'b.hwp'), responses[1]);
    assert.deepEqual(requests.map(({ method, params }) => ({ method, params })), [
      { method: 'exportDocumentForSave', params: { format: 'hwp' } },
      { method: 'notifySavedIfUnchanged', params: { revision: 12, fileName: 'b.hwp' } },
    ]);
  } finally {
    transport.destroy();
    closeServer();
  }
});

test('revisioned-save-v1 미광고 및 잘못된 revision은 요청 전에 차단한다', async () => {
  const { contentWindow, requests, closeServer } = createStudio(
    ['transferable-array-buffer'],
    { ok: true, wasDirty: true, currentRevision: 0 },
  );
  const { transport, editor } = await connectEditor(contentWindow);

  try {
    await assert.rejects(() => editor.exportDocumentForSave('hwp'), /Revisioned save v1/);
    await assert.rejects(() => editor.exportDocumentForSave('pdf'), /format/);
    await assert.rejects(() => editor.notifySavedIfUnchanged(-1), /revision/);
    assert.equal(requests.length, 0);
  } finally {
    transport.destroy();
    closeServer();
  }
});

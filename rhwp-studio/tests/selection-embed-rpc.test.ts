import test from 'node:test';
import assert from 'node:assert/strict';

import { EMBED_CAPABILITIES } from '../src/embed/protocol.ts';
import {
  routeEmbedRequest,
  type EmbedRpcHandlers,
  type EmbedSelectionSnapshotV1,
} from '../src/embed/rpc-router.ts';

const SNAPSHOT: EmbedSelectionSnapshotV1 = {
  schemaVersion: 1,
  snapshotId: 'selection-7-1',
  revision: 7,
  text: '선택한 문장',
  scope: 'body',
};

function handlers(): EmbedRpcHandlers {
  return {
    ready: async () => true,
    loadFile: async () => ({ pageCount: 1 }),
    pageCount: async () => 1,
    getRendererDiagnostics: async (page) => ({
      schemaVersion: 1,
      request: null,
      initialized: true,
      initializationError: null,
      effectiveBackend: 'canvas2d',
      backendFallbackReason: null,
      selection: null,
      page: { index: page, canvaskit: null },
    }),
    getPageSvg: async () => '<svg/>',
    exportHwp: async () => new Uint8Array(),
    exportHwpx: async () => new Uint8Array(),
    exportHml: async () => new Uint8Array(),
    getHmlSaveState: async () => ({ sourceFormat: 'hwp', hmlSavable: false, blockers: [] }),
    exportHwpVerify: async () => ({ recovered: true }),
    notifySaved: async () => ({ ok: true, wasDirty: false }),
    getSelectionSnapshot: async () => SNAPSHOT,
    replaceSelection: async (snapshotId, text) => ({
      ok: true,
      snapshotId,
      revision: text.length,
    }),
  };
}

test('embed selection edit v1은 capability와 snapshot 조회를 공개한다', async () => {
  // Given: selection 편집 핸들러가 준비되어 있다.
  const rpcHandlers = handlers();

  // When: capability와 선택 snapshot을 조회한다.
  const snapshot = await routeEmbedRequest('getSelectionSnapshot', {}, rpcHandlers);

  // Then: 호스트가 기능 지원을 확인하고 snapshot을 그대로 받는다.
  assert.equal(EMBED_CAPABILITIES.includes('selection-edit-v1'), true);
  assert.deepEqual(snapshot, SNAPSHOT);
});

test('embed selection edit v1은 snapshot id와 교체 텍스트를 함께 전달한다', async () => {
  // Given: selection 편집 핸들러가 준비되어 있다.
  const rpcHandlers = handlers();

  // When: snapshot에 새 텍스트를 적용한다.
  const result = await routeEmbedRequest(
    'replaceSelection',
    { snapshotId: SNAPSHOT.snapshotId, text: '바꾼 문장' },
    rpcHandlers,
  );

  // Then: 두 입력이 손실 없이 핸들러에 전달된다.
  assert.deepEqual(result, {
    ok: true,
    snapshotId: SNAPSHOT.snapshotId,
    revision: 5,
  });
});

test('embed selection edit v1은 비어 있는 snapshot id를 거부한다', async () => {
  // Given: selection 편집 핸들러가 준비되어 있다.
  const rpcHandlers = handlers();

  // When: 비어 있는 snapshot id로 교체를 요청한다.
  const request = routeEmbedRequest(
    'replaceSelection',
    { snapshotId: '', text: '바꾼 문장' },
    rpcHandlers,
  );

  // Then: 편집 핸들러 호출 전에 입력 오류가 발생한다.
  await assert.rejects(request, /snapshotId must be a non-empty string/);
});



test('document editing RPC validates its mode and forwards only table or supported writing commands', async () => {
  const rpc = handlers(); const calls: unknown[] = [];
  rpc.setDocumentEditingMode = async mode => { calls.push(mode); };
  rpc.executeWritingCommand = async command => { calls.push(command); return true; };
  await routeEmbedRequest('setDocumentEditingMode', { canRequest: true, exclusive: true, frozen: false, expectedRevision: 7 }, rpc);
  assert.equal(await routeEmbedRequest('executeWritingCommand', { command: 'table:cell-merge' }, rpc), true);
  assert.equal(await routeEmbedRequest('executeWritingCommand', { command: 'table:pending-resize' }, rpc), true);
  await assert.rejects(routeEmbedRequest('executeWritingCommand', { command: 'file:open' }, rpc), /Invalid writing command/);
  await assert.rejects(routeEmbedRequest('setDocumentEditingMode', { canRequest: false, exclusive: true }, rpc));
  assert.deepEqual(calls, [{ canRequest: true, exclusive: true, frozen: false, expectedRevision: 7 }, 'table:cell-merge', 'table:pending-resize']);
  await routeEmbedRequest('setDocumentEditingMode', { canRequest: true, exclusive: true, tableAddress: 'c:0:4:1' }, rpc);
  assert.deepEqual(calls.at(-1), { canRequest: true, exclusive: true, tableAddress: 'c:0:4:1' });
  await assert.rejects(routeEmbedRequest('setDocumentEditingMode', { canRequest: true, exclusive: true, tableAddress: 'c:0:4:1:2' }, rpc));
  await assert.rejects(routeEmbedRequest('setDocumentEditingMode', { canRequest: true, exclusive: false, tableAddress: 'c:0:4:1' }, rpc));
});

test('writing RPC accepts registered rich-format checkpoint commands and rejects unknown IDs before invoking handlers', async () => {
  const rpc = handlers(); const calls: string[] = [];
  rpc.executeWritingCommand = async command => { calls.push(command); return false; };
  const commands = ['format:char-shape', 'format:para-shape', 'format:toggle-numbering', 'format:toggle-bullet',
    'format:style-dialog', 'format:normal', 'format:superscript', 'format:line-spacing-increase',
    'edit:format-paste', 'insert:equation', 'insert:symbols', 'page:break', 'page:setup', 'file:page-setup'];
  for (const command of commands)
    assert.equal(await routeEmbedRequest('executeWritingCommand', { command }, rpc), false, 'permission refusal must propagate');
  assert.deepEqual(calls, commands);
  for (const command of ['format:unknown', 'table:unknown', 'insert:unknown', 'page:unknown', 'file:open', 'file:save', 'edit:paste', 'edit:format-copy', '', '__proto__', 'table:cell-merge;file:open'])
    await assert.rejects(routeEmbedRequest('executeWritingCommand', { command }, rpc), /Invalid writing command/);
  assert.deepEqual(calls, commands, 'invalid commands never reach the execution handler');
  delete rpc.executeWritingCommand;
  await assert.rejects(routeEmbedRequest('executeWritingCommand', { command: 'format:char-shape' }, rpc), /Invalid writing command/);
});

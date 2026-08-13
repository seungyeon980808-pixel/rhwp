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


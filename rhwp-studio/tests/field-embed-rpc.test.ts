import test from 'node:test';
import assert from 'node:assert/strict';

import { EMBED_CAPABILITIES } from '../src/embed/protocol.ts';
import { routeEmbedRequest, type EmbedRpcHandlers } from '../src/embed/rpc-router.ts';

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
    getFields: async () => [{
      schemaVersion: 1,
      fieldId: 7,
      name: '학생명',
      guide: '이름 입력',
      value: '',
      editable: true,
    }],
    fillFields: async (entries) => ({ ok: true, updated: entries.length }),
  };
}

test('field fill v1은 필드 목록과 capability를 공개한다', async () => {
  const fields = await routeEmbedRequest('getFields', {}, handlers());

  assert.equal(EMBED_CAPABILITIES.includes('field-fill-v1'), true);
  assert.deepEqual(fields, [{
    schemaVersion: 1,
    fieldId: 7,
    name: '학생명',
    guide: '이름 입력',
    value: '',
    editable: true,
  }]);
});

test('field fill v1은 id와 값을 검증해 한 번에 전달한다', async () => {
  const result = await routeEmbedRequest('fillFields', {
    entries: [{ fieldId: 7, value: '김하늘' }, { fieldId: 8, value: '2학년 3반' }],
  }, handlers());

  assert.deepEqual(result, { ok: true, updated: 2 });
  await assert.rejects(
    routeEmbedRequest('fillFields', { entries: [{ fieldId: -1, value: '오류' }] }, handlers()),
    /fieldId must be a non-negative safe integer/,
  );
});

import test from 'node:test';
import assert from 'node:assert/strict';

import { RhwpEditor } from '../index.js';

function createHarness(capabilities) {
  const requests = [];
  const transport = {
    supports(capability) {
      return capabilities.includes(capability);
    },
    request(method, params) {
      requests.push({ method, params });
      if (method === 'inspectApprovedTemplate') return Promise.resolve(INSPECTION);
      return Promise.resolve(EDIT_RESULT);
    },
    destroy() {},
  };
  return { editor: new RhwpEditor({ remove() {} }, transport), requests };
}

const DIGEST = `sha256:${'a'.repeat(64)}`;
const INSPECTION = {
  schemaVersion: 1,
  format: 'hwp',
  structureDigest: DIGEST,
  pageCount: 1,
  sectionCount: 1,
  paragraphCount: 1,
  topLevelTableCount: 0,
  nestedTableCount: 0,
  pictureCount: 0,
  shapeCount: 0,
  binDataCount: 0,
  protection: {
    schemaVersion: 1,
    status: 'standard',
    pageCount: 1,
    tableCount: 0,
    nestedTableCount: 0,
    pictureCount: 0,
    shapeCount: 0,
    reasons: [],
  },
  nativeFields: [],
  bodyCandidates: [],
  tableCells: [],
  truncated: false,
};
const EDIT_RESULT = {
  schemaVersion: 1,
  ok: true,
  updated: 0,
  changedPages: [],
  warnings: [],
  overflowTargets: [],
  rejectedTargets: [],
  reason: null,
};

test('approved template inspection, preflight, apply use one narrow capability', async () => {
  const harness = createHarness(['approved-template-edit-v1']);
  const request = {
    schemaVersion: 1,
    templateId: 'school-form-1',
    expectedStructureDigest: 'sha256:template',
    targets: [{
      kind: 'table-cell',
      targetId: 'student-name',
      tableIndex: 0,
      row: 1,
      col: 1,
      expectedTextHash: 'sha256:placeholder',
      adjacentLabelDigest: 'sha256:labels',
      mergedAnchor: { row: 1, col: 1 },
      value: '김하늘',
      maxChars: 20,
      maxLines: 1,
      keepStyle: true,
    }],
  };

  await harness.editor.inspectApprovedTemplate();
  await harness.editor.preflightApprovedTemplateEdits(request);
  await harness.editor.applyApprovedTemplateEdits(request, 'preflight-token');

  assert.deepEqual(harness.requests, [
    { method: 'inspectApprovedTemplate', params: {} },
    { method: 'preflightApprovedTemplateEdits', params: { request } },
    {
      method: 'applyApprovedTemplateEdits',
      params: { request, preflightToken: 'preflight-token' },
    },
  ]);
});

test('approved template API fails closed when Studio lacks the capability', async () => {
  const harness = createHarness([]);

  await assert.rejects(
    harness.editor.inspectApprovedTemplate(),
    /approved template edit v1 is not supported/i,
  );
  assert.deepEqual(harness.requests, []);
});

test('approved template API rejects malformed Studio result shapes', async () => {
  const transport = {
    supports: () => true,
    request: () => Promise.resolve({ ok: true, command: 'run' }),
    destroy() {},
  };
  const editor = new RhwpEditor({ remove() {} }, transport);

  await assert.rejects(editor.inspectApprovedTemplate(), /Invalid approved template inspection/);
  await assert.rejects(
    editor.preflightApprovedTemplateEdits({ schemaVersion: 1, targets: [] }),
    /Invalid approved template edit result/,
  );
});

test('reference text extraction transfers bytes through isolated preview capability', async () => {
  const harness = createHarness(['reference-text-extract-v1']);
  const bytes = new Uint8Array([1, 2, 3]);

  await harness.editor.extractReferenceText(bytes, 'reference.hwp', {
    maxChars: 4000,
    maxPages: 3,
  });

  assert.deepEqual(harness.requests, [{
    method: 'extractReferenceText',
    params: {
      data: bytes,
      fileName: 'reference.hwp',
      options: { maxChars: 4000, maxPages: 3 },
    },
  }]);
});

test('reference text extraction rejects unsupported extensions before RPC', async () => {
  const harness = createHarness(['reference-text-extract-v1']);

  await assert.rejects(
    harness.editor.extractReferenceText(new Uint8Array([1]), 'reference.docx'),
    /HWP, HWPX, or HML/i,
  );
  await assert.rejects(
    harness.editor.extractReferenceText(new Uint8Array([1]), '../reference.hwp'),
    /basename/i,
  );
  await assert.rejects(
    harness.editor.extractReferenceText(new Uint8Array([1]), 'reference.hwp', { command: 'run' }),
    /only maxChars and maxPages/i,
  );
  assert.deepEqual(harness.requests, []);
});

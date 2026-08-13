import test from 'node:test';
import assert from 'node:assert/strict';

import { RhwpEditor } from '../index.js';

function createHarness(supported) {
  const requests = [];
  const transport = {
    supports(capability) {
      return supported && capability === 'field-fill-v1';
    },
    request(method, params) {
      requests.push({ method, params });
      return Promise.resolve({ ok: true });
    },
    destroy() {},
  };
  return { editor: new RhwpEditor({ remove() {} }, transport), requests };
}

test('RhwpEditor는 필드 조회와 일괄 입력을 field-fill-v1 RPC로 전달한다', async () => {
  const harness = createHarness(true);

  await harness.editor.getFields();
  await harness.editor.fillFields([{ fieldId: 7, value: '김하늘' }]);

  assert.deepEqual(harness.requests, [
    { method: 'getFields', params: {} },
    { method: 'fillFields', params: { entries: [{ fieldId: 7, value: '김하늘' }] } },
  ]);
});

test('RhwpEditor는 field-fill-v1 미지원 Studio에 요청하지 않는다', async () => {
  const harness = createHarness(false);

  await assert.rejects(harness.editor.getFields(), /field fill v1 is not supported/i);
  assert.deepEqual(harness.requests, []);
});

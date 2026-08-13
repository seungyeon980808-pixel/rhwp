import test from 'node:test';
import assert from 'node:assert/strict';

import { RhwpEditor } from '../index.js';

function createHarness(supported) {
  const requests = [];
  const transport = {
    supports(capability) {
      return supported && capability === 'selection-edit-v1';
    },
    request(method, params) {
      requests.push({ method, params });
      return Promise.resolve({ ok: true });
    },
    destroy() {},
  };
  return {
    editor: new RhwpEditor({ remove() {} }, transport),
    requests,
  };
}

test('RhwpEditor는 선택 snapshot 조회를 selection-edit-v1 RPC로 전달한다', async () => {
  // Given: selection-edit-v1을 지원하는 Studio가 연결되어 있다.
  const harness = createHarness(true);

  // When: 현재 선택 snapshot을 조회한다.
  await harness.editor.getSelectionSnapshot();

  // Then: 대응하는 RPC 한 건만 전송된다.
  assert.deepEqual(harness.requests, [
    { method: 'getSelectionSnapshot', params: {} },
  ]);
});

test('RhwpEditor는 snapshot id와 교체 텍스트를 함께 전달한다', async () => {
  // Given: selection-edit-v1을 지원하는 Studio가 연결되어 있다.
  const harness = createHarness(true);

  // When: 선택 snapshot에 새 텍스트를 적용한다.
  await harness.editor.replaceSelection('selection-7-1', '바꾼 문장');

  // Then: snapshot id와 텍스트가 같은 RPC에 담긴다.
  assert.deepEqual(harness.requests, [
    {
      method: 'replaceSelection',
      params: { snapshotId: 'selection-7-1', text: '바꾼 문장' },
    },
  ]);
});

test('RhwpEditor는 capability가 없으면 selection RPC를 보내지 않는다', async () => {
  // Given: selection-edit-v1을 지원하지 않는 Studio가 연결되어 있다.
  const harness = createHarness(false);

  // When: 선택 snapshot 조회를 요청한다.
  const request = harness.editor.getSelectionSnapshot();

  // Then: 명시적으로 실패하고 RPC는 전송하지 않는다.
  await assert.rejects(request, /selection edit v1 is not supported/i);
  assert.deepEqual(harness.requests, []);
});


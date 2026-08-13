import test from 'node:test';
import assert from 'node:assert/strict';

import {
  SelectionBridge,
  type HostSelection,
  type SelectionEditingPort,
} from '../src/embed/selection-bridge.ts';

class FakeSelectionPort implements SelectionEditingPort {
  selection: HostSelection | null;
  readonly replacements: string[] = [];

  constructor(selection: HostSelection | null) {
    this.selection = selection;
  }

  readSelectionForHost(): HostSelection | null {
    return this.selection;
  }

  replaceSelectionFromHost(text: string): boolean {
    this.replacements.push(text);
    return true;
  }
}

const BODY_SELECTION: HostSelection = {
  text: '선택한 문장',
  signature: 'body:0:2:0-2:5',
  scope: 'body',
};

test('SelectionBridge는 선택 텍스트와 revision을 snapshot으로 고정한다', () => {
  // Given: 본문 텍스트가 선택되어 있다.
  const bridge = new SelectionBridge();
  const port = new FakeSelectionPort(BODY_SELECTION);

  // When: 호스트용 snapshot을 만든다.
  const snapshot = bridge.capture(port);

  // Then: 선택 내용과 최초 revision이 함께 반환된다.
  assert.deepEqual(snapshot, {
    schemaVersion: 1,
    snapshotId: 'selection-0-1',
    revision: 0,
    text: BODY_SELECTION.text,
    scope: 'body',
  });
});

test('SelectionBridge는 동일 snapshot과 선택에만 교체를 적용한다', () => {
  // Given: 선택 snapshot을 만든 뒤 문서와 선택이 유지되어 있다.
  const bridge = new SelectionBridge();
  const port = new FakeSelectionPort(BODY_SELECTION);
  const snapshot = bridge.capture(port);
  assert.ok(snapshot);

  // When: snapshot에 새 문장을 적용한다.
  const result = bridge.replace(port, snapshot.snapshotId, '바꾼 문장');

  // Then: 한 번만 교체되고 성공 결과를 반환한다.
  assert.deepEqual(port.replacements, ['바꾼 문장']);
  assert.deepEqual(result, {
    ok: true,
    snapshotId: snapshot.snapshotId,
    revision: 0,
  });
});

test('SelectionBridge는 snapshot 이후 문서가 바뀌면 적용하지 않는다', () => {
  // Given: 선택 snapshot 뒤 다른 편집이 문서를 변경했다.
  const bridge = new SelectionBridge();
  const port = new FakeSelectionPort(BODY_SELECTION);
  const snapshot = bridge.capture(port);
  assert.ok(snapshot);
  bridge.noteDocumentMutation();

  // When: 오래된 snapshot을 적용한다.
  const result = bridge.replace(port, snapshot.snapshotId, '바꾼 문장');

  // Then: stale-document로 거부하고 문서를 건드리지 않는다.
  assert.deepEqual(result, { ok: false, reason: 'stale-document' });
  assert.deepEqual(port.replacements, []);
});

test('SelectionBridge는 현재 선택이 달라지면 적용하지 않는다', () => {
  // Given: snapshot 뒤 사용자가 다른 범위를 선택했다.
  const bridge = new SelectionBridge();
  const port = new FakeSelectionPort(BODY_SELECTION);
  const snapshot = bridge.capture(port);
  assert.ok(snapshot);
  port.selection = { ...BODY_SELECTION, signature: 'body:0:4:0-4:5' };

  // When: 기존 snapshot을 적용한다.
  const result = bridge.replace(port, snapshot.snapshotId, '바꾼 문장');

  // Then: selection-changed로 거부하고 문서를 건드리지 않는다.
  assert.deepEqual(result, { ok: false, reason: 'selection-changed' });
  assert.deepEqual(port.replacements, []);
});


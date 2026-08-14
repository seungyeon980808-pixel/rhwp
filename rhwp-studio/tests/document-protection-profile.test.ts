import test from 'node:test';
import assert from 'node:assert/strict';

import { buildDocumentProtectionProfile } from '../src/embed/document-protection-profile.ts';

test('복합 문서는 구조 신호를 집계해 보호 상태가 된다', () => {
  const trees = Array.from({ length: 8 }, () => ({
    root: {
      kind: 'group',
      children: [{
        kind: 'group',
        groupKind: { kind: 'table' },
        children: [{
          kind: 'clipRect',
          clipKind: 'tableCell',
          child: {
            kind: 'group',
            children: [{ kind: 'group', groupKind: { kind: 'table' }, children: [] }],
          },
        }],
      }, {
        kind: 'leaf',
        ops: [{ type: 'image' }, { type: 'rectangle' }],
      }],
    },
  }));

  const profile = buildDocumentProtectionProfile(trees);

  assert.equal(profile.status, 'protected');
  assert.equal(profile.pageCount, 8);
  assert.equal(profile.renderedTableCount, 16);
  assert.equal(profile.imageCount, 8);
  assert.equal(profile.nestedTableCount, 8);
  assert.deepEqual(profile.safeEditScopes, ['single-body-paragraph', 'single-table-cell-paragraph']);
});

test('단순 한 쪽 본문은 표·개체가 없으면 표준 상태를 유지한다', () => {
  const profile = buildDocumentProtectionProfile([{
    root: { kind: 'leaf', ops: [{ type: 'textRun' }] },
  }]);

  assert.equal(profile.status, 'standard');
  assert.deepEqual(profile.reasons, []);
});

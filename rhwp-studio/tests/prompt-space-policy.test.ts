import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { PromptSpacePolicy } from '../src/embed/prompt-space-policy.ts';
import type { WasmBridge } from '../src/core/wasm-bridge.ts';
import type { DocumentPosition } from '../src/core/types.ts';
const id = 'c:0:0:0:0';
const make = (memberId = 'bob') => {
  let text = '甲\n乙\n😀丙';
  const wasm = { getCellParagraphCount: () => text.split('\n').length,
    getCellParagraphLength: (_s: number, _p: number, _c: number, _i: number, para: number) => [...text.split('\n')[para]].length,
    getTextInCell: (_s: number, _p: number, _c: number, _i: number, para: number) => text.split('\n')[para] } as unknown as WasmBridge;
  const policy = new PromptSpacePolicy({ memberId, spaces: [
    { id: 'a', regionId: id, start: 0, end: 1, memberId: 'alice' },
    { id: 'b', regionId: id, start: 2, end: 3, memberId: 'bob' },
    { id: 'c', regionId: id, start: 4, end: 7, memberId: 'chris' }], texts: [{ regionId: id, text }] });
  return { wasm, policy, change: (next: string) => { text = next; } };
};
const pos = (para: number, charOffset: number): DocumentPosition => ({ sectionIndex: 0, paragraphIndex: 0, parentParaIndex: 0, controlIndex: 0, cellIndex: 0, cellParaIndex: para, charOffset });
test('native typing and selection stay inside the assigned paragraph', () => {
  const { policy, wasm } = make();
  assert.equal(policy.allows(wasm, pos(1, 0), pos(1, 1)), true);
  assert.equal(policy.allows(wasm, pos(0, 0), pos(0, 1)), false);
  assert.equal(policy.allows(wasm, pos(1, 0), pos(2, 1)), false);
  assert.equal(policy.allows(wasm, pos(1, 0), pos(1, 0), -1), false);
  assert.equal(policy.allows(wasm, pos(1, 1), pos(1, 1), 1), false);
});
test('native guards follow local Enter expansion and neighbouring remote text', () => {
  const { policy, wasm, change } = make();
  change('甲\n乙\n追加\n😀丙');
  assert.equal(policy.allows(wasm, pos(2, 2), pos(2, 2)), true);
  assert.equal(policy.allows(wasm, pos(3, 0), pos(3, 0)), false);
  change('甲ホスト\n乙\n追加\n😀丙');
  assert.equal(policy.allows(wasm, pos(2, 2), pos(2, 2)), true);
  assert.equal(policy.allows(wasm, pos(0, 0), pos(0, 1)), false);
});
test('UTF-16 server anchors permit a whole emoji and prevent adjacent deletion', () => {
  const { policy, wasm } = make('chris');
  assert.equal(policy.allows(wasm, pos(2, 0), pos(2, 1)), true);
  assert.equal(policy.allows(wasm, pos(2, 0), pos(2, 0), -1), false);
  assert.equal(policy.allows(wasm, pos(2, 1), pos(2, 1), -1), true);
});

import './helpers/live-native-loader.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { cellEvidenceDirectory } from './helpers/cell-evidence.ts';
const { WasmBridge } = await import('../src/core/wasm-bridge.ts');
const { CursorState } = await import('../src/engine/cursor.ts');
const { InputHandler } = await import('../src/engine/input-handler.ts');
const { CollaborationTextAdapter } = await import('../src/embed/collaboration-text-adapter.ts');
const { CollaborationLiveAdapter } = await import('../src/embed/collaboration-live-adapter.ts');
const { remapCollaborationTextPosition } = await import('../src/embed/collaboration-text-position.ts');
const bytes = await readFile(new URL('../../samples/biz_plan.hwp', import.meta.url));
const output = await cellEvidenceDirectory('caret');
test('length-changing remote cell edit moves the native caret and live composition anchor without ending composition', async () => {
  const wasm = new WasmBridge(); wasm.loadDocument(bytes);
  try {
    const length = wasm.getCellParagraphLength(0, 2, 0, 0, 0);
    wasm.deleteTextInCell(0, 2, 0, 0, 0, 0, length); wasm.insertTextInCell(0, 2, 0, 0, 0, 0, 'RICH한tail');
    const cursor = new CursorState(wasm);
    const anchor = { sectionIndex: 0, paragraphIndex: 2, parentParaIndex: 2, controlIndex: 0, cellIndex: 0, cellParaIndex: 0, charOffset: 4 };
    cursor.moveTo({ ...anchor, charOffset: 5 });
    const input = { cursor, isComposing: true, compositionAnchor: anchor, compositionLength: 1,
      _iosAnchor: null, pendingCharShapeAnchor: null,
      getBodyStructureInput: () => ({ position: cursor.getPosition(), selection: null }),
      updateSelection() {}, updateCaret() {} };
    const catalog = new CollaborationTextAdapter(wasm, { currentRevision: () => 0, afterApply: async () => {} });
    const observations: object[] = [];
    const live = new CollaborationLiveAdapter(wasm, { regions: () => catalog.getRegions(), revision: () => 0,
      refresh: async (...changes: unknown[]) => {
        observations.push({ stage: 'before-refresh', text: wasm.getTextInCell(0, 2, 0, 0, 0, 0, 10), caret: cursor.getPosition(), anchor: input.compositionAnchor });
        const rebase = Reflect.get(InputHandler.prototype, 'applyRemoteTextChange');
        if (typeof rebase === 'function') Reflect.apply(rebase, input, changes);
        observations.push({ stage: 'after-refresh', caret: cursor.getPosition(), anchor: input.compositionAnchor, isComposing: input.isComposing });
      } });
    const result = await live.apply({ regionId: 'c:0:2:0:0', expectedText: 'RICH한tail', origin: 'remote:caret', ops: [
      { type: 'delete', offset: 0, count: 4 }, { type: 'insert', offset: 0, text: 'CARET' },
    ] });
    await writeFile(new URL('length-change.json', output), JSON.stringify({ result, observations }, null, 2));
    assert.equal(result.ok, true); assert.equal(wasm.getTextInCell(0, 2, 0, 0, 0, 0, 10), 'CARET한tail');
    assert.equal(cursor.getPosition().charOffset, 6);
    assert.equal(input.compositionAnchor.charOffset, 5); assert.equal(input.compositionLength, 1); assert.equal(input.isComposing, true);
    wasm.deleteTextInCell(0, 2, 0, 0, 0, input.compositionAnchor.charOffset, input.compositionLength);
    wasm.insertTextInCell(0, 2, 0, 0, 0, input.compositionAnchor.charOffset, '한국');
    assert.equal(wasm.getTextInCell(0, 2, 0, 0, 0, 0, 11), 'CARET한국tail');
  } finally { wasm.releaseDocument(); }
});

test('remote position mapping respects scalar offsets and cell paragraph boundaries', () => {
  const cell = { sectionIndex: 0, paragraphIndex: 2, parentParaIndex: 2, controlIndex: 0, cellIndex: 0, cellParaIndex: 1,
    cellPath: [{ controlIndex: 0, cellIndex: 0, cellParaIndex: 1 }], charOffset: 1 };
  const moved = remapCollaborationTextPosition(cell, { nativeAddress: 'c:0:2:0:0', before: '😀A\n한B', ops: [{ type: 'insert', offset: 0, text: 'X\n' }] });
  assert.equal(moved.cellParaIndex, 2); assert.equal(moved.cellPath?.[0]?.cellParaIndex, 2); assert.equal(moved.charOffset, 1);
  const merged = remapCollaborationTextPosition(cell, { nativeAddress: 'c:0:2:0:0', before: '😀A\n한B', ops: [{ type: 'delete', offset: 3, count: 1 }] });
  assert.equal(merged.cellParaIndex, 0); assert.equal(merged.charOffset, 3);
  const body = { sectionIndex: 0, paragraphIndex: 14, charOffset: 2 };
  assert.equal(remapCollaborationTextPosition(body, { nativeAddress: 'b:0:14', before: 'ABCD', ops: [{ type: 'insert', offset: 0, text: '😀' }] }).charOffset, 3);
  assert.equal(remapCollaborationTextPosition(cell, { nativeAddress: 'c:0:2:0:1', before: 'other', ops: [{ type: 'insert', offset: 0, text: 'X' }] }), cell);
  assert.deepEqual(remapCollaborationTextPosition(cell, { nativeAddress: 'c:0:2:0:0', before: '😀A\n한B', ops: [{ type: 'format', version: 1, scope: 'character', offset: 0, count: 2, marks: { bold: true } }] }), cell);
});

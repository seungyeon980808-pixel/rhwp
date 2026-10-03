import './helpers/live-native-loader.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { cellEvidenceDirectory } from './helpers/cell-evidence.ts';
const { WasmBridge } = await import('../src/core/wasm-bridge.ts');
const { CollaborationTextAdapter } = await import('../src/embed/collaboration-text-adapter.ts');
const { CollaborationLiveAdapter } = await import('../src/embed/collaboration-live-adapter.ts');
const { encodeCollaborationParagraph, decodeCollaborationParagraph } = await import('../src/embed/collaboration-text-validation.ts');
const fixture = await readFile(new URL('../../samples/biz_plan.hwp', import.meta.url));
const output = await cellEvidenceDirectory('soft-line-break');
const id = 'c:0:2:0:0';
function setup(bytes = fixture) {
  const wasm = new WasmBridge(); wasm.loadDocument(bytes);
  const catalog = new CollaborationTextAdapter(wasm);
  const live = new CollaborationLiveAdapter(wasm, { regions: () => catalog.getRegions(), revision: () => 1, refresh: () => {} });
  return { wasm, catalog, live };
}
test('soft break codec rejects other controls without colliding with literal Unicode line separators', () => {
  assert.equal(encodeCollaborationParagraph('A\nB\u2028C'), 'A\vB\u2028C');
  assert.equal(decodeCollaborationParagraph('A\vB\u2028C'), 'A\nB\u2028C');
  for (const text of ['A\vB', 'A\tB', 'A\rB', 'A\ufffcB', 'A\u0000B']) assert.equal(encodeCollaborationParagraph(text), null);
});
test('soft cell line break and paragraph split remain distinct through replay and HWP/HWPX reopen', async () => {
  const a = setup(), b = setup();
  try {
    for (const { wasm } of [a, b]) {
      wasm.deleteTextInCell(0, 2, 0, 0, 0, 0, wasm.getCellParagraphLength(0, 2, 0, 0, 0));
      wasm.insertTextInCell(0, 2, 0, 0, 0, 0, 'A😀BC');
      wasm.applyParaFormatInCell(0, 2, 0, 0, 0, JSON.stringify({ alignment: 'center' }));
    }
    await a.live.begin(); await b.live.begin();
    // These are the same engine operations used by Shift+Enter and Enter.
    a.wasm.insertTextInCell(0, 2, 0, 0, 0, 2, '\n');
    a.wasm.splitParagraphInCell(0, 2, 0, 0, 0, 4);
    await a.live.captureLocal();
    const mutation = a.live.drain(0).find(entry => entry.regionId === id); assert.ok(mutation);
    assert.equal(mutation.text, 'A😀\vB\nC');
    const result = await b.live.apply({ regionId: id, expectedText: 'A😀BC', origin: 'remote:test', ops: [
      { type: 'insert', offset: 3, text: '\v' }, { type: 'insert', offset: 5, text: '\n' },
    ] });
    assert.equal(result.ok, true);
    const after = (await a.live.manifest()).regions.find(region => region.id === id); assert.ok(after);
    assert.deepEqual((await b.live.manifest()).regions.find(region => region.id === id), after);
    for (const format of ['hwp', 'hwpx'] as const) {
      const bytes = format === 'hwp' ? b.wasm.exportHwp() : b.wasm.exportHwpx();
      await writeFile(new URL(`soft-break.${format}`, output), bytes);
      const reopened = setup(bytes);
      try {
        assert.equal(reopened.wasm.getCellParagraphCount(0, 2, 0, 0), 2);
        assert.equal(reopened.wasm.getTextInCell(0, 2, 0, 0, 0, 0, 100), 'A😀\nB');
        assert.equal(reopened.wasm.getTextInCell(0, 2, 0, 0, 1, 0, 100), 'C');
        assert.equal((await reopened.catalog.getRegions()).find(region => region.id === id)?.text, 'A😀\vB\nC');
      } finally { reopened.wasm.releaseDocument(); }
    }
    const denied = await b.live.apply({ regionId: id, expectedText: 'A😀\vB\nC', origin: 'remote:bad', ops: [{ type: 'insert', offset: 0, text: '\t' }] });
    assert.deepEqual(denied, { schemaVersion: 1, ok: false, reason: 'unsupported-text' });
    assert.equal((await b.catalog.getRegions()).find(region => region.id === id)?.text, 'A😀\vB\nC');
    const deleted = await b.live.apply({ regionId: id, expectedText: 'A😀\vB\nC', origin: 'remote:delete-soft', ops: [{ type: 'delete', offset: 3, count: 1 }] });
    assert.equal(deleted.ok, true);
    assert.equal(b.wasm.getCellParagraphCount(0, 2, 0, 0), 2);
    assert.equal(b.wasm.getTextInCell(0, 2, 0, 0, 0, 0, 100), 'A😀B');
    assert.equal(b.wasm.getCellParaPropertiesAt(0, 2, 0, 0, 0).alignment, 'center');
    await writeFile(new URL('report.json', output), JSON.stringify({ mutation, after, result, denied, deleted, reopened: ['hwp', 'hwpx'], passed: true }, null, 2));
  } finally { a.wasm.releaseDocument(); b.wasm.releaseDocument(); }
});

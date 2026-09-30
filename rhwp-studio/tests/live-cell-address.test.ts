import './helpers/live-native-loader.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { cellEvidenceDirectory } from './helpers/cell-evidence.ts';
const { WasmBridge } = await import('../src/core/wasm-bridge.ts');
const { CollaborationTextAdapter } = await import('../src/embed/collaboration-text-adapter.ts');
const { CollaborationLiveAdapter } = await import('../src/embed/collaboration-live-adapter.ts');
const { planLivePaste, applyLivePaste } = await import('../src/embed/collaboration-range-paste.ts');
const output = await cellEvidenceDirectory('addresses');
function adapter(wasm: InstanceType<typeof WasmBridge>) {
  const catalog = new CollaborationTextAdapter(wasm, { currentRevision: () => 0, afterApply: async () => {} });
  return new CollaborationLiveAdapter(wasm, { regions: () => catalog.getRegions(), revision: () => 0, refresh: async () => {} });
}
test('actual preexisting four-column merged cell retains native identity and topology through replay and reopen', async () => {
  const bytes = await readFile(new URL('../../samples/task1765/merged_cell_trailing_ls.hwp', import.meta.url));
  const a = new WasmBridge(), b = new WasmBridge(); a.loadDocument(bytes); b.loadDocument(bytes);
  const owner = adapter(a), guest = adapter(b), id = 'c:0:0:2:0';
  try {
    await owner.begin(); await guest.begin();
    const original = await owner.manifest(); const before = original.regions.find(r => r.id === id); assert.ok(before);
    assert.equal(before.table?.cell.colSpan, 4);
    const start = { sectionIndex: 0, paragraphIndex: 0, parentParaIndex: 0, controlIndex: 2, cellIndex: 0, cellParaIndex: 0, charOffset: 1 };
    a.setLivePastePolicy({ epoch: 'merged', writableRegionIds: [id] });
    applyLivePaste(a, planLivePaste(a, { start, end: { ...start, cellParaIndex: 1 }, html: '', text: 'MERGED\nCELL' }));
    await owner.captureLocal(); const mutation = owner.drain(0).find(r => r.regionId === id); assert.ok(mutation);
    const first = before.text.split('\n')[0]; assert.ok(first);
    assert.equal((await guest.apply({ regionId: id, expectedText: before.text, origin: 'merged:remote', ops: [
      { type: 'delete', offset: 1, count: first.length + 1 }, { type: 'insert', offset: 1, text: 'MERGED\nCELL' }, ...(mutation.ops ?? []),
    ] })).ok, true);
    const after = await owner.manifest(); assert.deepEqual(await guest.manifest(), after);
    assert.deepEqual(after.regions.find(r => r.id === id)?.table, before.table);
    assert.deepEqual(after.resources, original.resources);
    for (const format of ['hwp', 'hwpx'] as const) {
      const exported = format === 'hwp' ? b.exportHwp() : b.exportHwpx(); await writeFile(new URL(`merged.${format}`, output), exported);
      const fresh = new WasmBridge(); fresh.loadDocument(exported);
      try {
        const reopened = await adapter(fresh).manifest();
        assert.equal(reopened.regions.find(r => r.id === id)?.text, mutation.text);
        assert.deepEqual(reopened.regions.find(r => r.id === id)?.table, before.table);
        assert.deepEqual(reopened.resources, original.resources);
      } finally { fresh.releaseDocument(); }
    }
    await writeFile(new URL('merged.json', output), JSON.stringify({ id, before, after: after.regions.find(r => r.id === id), resources: after.resources }, null, 2));
  } finally { a.releaseDocument(); b.releaseDocument(); }
});
test('actual nested-table fixture is explicitly unsupported without changing its native bytes or topology', async () => {
  const bytes = await readFile(new URL('../../samples/valign_fixtures/centered_cell_nested_table.hwpx', import.meta.url));
  const wasm = new WasmBridge(); wasm.loadDocument(bytes);
  try {
    const inspection = wasm.inspectApprovedTemplate();
    const outer = [{ controlIndex: 2, cellIndex: 0, cellParaIndex: 1 }];
    let found: { path: typeof outer; text: string } | undefined;
    for (let paragraph = 0; paragraph < wasm.getCellParagraphCount(0, 0, 2, 0); paragraph++) {
      for (let control = 0; control < 3; control++) {
        const path = [{ ...outer[0], cellParaIndex: paragraph }, { controlIndex: control, cellIndex: 0, cellParaIndex: 0 }];
        try {
          const length = wasm.getCellParagraphLengthByPath(0, 0, JSON.stringify(path));
          if (length > 0) { found = { path, text: wasm.getTextInCellByPath(0, 0, JSON.stringify(path), 0, length) }; break; }
        } catch (error) { if (!(error instanceof Error) && typeof error !== 'string') throw error; }
      }
      if (found) break;
    }
    assert.ok(found); assert.ok(found.text.length > 0);
    const start = { sectionIndex: 0, paragraphIndex: 0, parentParaIndex: 0, controlIndex: 2, cellIndex: 0, cellParaIndex: 0, cellPath: found.path, charOffset: 0 };
    wasm.setLivePastePolicy({ epoch: 'nested', writableRegionIds: ['c:0:0:2:0'] });
    const before = wasm.exportHwp();
    assert.throws(() => planLivePaste(wasm, { start, end: { ...start, charOffset: 1 }, html: '', text: 'REPLACE' }), /중첩 셀/);
    assert.deepEqual(wasm.exportHwp(), before);
    for (const format of ['hwp', 'hwpx'] as const) {
      const exported = format === 'hwp' ? wasm.exportHwp() : wasm.exportHwpx(); await writeFile(new URL(`nested-preserved.${format}`, output), exported);
      const fresh = new WasmBridge(); fresh.loadDocument(exported);
      try { assert.equal(fresh.getTextInCellByPath(0, 0, JSON.stringify(found.path), 0, [...found.text].length), found.text); }
      finally { fresh.releaseDocument(); }
    }
    await writeFile(new URL('nested.json', output), JSON.stringify({ classification: 'unsupported nested-table object; not editable live region', found, inspection, unchanged: true }, null, 2));
  } finally { wasm.releaseDocument(); }
});

import './helpers/live-native-loader.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
const { WasmBridge } = await import('../src/core/wasm-bridge.ts');
const { CollaborationTextAdapter } = await import('../src/embed/collaboration-text-adapter.ts');
const bytes = await readFile(new URL('../../samples/biz_plan.hwp', import.meta.url));

test('typing into a paragraph that was empty at import keeps the imported catalog stable', () => {
  // Given: a catalog frozen from the imported document, which excludes empty paragraphs.
  const wasm = new WasmBridge(); wasm.loadDocument(bytes); wasm.restrictLiveTableStructure();
  try {
    const catalog = new CollaborationTextAdapter(wasm, { currentRevision: () => 0, afterApply: async () => {} });
    const imported = catalog.getRegionsSync();
    const mapping = imported.map((region) => ({ id: randomUUID(), importAddress: region.id }));
    assert.equal(imported.some((region) => region.id === 'b:0:1'), false);
    assert.equal(wasm.getParagraphLength(0, 1), 0);

    // When: a participant types into that empty paragraph before the catalog is remapped.
    wasm.insertText(0, 1, 0, 'typed');

    // Then: remapping to the server catalog does not reject the untracked paragraph.
    assert.doesNotThrow(() => catalog.remapStructure(mapping));
    assert.deepEqual(catalog.getRegionsSync().map((region) => region.importAddress ?? region.id), imported.map((region) => region.id));
  } finally { wasm.releaseDocument(); }
});

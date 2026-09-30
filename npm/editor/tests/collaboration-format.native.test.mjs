import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import init, { HwpDocument } from '../../../pkg/rhwp.js';
import { CollaborationTextAdapter } from '../../../rhwp-studio/src/embed/collaboration-text-adapter.ts';
import { CollaborationLiveAdapter } from '../../../rhwp-studio/src/embed/collaboration-live-adapter.ts';

await init({ module_or_path: await readFile(new URL('../../../pkg/rhwp_bg.wasm', import.meta.url)) });
const fixture = await readFile(new URL('../../../samples/biz_plan.hwp', import.meta.url));
const parsed = new Set(['inspectApprovedTemplate', 'getCharPropertiesAt', 'getParaPropertiesAt',
  'getCellCharPropertiesAt', 'getCellParaPropertiesAt', 'getTableDimensions', 'getCellInfo']);
const regionId = 'c:0:2:0:0';
const address = [0, 2, 0, 0];
function harness() {
  const doc = new HwpDocument(fixture);
  const wasm = new Proxy(doc, { get(target, key) {
    const value = Reflect.get(target, key);
    if (typeof value !== 'function') return value;
    return (...args) => { const result = value.apply(target, args); return parsed.has(key) ? JSON.parse(result) : result; };
  } });
  const catalog = new CollaborationTextAdapter(wasm, { currentRevision: () => 0, afterApply: async () => {} });
  const live = new CollaborationLiveAdapter(wasm, { regions: () => catalog.getRegions(), revision: () => 0,
    refresh: async () => { await live.captureLocal(); } });
  return { doc, live };
}
for (const format of ['hwp', 'hwpx']) test(`native formatting is scoped, captured without text replacement, and retained in ${format}`, async () => {
  const a = harness(), b = harness(); let reopened;
  try {
    await a.live.begin(); await b.live.begin();
    const before = (await a.live.manifest()).regions.find((region) => region.id === regionId); assert.ok(before);
    const original = before.runs[0].properties;
    a.doc.applyCharFormatInCell(...address, 0, 0, 3, JSON.stringify({ bold: !original.bold, textColor: '#123456' }));
    a.doc.applyParaFormatInCell(...address, 0, JSON.stringify({ alignment: 'right' }));
    await a.live.captureLocal();
    const mutation = a.live.drain(0).find((entry) => entry.regionId === regionId); assert.ok(mutation?.ops?.length);
    assert.equal(mutation.text, before.text);
    const result = await b.live.apply({ regionId, expectedText: before.text, origin: 'remote:format', ops: mutation.ops });
    assert.equal(result.ok, true);
    await b.live.captureLocal();
    assert.deepEqual(b.live.drain(0).map((entry) => entry.origin), ['remote:format']);
    const actual = JSON.parse(b.doc.getCellCharPropertiesAt(...address, 0, 0));
    assert.equal(actual.bold, !original.bold); assert.equal(actual.italic, original.italic); assert.equal(actual.fontSize, original.fontSize);
    assert.equal(actual.textColor, '#123456');
    assert.deepEqual(JSON.parse(b.doc.getCellCharPropertiesAt(...address, 0, 4)), original);
    reopened = new HwpDocument(format === 'hwp' ? b.doc.exportHwp() : b.doc.exportHwpx());
    const restored = JSON.parse(reopened.getCellCharPropertiesAt(...address, 0, 0));
    assert.equal(restored.bold, !original.bold); assert.equal(restored.textColor, '#123456');
    assert.equal(JSON.parse(reopened.getCellParaPropertiesAt(...address, 0)).alignment, 'right');
    assert.equal(reopened.getTextInCell(...address, 0, 0, reopened.getCellParagraphLength(...address, 0)), before.text);
  } finally { a.doc.free(); b.doc.free(); reopened?.free(); }
});

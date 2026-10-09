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

for (const format of ['hwp', 'hwpx']) test(`extended character formats reach the other replica and survive ${format} reopening`, async () => {
  const a = harness(), b = harness(); let reopened;
  try {
    await a.live.begin(); await b.live.begin();
    const before = (await a.live.manifest()).regions.find(region => region.id === regionId); assert.ok(before);
    const marks = { underline: true, fontSize: 1300, ratios: Array(7).fill(99), spacings: Array(7).fill(-1) };
    a.doc.applyCharFormatInCell(...address, 0, 0, 3, JSON.stringify(marks));
    await a.live.captureLocal();
    const mutation = a.live.drain(0).find(entry => entry.regionId === regionId); assert.ok(mutation?.ops?.length);
    assert.equal((await b.live.apply({ regionId, expectedText: before.text, origin: 'remote:extended', ops: mutation.ops })).ok, true);
    reopened = new HwpDocument(format === 'hwp' ? b.doc.exportHwp() : b.doc.exportHwpx());
    for (const doc of [b.doc, reopened]) {
      const actual = JSON.parse(doc.getCellCharPropertiesAt(...address, 0, 0));
      for (const [key, value] of Object.entries(marks)) assert.deepEqual(actual[key], value, `${format}: ${key}`);
      assert.deepEqual(JSON.parse(doc.getCellCharPropertiesAt(...address, 0, 4)), before.runs.find(run => run.start <= 4 && run.end > 4).properties);
    }
  } finally { a.doc.free(); b.doc.free(); reopened?.free(); }
});

for (const format of ['hwp', 'hwpx']) test(`shortcut attributes and paragraph spacing/indent replay and survive ${format}`, async () => {
  const a = harness(), b = harness(); let reopened;
  try {
    await a.live.begin(); await b.live.begin();
    const before = (await a.live.manifest()).regions.find(region => region.id === regionId);
    const marks = { superscript: true, subscript: false, strikethrough: true, emboss: true, engrave: false, outlineType: 1, shadowType: 1, underlineType: 'Top', shadeColor: '#ffff00' };
    a.doc.applyCharFormatInCell(...address, 0, 0, 3, JSON.stringify(marks));
    a.doc.applyParaFormatInCell(...address, 0, JSON.stringify({ lineSpacing: 180, lineSpacingType: 'Percent', indent: 2000 }));
    await a.live.captureLocal();
    const mutation = a.live.drain(0).find(entry => entry.regionId === regionId); assert.ok(mutation?.ops?.length);
    assert.ok(mutation.ops.some(op => op.scope === 'paragraph' && op.marks.indent === 1995), JSON.stringify({ ops: mutation.ops, native: JSON.parse(a.doc.getCellParaPropertiesAt(...address, 0)) }));
    assert.equal((await b.live.apply({ regionId, expectedText: before.text, origin: 'remote:shortcut', ops: mutation.ops })).ok, true);
    reopened = new HwpDocument(format === 'hwp' ? b.doc.exportHwp() : b.doc.exportHwpx());
    for (const doc of [b.doc, reopened]) {
      const actual = JSON.parse(doc.getCellCharPropertiesAt(...address, 0, 0));
      for (const [key, value] of Object.entries(marks)) assert.deepEqual(actual[key], value, `${format}: ${key}`);
      const para = JSON.parse(doc.getCellParaPropertiesAt(...address, 0));
      assert.equal(para.lineSpacing, 180); assert.equal(para.lineSpacingType, 'Percent');
      assert.ok(Math.abs(para.indent - 13.3) < 0.01, `native indent ${para.indent}`);
    }
  } finally { a.doc.free(); b.doc.free(); reopened?.free(); }
});

test('normal reset replays explicit false/zero attributes and keeps font size and color', async () => {
  const a = harness(), b = harness();
  try {
    const styled = { bold: true, italic: true, underline: true, superscript: true, strikethrough: true, emboss: true, outlineType: 1, shadowType: 1, fontSize: 1400, textColor: '#123456' };
    for (const h of [a, b]) h.doc.applyCharFormatInCell(...address, 0, 0, 3, JSON.stringify(styled));
    await a.live.begin(); await b.live.begin();
    const before = (await a.live.manifest()).regions.find(region => region.id === regionId);
    const normal = { bold: false, italic: false, underline: false, underlineType: 'None', superscript: false, subscript: false, strikethrough: false, emboss: false, engrave: false, outlineType: 0, shadowType: 0 };
    a.doc.applyCharFormatInCell(...address, 0, 0, 3, JSON.stringify(normal));
    await a.live.captureLocal();
    const mutation = a.live.drain(0).find(entry => entry.regionId === regionId); assert.ok(mutation?.ops?.length);
    assert.equal((await b.live.apply({ regionId, expectedText: before.text, origin: 'remote:normal', ops: mutation.ops })).ok, true);
    const actual = JSON.parse(b.doc.getCellCharPropertiesAt(...address, 0, 0));
    for (const [key, value] of Object.entries(normal)) assert.equal(actual[key], value, key);
    assert.equal(actual.fontSize, 1400); assert.equal(actual.textColor, '#123456');
  } finally { a.doc.free(); b.doc.free(); }
});

test('body paragraph formatting keeps collaboration catalog stable while real topology changes invalidate it', async () => {
  const doc = HwpDocument.createEmpty();
  try {
    doc.createBlankDocument(); doc.insertText(0, 0, 0, '본문 서식 저장');
    doc.splitParagraph(0, 0, 8); doc.createTable(0, 1, 0, 2, 2);
    doc.insertTextInCell(0, 1, 0, 0, 0, 0, '셀 내용');
    const wasm = new Proxy(doc, { get(target, key) {
      const value = Reflect.get(target, key);
      if (typeof value !== 'function') return value;
      return (...args) => { const result = value.apply(target, args); return parsed.has(key) ? JSON.parse(result) : result; };
    } });
    const catalog = new CollaborationTextAdapter(wasm, { currentRevision: () => 0, afterApply: async () => {} });
    const initial = await catalog.getRegions();
    const digest = JSON.parse(doc.inspectApprovedTemplate());
    assert.ok(initial.some(region => region.id === 'b:0:0'));
    for (const marks of [{ indent: 2000 }, { lineSpacing: 170, lineSpacingType: 'Percent' }, { alignment: 'right' }]) {
      doc.applyParaFormat(0, 0, JSON.stringify(marks));
      const inspection = JSON.parse(doc.inspectApprovedTemplate());
      assert.equal(inspection.collaborationTextStructureDigest, digest.collaborationTextStructureDigest);
      assert.notEqual(inspection.structureDigest, digest.structureDigest, 'approved-template guard remains strict');
      assert.deepEqual((await catalog.getRegions()).map(region => region.id), initial.map(region => region.id));
    }
    doc.splitParagraph(0, 0, 2);
    assert.notEqual(JSON.parse(doc.inspectApprovedTemplate()).collaborationTextStructureDigest, digest.collaborationTextStructureDigest);
    assert.deepEqual(await catalog.getRegions(), [], 'actual paragraph topology change still rejects stale addresses');
  } finally { doc.free(); }
});

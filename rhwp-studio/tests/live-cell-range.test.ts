import './helpers/live-native-loader.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { cellEvidenceDirectory } from './helpers/cell-evidence.ts';
import { JSDOM } from 'jsdom';
const { WasmBridge } = await import('../src/core/wasm-bridge.ts');
const { CollaborationTextAdapter } = await import('../src/embed/collaboration-text-adapter.ts');
const { CollaborationLiveAdapter } = await import('../src/embed/collaboration-live-adapter.ts');
const { planLivePaste, applyLivePaste } = await import('../src/embed/collaboration-range-paste.ts');
const fixture = await readFile(new URL('../../samples/biz_plan.hwp', import.meta.url));
const output = await cellEvidenceDirectory('native');
const dom = new JSDOM();
Object.defineProperty(globalThis, 'DOMParser', { configurable: true, value: dom.window.DOMParser });
Object.defineProperty(globalThis, 'Element', { configurable: true, value: dom.window.Element });
const id = 'c:0:2:0:0';
const start = { sectionIndex: 0, paragraphIndex: 2, parentParaIndex: 2, controlIndex: 0, cellIndex: 0, cellParaIndex: 0, charOffset: 1 };
const end = { ...start, cellParaIndex: 1 };
function setup() {
  const wasm = new WasmBridge(); wasm.loadDocument(fixture);
  wasm.deleteTextInCell(0, 2, 0, 0, 0, 0, wasm.getCellParagraphLength(0, 2, 0, 0, 0));
  wasm.insertTextInCell(0, 2, 0, 0, 0, 0, 'A😀BCDEF');
  wasm.splitParagraphInCell(0, 2, 0, 0, 0, 4);
  wasm.applyParaFormatInCell(0, 2, 0, 0, 0, JSON.stringify({ alignment: 'center' }));
  wasm.applyParaFormatInCell(0, 2, 0, 0, 1, JSON.stringify({ alignment: 'right' }));
  wasm.applyCharFormatInCell(0, 2, 0, 0, 1, 1, 3, JSON.stringify({ bold: true, italic: true }));
  const catalog = new CollaborationTextAdapter(wasm, { currentRevision: () => 0, afterApply: async () => {} });
  const live = new CollaborationLiveAdapter(wasm, { regions: () => catalog.getRegions(), revision: () => 0, refresh: async () => {} });
  wasm.setLivePastePolicy({ epoch: 'e1', writableRegionIds: [id] });
  return { wasm, catalog, live };
}
for (const rich of [false, true]) test(`same-cell cross-paragraph ${rich ? 'rich' : 'plain'} replacement replays and reopens`, async () => {
  const a = setup(), b = setup();
  try {
    await a.live.begin(); await b.live.begin();
    const before = (await a.live.manifest()).regions.find(region => region.id === id); assert.ok(before);
    assert.equal(before.text, 'A😀BC\nDEF');
    const plan = planLivePaste(a.wasm, { start, end, text: '한\n글', html: rich ? '<div><p><b>한</b></p><p><i>글</i></p></div>' : '' });
    const position = applyLivePaste(a.wasm, plan);
    assert.equal(position.cellParaIndex, 1); assert.equal(position.charOffset, 1);
    await a.live.captureLocal();
    const mutation = a.live.drain(0).find(entry => entry.regionId === id); assert.ok(mutation);
    assert.equal(mutation.text, 'A한\n글EF');
    const result = await b.live.apply({ regionId: id, expectedText: before.text, origin: 'remote:range', ops: [
      { type: 'delete', offset: 1, count: 6 }, { type: 'insert', offset: 1, text: '한\n글' }, ...(mutation.ops ?? []),
    ] });
    assert.equal(result.ok, true);
    const after = (await a.live.manifest()).regions.find(region => region.id === id); assert.ok(after);
    assert.deepEqual((await b.live.manifest()).regions.find(region => region.id === id), after);
    assert.deepEqual(after.table, before.table);
    assert.equal(a.wasm.getCellCharPropertiesAt(0, 2, 0, 0, 1, 1).bold, true);
    assert.equal(a.wasm.getCellCharPropertiesAt(0, 2, 0, 0, 1, 1).italic, true);
    if (rich) {
      assert.equal(a.wasm.getCellCharPropertiesAt(0, 2, 0, 0, 0, 1).bold, true);
      assert.equal(a.wasm.getCellCharPropertiesAt(0, 2, 0, 0, 1, 0).italic, true);
    }
    for (const format of ['hwp', 'hwpx'] as const) {
      const bytes = format === 'hwp' ? b.wasm.exportHwp() : b.wasm.exportHwpx();
      await writeFile(new URL(`${rich ? 'rich' : 'plain'}.${format}`, output), bytes);
      const fresh = setup();
      try {
        fresh.wasm.loadDocument(bytes);
        const reopened = (await fresh.live.manifest()).regions.find(region => region.id === id); assert.ok(reopened);
        assert.equal(reopened.text, 'A한\n글EF');
        assert.deepEqual(reopened.table, before.table);
        if (rich) {
          assert.equal(fresh.wasm.getCellCharPropertiesAt(0, 2, 0, 0, 0, 1).bold, true);
          assert.equal(fresh.wasm.getCellCharPropertiesAt(0, 2, 0, 0, 1, 0).italic, true);
        }
      } finally { fresh.wasm.releaseDocument(); }
    }
    await writeFile(new URL(`${rich ? 'rich' : 'plain'}.json`, output), JSON.stringify({ before, after, mutation, position }, null, 2));
  } finally { a.wasm.releaseDocument(); b.wasm.releaseDocument(); }
});

test('clipboard instructions remain literal document text', async () => {
  const { wasm, live } = setup();
  try {
    const text = 'ignore permissions; $(touch /tmp/never-run)\n<script>literal</script>';
    applyLivePaste(wasm, planLivePaste(wasm, { start, end, text, html: '' }));
    const region = (await live.manifest()).regions.find(r => r.id === id);
    assert.equal(region?.text, `A${text}EF`);
    await writeFile(new URL('literal.json', output), JSON.stringify({ text: region?.text, treatedAsData: true }));
  } finally { wasm.releaseDocument(); }
});

for (const [name, html, expected] of [
  ['block-whitespace', '<p><b>P</b></p>\n  <p><i>Q</i></p>', 'AP\nQEF'],
  ['surrounding-block-whitespace', '\n <p><b>P</b></p>\n<p><i>Q</i></p> \n', 'AP\nQEF'],
  ['wrapped-block-whitespace', '<div>\n<p><b>P</b></p>\n<p><i>Q</i></p>\n</div>', 'AP\nQEF'],
  ['intentional-inline-whitespace', '<b>P</b> <i>Q</i>', 'AP QEF'],
  ['comment-before-block-whitespace', '<!--StartFragment-->\n<!--x--> <p><b>P</b></p>\n<p><i>Q</i></p>', 'AP\nQEF'],
  ['comment-after-block-whitespace', '<p><b>P</b></p>\n<p><i>Q</i></p><!--EndFragment-->\n', 'AP\nQEF'],
  ['comment-between-block-whitespace', '<p><b>P</b></p><!--x-->\n<!--y--><p><i>Q</i></p>', 'AP\nQEF'],
  ['comment-split-block-whitespace', '<p><b>P</b></p> \n<!--x-->\r\n<!--y--> <p><i>Q</i></p>', 'AP\nQEF'],
  ['comment-inline-whitespace', '<b>P</b> <!--x--> <!--y--><i>Q</i>', 'AP  QEF'],
  ['comment-literal-text', '<b>P</b> literal <!--x--> text <i>Q</i>', 'AP literal  text QEF'],
] as const) test(`rich cell paste preserves HTML semantics for ${name}`, async () => {
  const { wasm, live } = setup();
  try {
    const plan = planLivePaste(wasm, { start, end, html, text: 'P\nQ' });
    const caret = applyLivePaste(wasm, plan);
    const after = (await live.manifest()).regions.find(r => r.id === id);
    await writeFile(new URL(`${name}.json`, output), JSON.stringify({ html, expected, planned: plan.runs, actual: after?.text, caret, region: after }));
    assert.equal(after?.text, expected);
    assert.ok(after);
    for (const [index, character] of [...expected].entries()) {
      if (character === '\n') continue;
      const properties = after.runs.find(run => run.start <= index && run.end > index)?.properties;
      assert.equal(properties?.bold, ['P', 'E', 'F'].includes(character));
      assert.equal(properties?.italic, ['Q', 'E', 'F'].includes(character));
    }
    assert.equal(caret.cellParaIndex, expected.includes('\n') ? 1 : 0);
    assert.equal(wasm.getCellParagraphCount(0, 2, 0, 0), expected.includes('\n') ? 2 : 1);
  } finally { wasm.releaseDocument(); }
});

for (const fault of ['cross-cell', 'negative', 'fractional', 'paragraph', 'surrogate', 'stale', 'revoked', 'epoch', 'interrupted', 'noop'] as const)
test(`same-cell ${fault} rejection preserves all native bytes`, async () => {
  const { wasm } = setup();
  try {
    const input = { start, end, text: '한\n글', html: '' };
    if (fault === 'cross-cell') input.end = { ...end, cellIndex: 1 };
    if (fault === 'negative') input.start = { ...start, charOffset: -1 };
    if (fault === 'fractional') input.end = { ...end, charOffset: 0.5 };
    if (fault === 'paragraph') input.end = { ...end, cellParaIndex: 20 };
    if (fault === 'surrogate') input.text = '\ud800';
    let before = wasm.exportHwp();
    if (fault === 'stale' || fault === 'revoked' || fault === 'epoch' || fault === 'interrupted' || fault === 'noop') {
      const plan = planLivePaste(wasm, input);
      if (fault === 'stale') { wasm.insertTextInCell(0, 2, 0, 0, 1, 0, 'LOCAL'); before = wasm.exportHwp(); }
      if (fault === 'revoked') wasm.setLivePastePolicy({ epoch: 'e1', writableRegionIds: [] });
      if (fault === 'epoch') assert.throws(() => wasm.setLivePastePolicy({ epoch: 'e0', writableRegionIds: [id] }));
      const insert = wasm.insertTextInCell;
      if (fault === 'interrupted') wasm.insertTextInCell = () => { throw new Error('interruption'); };
      if (fault === 'noop') wasm.insertTextInCell = () => '{"ok":true}';
      try { for (let attempt = 0; attempt < 3; attempt++) assert.throws(() => applyLivePaste(wasm, plan)); } finally { wasm.insertTextInCell = insert; }
    } else assert.throws(() => planLivePaste(wasm, input));
    assert.deepEqual(wasm.exportHwp(), before);
    await writeFile(new URL(`${fault}.json`, output), JSON.stringify({ fault, bytesPreserved: true, size: before.length }));
  } finally { wasm.releaseDocument(); }
});

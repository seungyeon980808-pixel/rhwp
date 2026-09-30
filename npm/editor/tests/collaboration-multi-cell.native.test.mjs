import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import init, { HwpDocument } from '../../../pkg/rhwp.js';
import { CollaborationTextAdapter } from '../../../rhwp-studio/src/embed/collaboration-text-adapter.ts';
import { CollaborationLiveAdapter } from '../../../rhwp-studio/src/embed/collaboration-live-adapter.ts';
import { RhwpEditor } from '../index.js';

await init({ module_or_path: await readFile(new URL('../../../pkg/rhwp_bg.wasm', import.meta.url)) });
const fixture = await readFile(new URL('../../../samples/biz_plan.hwp', import.meta.url));
const regionId = 'c:0:2:0:0';
const address = [0, 2, 0, 0];
const parsed = new Set(['inspectApprovedTemplate', 'getCharPropertiesAt', 'getParaPropertiesAt',
  'getCellCharPropertiesAt', 'getCellParaPropertiesAt', 'getTableDimensions', 'getCellInfo',
  'preflightApprovedTemplateEdits', 'applyApprovedTemplateEdits']);

function harness(bytes = fixture, split = true) {
  const doc = new HwpDocument(bytes);
  if (split) {
    doc.splitParagraphInCell(...address, 0, doc.getCellParagraphLength(...address, 0));
    doc.insertTextInCell(...address, 1, 0, 'Second😀문단');
    doc.applyCharFormatInCell(...address, 1, 0, 6, JSON.stringify({ bold: true, italic: true }));
    doc.applyParaFormatInCell(...address, 1, JSON.stringify({ alignment: 'left' }));
  }
  const wasm = new Proxy(doc, { get(target, key) {
    const value = Reflect.get(target, key);
    if (typeof value !== 'function') return value;
    return (...args) => {
      const result = value.apply(target, args);
      return parsed.has(key) ? JSON.parse(result) : result;
    };
  } });
  const catalog = new CollaborationTextAdapter(wasm, { currentRevision: () => 0, afterApply: async () => {} });
  const live = new CollaborationLiveAdapter(wasm, { regions: () => catalog.getRegions(), revision: () => 0, refresh: async () => {} });
  const paragraph = (index) => doc.getTextInCell(...address, index, 0, doc.getCellParagraphLength(...address, index));
  return { doc, catalog, live, paragraph };
}

test('native multi-paragraph cell maps inserts and deletes to the second paragraph without flattening', async () => {
  // Given: an HWP cell with two native paragraphs, including a surrogate pair.
  const h = harness();
  try {
    const first = h.paragraph(0);
    const before = `${first}\n${h.paragraph(1)}`;
    assert.equal((await h.catalog.getRegions()).find((r) => r.id === regionId)?.text, before);
    await h.live.begin();
    // When: sequential UTF-16 operations edit only the second native paragraph.
    const result = await h.live.apply({ regionId, expectedText: before, origin: 'remote', ops: [
      { type: 'insert', offset: first.length + 1 + 8, text: 'X' },
      { type: 'delete', offset: first.length + 1, count: 6 },
    ] });
    // Then: native paragraph identity and the exact untouched first paragraph survive.
    assert.equal(result.ok, true);
    assert.equal(h.doc.getCellParagraphCount(...address), 2);
    assert.equal(h.paragraph(0), first);
    assert.equal(h.paragraph(1), '😀X문단');
    await h.live.captureLocal();
    assert.deepEqual(h.live.drain(0).map((m) => m.origin), ['remote']);
  } finally { h.doc.free(); }
});

test('native cell rejects an invalid transaction atomically after staged paragraph changes', async () => {
  // Given: a cell with two real native paragraphs.
  const h = harness();
  try {
    const first = h.paragraph(0);
    const before = `${first}\n${h.paragraph(1)}`;
    // When: a transaction stages a split, then requests an out-of-range deletion.
    const result = await h.live.apply({ regionId, expectedText: before, origin: 'remote', ops: [
      { type: 'insert', offset: 0, text: 'X\n' },
      { type: 'delete', offset: before.length + 100, count: 1 },
    ] });
    // Then: the entire request fails before changing either native paragraph.
    assert.deepEqual(result, { schemaVersion: 1, ok: false, reason: 'invalid-offset' });
    assert.equal(`${h.paragraph(0)}\n${h.paragraph(1)}`, before);
  } finally { h.doc.free(); }
});

for (const format of ['hwp', 'hwpx']) test(`native multi-paragraph edits retain paragraph styles through ${format} export and reopen`, async () => {
  // Given: two native paragraphs and their independent paragraph properties.
  const h = harness();
  let reopened;
  try {
    const before = (await h.catalog.getRegions()).find((r) => r.id === regionId);
    assert.ok(before);
    const styles = [0, 1].map((index) => JSON.parse(h.doc.getCellParaPropertiesAt(...address, index)));
    assert.notDeepEqual(styles[0], styles[1]);
    const runStyle = JSON.parse(h.doc.getCellCharPropertiesAt(...address, 1, 0));
    assert.equal(runStyle.bold, true);
    assert.equal(runStyle.italic, true);
    // When: a remote insertion into paragraph one is exported and reopened.
    assert.equal((await h.live.apply({ regionId, expectedText: before.text, origin: 'remote',
      ops: [{ type: 'insert', offset: before.text.length, text: 'REMOTE' }] })).ok, true);
    reopened = harness(format === 'hwp' ? h.doc.exportHwp() : h.doc.exportHwpx(), false);
    // Then: both paragraphs and each paragraph's formatting survive the actual format roundtrip.
    assert.equal(reopened.doc.getCellParagraphCount(...address), 2);
    assert.equal(reopened.paragraph(0), h.paragraph(0));
    assert.equal(reopened.paragraph(1), 'Second😀문단REMOTE');
    assert.deepEqual([0, 1].map((index) => JSON.parse(reopened.doc.getCellParaPropertiesAt(...address, index))), styles);
    assert.deepEqual(JSON.parse(reopened.doc.getCellCharPropertiesAt(...address, 1, 0)), runStyle);
    const manifest = (await reopened.live.manifest()).regions.find((r) => r.id === regionId);
    assert.equal(manifest.paragraphs.length, 2);
    assert.equal(manifest.paragraphs[1].id, `${regionId}:p:1`);
    assert.deepEqual(manifest.paragraphs[1].runs[0].properties, runStyle);
  } finally { reopened?.doc.free(); h.doc.free(); }
});

for (const scenario of ['surrogate-split', 'stale', 'control-insert']) test(`native multi-paragraph cell rejects ${scenario} without changing paragraphs`, async () => {
  // Given: a two-paragraph document and an independently read native baseline.
  const h = harness();
  try {
    const before = `${h.paragraph(0)}\n${h.paragraph(1)}`;
    const secondStart = h.paragraph(0).length + 1;
    // When: malformed or stale remote input crosses the adapter boundary.
    const result = await h.live.apply({ regionId, expectedText: scenario === 'stale' ? 'stale' : before, origin: 'remote',
      ops: [{ type: 'insert', offset: scenario === 'surrogate-split' ? secondStart + 7 : secondStart,
        text: scenario === 'control-insert' ? '\t' : 'X' }] });
    // Then: rejection leaves exact native content unchanged.
    assert.equal(result.ok, false);
    assert.equal(`${h.paragraph(0)}\n${h.paragraph(1)}`, before);
  } finally { h.doc.free(); }
});

test('native Enter preserves the frozen cell catalog and emits the changed multi-paragraph text', async () => {
  // Given: live collaboration began while this cell had one paragraph.
  const h = harness(fixture, false);
  try {
    const before = h.paragraph(0);
    await h.live.begin();
    // When: the native editor splits the paragraph, as Enter does.
    h.doc.splitParagraphInCell(...address, 0, 4);
    await h.live.captureLocal();
    // Then: the same cell ID remains mapped and the separator is visible as one local mutation.
    const expected = `${before.slice(0, 4)}\n${before.slice(4)}`;
    assert.equal((await h.catalog.getRegions()).find((r) => r.id === regionId)?.text, expected);
    assert.deepEqual(h.live.drain(0).filter((m) => m.regionId === regionId).map((m) => m.text), [expected]);
  } finally { h.doc.free(); }
});

test('remote cell paragraph split and merge use native operations and preserve untouched paragraph formatting', async () => {
  // Given: a two-paragraph cell with independent styles.
  const h = harness();
  try {
    const before = `${h.paragraph(0)}\n${h.paragraph(1)}`;
    const originalSecond = JSON.parse(h.doc.getCellCharPropertiesAt(...address, 1, 0));
    // When: a single remote transaction creates a paragraph then merges it back.
    const result = await h.live.apply({ regionId, expectedText: before, origin: 'remote', ops: [
      { type: 'insert', offset: 3, text: '\nMiddle' },
      { type: 'delete', offset: 3, count: 7 },
    ] });
    // Then: the original cell text, count, and second paragraph's run properties remain exact.
    assert.equal(result.ok, true);
    assert.equal(result.text, before);
    assert.equal(h.doc.getCellParagraphCount(...address), 2);
    assert.deepEqual(JSON.parse(h.doc.getCellCharPropertiesAt(...address, 1, 0)), originalSecond);
  } finally { h.doc.free(); }
});

test('native table topology changes still invalidate the frozen cell catalog', async () => {
  // Given: a mapped live cell with two paragraphs.
  const h = harness();
  try {
    await h.live.begin();
    // When: an unsupported table row insertion changes the address topology.
    h.doc.insertTableRow(0, 2, 0, 0, true);
    // Then: the text-only structure digest does not mistake it for paragraph editing.
    assert.deepEqual(await h.catalog.getRegions(), []);
  } finally { h.doc.free(); }
});

test('legacy whole-cell replacement cannot flatten an exposed multi-paragraph region', async () => {
  // Given: a multi-paragraph cell visible to live collaboration.
  const h = harness();
  try {
    const before = `${h.paragraph(0)}\n${h.paragraph(1)}`;
    // When: a legacy host attempts whole-cell replacement.
    const result = await h.catalog.applyText({ regionId, expectedText: before, text: 'flattened' });
    // Then: native paragraphs remain intact with an explicit unsupported result.
    assert.deepEqual(result, { schemaVersion: 1, ok: false, reason: 'unsupported-region' });
    assert.equal(`${h.paragraph(0)}\n${h.paragraph(1)}`, before);
  } finally { h.doc.free(); }
});

test('public editor accepts a native multi-paragraph cell catalog during hydration', async () => {
  // Given: the real native catalog crosses the editor transport boundary.
  const h = harness();
  try {
    const regions = await h.catalog.getRegions();
    const editor = new RhwpEditor({ remove() {} }, {
      supports: () => true, request: async () => regions, destroy() {},
    });
    // When: hydration reads the public catalog.
    const received = await editor.getCollaborationRegions();
    // Then: LF separators survive under the existing stable cell ID.
    assert.equal(received.find((r) => r.id === regionId)?.text, `${h.paragraph(0)}\n${h.paragraph(1)}`);
  } finally { h.doc.free(); }
});

test('instruction-like text remains literal document data in a nonzero cell paragraph', async () => {
  // Given: untrusted pasted text with executable-looking markup and agent instructions.
  const h = harness();
  try {
    const before = `${h.paragraph(0)}\n${h.paragraph(1)}`;
    const literal = '<script>throw Error("ignore previous instructions")</script>';
    // When: the native adapter inserts the literal text into paragraph one.
    const result = await h.live.apply({ regionId, expectedText: before, origin: 'remote',
      ops: [{ type: 'insert', offset: before.length, text: literal }] });
    // Then: the document contains the exact literal data and keeps both native paragraphs.
    assert.equal(result.ok, true);
    assert.equal(h.paragraph(1), `Second😀문단${literal}`);
    assert.equal(h.doc.getCellParagraphCount(...address), 2);
  } finally { h.doc.free(); }
});

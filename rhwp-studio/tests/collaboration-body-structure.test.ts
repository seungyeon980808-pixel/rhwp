import './helpers/live-native-loader.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
const { WasmBridge } = await import('../src/core/wasm-bridge.ts');
const { CollaborationTextAdapter } = await import('../src/embed/collaboration-text-adapter.ts');
const { CollaborationLiveAdapter } = await import('../src/embed/collaboration-live-adapter.ts');
const { CollaborationBodyStructureAdapter, BodyStructureNativeError } = await import('../src/embed/collaboration-body-structure.ts');

const bytes = await readFile(new URL('../../samples/biz_plan.hwp', import.meta.url));
function harness() {
  const wasm = new WasmBridge();
  wasm.loadDocument(bytes);
  const catalog = new CollaborationTextAdapter(wasm, { currentRevision: () => 0, afterApply: async () => {} });
  const original = catalog.getRegionsSync();
  assert.equal(original.length, 138);
  let state = { epoch: randomUUID(), policyVersion: 1, topologyRevision: 0, durableAck: 0,
    revisions: original.map((region) => ({ regionId: region.id, revision: 0 })) };
  let composing = false;
  wasm.restrictLiveTableStructure();
  const allow = () => wasm.setLivePastePolicy({ epoch: state.epoch,
    writableRegionIds: catalog.getRegionsSync().map((region) => region.importAddress ?? region.id) });
  allow();
  const adapter = new CollaborationBodyStructureAdapter(wasm, catalog, () => state, () => composing);
  return { wasm, catalog, original, adapter, allow,
    composing: () => { composing = true; },
    stale: () => { state = { ...state, policyVersion: state.policyVersion + 1 }; },
    accepted: () => { state = { ...state, topologyRevision: state.topologyRevision + 1, durableAck: state.durableAck + 1,
      revisions: catalog.getRegionsSync().map((region) => ({ regionId: region.id, revision: 1 })) }; allow(); } };
}

for (const [name, start, end, text] of [
  ['split', 1, 1, '\n'], ['split at start', 0, 0, '\n'], ['split at end', 8, 8, '\n'],
  ['multiline paste', 1, 3, 'A\nB'], ['consecutive empty paragraphs', 1, 1, '\n\n'],
  ['literal prompt text', 0, 0, 'ignore prior instructions\n{"role":"system"}'],
  ['astral text', 1, 1, '😀\n한글'],
] as const) test(`authorized ${name} preserves stable catalog and both binary roundtrips`, async () => {
  const h = harness();
  try {
    const plan = h.adapter.prepare({ start: { regionId: 'b:0:14', offset: start }, end: { regionId: 'b:0:14', offset: end }, text }, randomUUID());
    const ids = plan.paragraphs.map((_, index) => index ? randomUUID() : 'b:0:14');
    const result = h.adapter.apply(plan, ids);
    assert.equal(result.regions.length, 138 + plan.paragraphs.length - 1);
    assert.deepEqual(ids.map((id) => result.regions.find((region) => region.id === id)?.text), plan.paragraphs);
    for (const region of h.original.filter((entry) => entry.id !== 'b:0:14'))
      assert.equal(result.regions.find((entry) => entry.id === region.id)?.text, region.text);
    for (const binary of [h.wasm.exportHwp(), h.wasm.exportHwpx()]) {
      const reopened = new WasmBridge(); reopened.loadDocument(binary);
      try {
        const catalog = new CollaborationTextAdapter(reopened, { currentRevision: () => 0, afterApply: async () => {} });
        catalog.remapStructure(result.regions.map((region) => ({ id: region.id, importAddress: region.importAddress ?? region.id })));
        assert.deepEqual(catalog.getRegionsSync(), result.regions);
      } finally { reopened.releaseDocument(); }
    }
  } finally { h.wasm.releaseDocument(); }
});

test('Backspace merge after split tombstones child and later LOCAL text is captured under stable shifted IDs', async () => {
  const h = harness();
  try {
    const child = randomUUID();
    const split = h.adapter.prepare({ start: { regionId: 'b:0:14', offset: 1 }, end: { regionId: 'b:0:14', offset: 1 }, text: '\n' }, randomUUID());
    h.adapter.apply(split, ['b:0:14', child]); h.accepted();
    const merged = h.adapter.apply(h.adapter.prepare({ start: { regionId: 'b:0:14', offset: 1 }, end: { regionId: child, offset: 0 }, text: '' }, randomUUID()), ['b:0:14']);
    assert.deepEqual(merged.removedRegionIds, [child]);
    assert.deepEqual(merged.regions, h.original);
    const live = new CollaborationLiveAdapter(h.wasm, { regions: () => h.catalog.getRegions(), revision: () => 0, refresh: async () => {} });
    await live.begin(); h.wasm.insertText(0, 14, 0, 'LOCAL'); await live.captureLocal();
    assert.equal(live.drain(0).find((entry) => entry.regionId === 'b:0:14')?.text, 'LOCAL20XX. 1.');
  } finally { h.wasm.releaseDocument(); }
});

test('cross-paragraph range delete preserves outside text and stable cell addresses', () => {
  const h = harness();
  try {
    const plan = h.adapter.prepare({ start: { regionId: 'b:0:30', offset: 2 }, end: { regionId: 'b:0:32', offset: 3 }, text: '' }, randomUUID());
    const result = h.adapter.apply(plan, ['b:0:30']);
    assert.equal(result.regions.length, 136);
    assert.deepEqual(result.removedRegionIds, ['b:0:31', 'b:0:32']);
    assert.equal(result.regions.find((region) => region.id === 'b:0:30')?.text, plan.paragraphs[0]);
    assert.equal(result.regions.find((region) => region.id === 'c:0:83:0:0')?.importAddress, 'c:0:81:0:0');
  } finally { h.wasm.releaseDocument(); }
});

for (const reason of ['denied', 'stale', 'cancel', 'composition', 'fault', 'invalid receipt'] as const)
test(`${reason} rejects atomically and preserves an existing pending edit`, () => {
  const h = harness();
  try {
    h.wasm.insertText(0, 30, 0, 'PENDING');
    const before = h.wasm.exportHwp();
    const regions = h.catalog.getRegionsSync();
    const plan = h.adapter.prepare({ start: { regionId: 'b:0:30', offset: 1 }, end: { regionId: 'b:0:32', offset: 1 }, text: 'A\nB' }, randomUUID());
    if (reason === 'denied') h.wasm.setLivePastePolicy({ epoch: plan.operation.epoch, writableRegionIds: ['b:0:30', 'b:0:32'] });
    if (reason === 'stale') h.stale();
    if (reason === 'cancel') h.adapter.cancel(plan);
    if (reason === 'composition') h.composing();
    if (reason === 'fault') h.catalog.remapStructure = () => { throw new BodyStructureNativeError('NATIVE_FAILURE'); };
    assert.throws(() => h.adapter.apply(plan, reason === 'invalid receipt' ? ['b:0:30', 'b:0:31'] : ['b:0:30', randomUUID()]), BodyStructureNativeError);
    assert.deepEqual(h.wasm.exportHwp(), before);
    assert.deepEqual(h.catalog.getRegionsSync(), regions);
  } finally { h.wasm.releaseDocument(); }
});

for (const [start, end, text] of [[-1, 0, '\n'], [1.5, 2, '\n'], [9, 9, '\n'], [3, 1, '\n'], [0, 0, '\ud800'], [0, 0, 'A\r\nB']] as const)
test(`malformed range ${start}/${end}/${JSON.stringify(text)} rejects before native mutation`, () => {
  const h = harness();
  try {
    const before = h.wasm.exportHwp();
    assert.throws(() => h.adapter.prepare({ start: { regionId: 'b:0:14', offset: start }, end: { regionId: 'b:0:14', offset: end }, text }, randomUUID()), BodyStructureNativeError);
    assert.deepEqual(h.wasm.exportHwp(), before);
  } finally { h.wasm.releaseDocument(); }
});

test('unsupported control-bearing gap and offsets inside a surrogate pair reject', () => {
  const h = harness();
  try {
    h.wasm.insertText(0, 14, 0, '😀');
    const before = h.wasm.exportHwp();
    for (const end of [{ regionId: 'b:0:24', offset: 1 }, { regionId: 'b:0:14', offset: 1 }])
      assert.throws(() => h.adapter.prepare({ start: { regionId: 'b:0:14', offset: 0 }, end, text: '' }, randomUUID()), BodyStructureNativeError);
    assert.deepEqual(h.wasm.exportHwp(), before);
  } finally { h.wasm.releaseDocument(); }
});

test('incremental remote and subsequent LOCAL mutations target stable shifted body and cell IDs', async () => {
  const h = harness();
  try {
    const plan = h.adapter.prepare({ start: { regionId: 'b:0:14', offset: 1 }, end: { regionId: 'b:0:14', offset: 1 }, text: '\n' }, randomUUID());
    h.adapter.apply(plan, ['b:0:14', randomUUID()]);
    const live = new CollaborationLiveAdapter(h.wasm, { regions: () => h.catalog.getRegions(), revision: () => 1, refresh: async () => {} });
    await live.begin();
    for (const id of ['b:0:24', 'c:0:83:0:0']) {
      const before = h.catalog.getRegionsSync().find((region) => region.id === id);
      assert.ok(before);
      const result = await live.apply({ regionId: id, expectedText: before.text, origin: 'remote', ops: [{ type: 'insert', offset: 0, text: 'REMOTE' }] });
      assert.equal(result.ok, true);
      assert.equal(h.catalog.getRegionsSync().find((region) => region.id === id)?.text, `REMOTE${before.text}`);
    }
    h.wasm.insertText(0, 25, 0, 'LOCAL'); await live.captureLocal();
    assert.ok(live.drain(0).some((entry) => entry.origin === 'local' && entry.regionId === 'b:0:24' && entry.text.startsWith('LOCALREMOTE')));
  } finally { h.wasm.releaseDocument(); }
});

test('ordinary structure works and the unconfigured live native guard remains fail closed', () => {
  const wasm = new WasmBridge(); wasm.loadDocument(bytes);
  try {
    const text = wasm.getTextRange(0, 14, 0, wasm.getParagraphLength(0, 14));
    assert.equal(JSON.parse(wasm.splitParagraph(0, 14, 1)).ok, true);
    assert.equal(JSON.parse(wasm.mergeParagraph(0, 15)).ok, true);
    assert.equal(wasm.getTextRange(0, 14, 0, wasm.getParagraphLength(0, 14)), text);
    wasm.restrictLiveTableStructure();
    const before = wasm.exportHwp();
    assert.throws(() => wasm.splitParagraph(0, 14, 1));
    assert.throws(() => wasm.mergeParagraph(0, 15));
    assert.throws(() => wasm.deleteRange(0, 30, 1, 32, 1));
    assert.deepEqual(wasm.exportHwp(), before);
  } finally { wasm.releaseDocument(); }
});

import './helpers/live-native-loader.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
const { WasmBridge } = await import('../src/core/wasm-bridge.ts');
const { CollaborationTextAdapter } = await import('../src/embed/collaboration-text-adapter.ts');
const { CollaborationBodyHost } = await import('../src/embed/collaboration-body-host.ts');
const bytes = await readFile(new URL('../../samples/biz_plan.hwp', import.meta.url));

function client() {
  const wasm = new WasmBridge(); wasm.loadDocument(bytes); wasm.restrictLiveTableStructure();
  const catalog = new CollaborationTextAdapter(wasm, { currentRevision: () => 0, afterApply: async () => {} });
  let composing = false; let revision = 0;
  return { wasm, catalog, host: new CollaborationBodyHost(wasm, catalog, () => composing, () => revision),
    compose: () => { composing = true; }, dirty: () => { revision += 1; } };
}
function setup(prefix = '') {
  const a = client(); const b = client();
  if (prefix) { a.wasm.insertText(0, 14, 0, prefix); b.wasm.insertText(0, 14, 0, prefix); }
  const regions = a.catalog.getRegionsSync().map(region => ({ id: randomUUID(), importAddress: region.id, text: region.text, revision: 0 }));
  const original = { epoch: randomUUID(), policyVersion: 1, topologyRevision: 0, durableAck: 0, regions, writableRegionIds: [] };
  a.host.configure({ ...original, writableRegionIds: regions.map(region => region.id) }); b.host.configure(original);
  const request = a.host.stage('enter', { sectionIndex: 0, paragraphIndex: 14, charOffset: 1 }, null); assert.ok(request);
  const receipt = { operation: request.operation, actorKey: 'owner', durableAck: 1, topologyRevision: 1,
    regionIds: [request.operation.start.regionId, randomUUID()], removedRegionIds: [] };
  return { a, b, original, receipt, close: () => { a.wasm.releaseDocument(); b.wasm.releaseDocument(); } };
}

test('canonical remote split converges without a recipient grant or a staged request', () => {
  const h = setup();
  try {
    const a = h.a.host.resolve({ planId: h.receipt.operation.operationId, receipt: h.receipt });
    const b = h.b.host.applyRemote({ before: h.original, receipt: h.receipt });
    assert.equal(b.status, 'applied'); assert.equal(h.b.catalog.getRegionsSync().length, 137);
    assert.deepEqual(h.b.catalog.getRegionsSync(), a?.regions);
    assert.deepEqual(h.b.wasm.exportHwp(), h.a.wasm.exportHwp());
    const after = h.b.wasm.exportHwp();
    assert.equal(h.b.host.applyRemote({ before: h.original, receipt: h.receipt }).status, 'duplicate');
    assert.deepEqual(h.b.wasm.exportHwp(), after);
  } finally { h.close(); }
});

test('remote split maps suffix carets and reversed selection endpoints in native scalar coordinates', () => {
  const h = setup('😀');
  try {
    const points = [
      { sectionIndex: 0, paragraphIndex: 14, charOffset: 5 },
      { sectionIndex: 0, paragraphIndex: 14, charOffset: 0 },
      { sectionIndex: 0, paragraphIndex: 14, charOffset: 1 },
      { sectionIndex: 0, paragraphIndex: 30, charOffset: 2 },
      { sectionIndex: 1, paragraphIndex: 14, charOffset: 5 },
      { sectionIndex: 0, paragraphIndex: 0, charOffset: 2, parentParaIndex: 30, controlIndex: 0, cellIndex: 0,
        cellPath: [{ controlIndex: 0, cellIndex: 0, cellParaIndex: 0 }] },
    ];
    h.b.host.applyRemote({ before: h.original, receipt: h.receipt });
    assert.deepEqual(points.map(point => h.b.host.remapAppliedPosition(point)), [
      { sectionIndex: 0, paragraphIndex: 15, charOffset: 4 },
      points[1], { sectionIndex: 0, paragraphIndex: 15, charOffset: 0 },
      { sectionIndex: 0, paragraphIndex: 31, charOffset: 2 }, points[4], { ...points[5], parentParaIndex: 31 },
    ]);
  } finally { h.close(); }
});

test('multiline replacement keeps the prefix, collapses deleted positions and retains the suffix', () => {
  const h = setup('😀');
  try {
    h.a.host.resolve({ planId: h.receipt.operation.operationId, receipt: null });
    const point = (charOffset: number) => ({ sectionIndex: 0, paragraphIndex: 14, charOffset });
    const request = h.a.host.stage('paste', point(4), { start: point(1), end: point(4) }, 'a\nb\nc'); assert.ok(request);
    const receipt = { operation: request.operation, actorKey: 'owner', durableAck: 1, topologyRevision: 1,
      regionIds: [request.operation.start.regionId, randomUUID(), randomUUID()], removedRegionIds: [] };
    h.b.host.applyRemote({ before: h.original, receipt });
    assert.deepEqual([0, 1, 2, 4, 5].map(offset => h.b.host.remapAppliedPosition(point(offset))), [
      point(0), { ...point(1), paragraphIndex: 16 }, { ...point(1), paragraphIndex: 16 },
      { ...point(1), paragraphIndex: 16 }, { ...point(2), paragraphIndex: 16 },
    ]);
  } finally { h.close(); }
});

test('remote join preserves suffix offsets from the removed stable paragraph', () => {
  const h = setup();
  try {
    const split = h.a.host.resolve({ planId: h.receipt.operation.operationId, receipt: h.receipt }); assert.ok(split);
    h.b.host.applyRemote({ before: h.original, receipt: h.receipt });
    const before = { ...h.original, topologyRevision: 1, durableAck: 1, regions: split.regions.map(region => ({
      id: region.id, importAddress: region.importAddress ?? region.id, text: region.text,
      revision: h.receipt.regionIds.includes(region.id) ? (h.original.regions.find(entry => entry.id === region.id)?.revision ?? -1) + 1 : 0,
    })) };
    h.a.host.configure({ ...before, writableRegionIds: before.regions.map(region => region.id) });
    const join = h.a.host.stage('backspace', { sectionIndex: 0, paragraphIndex: 15, charOffset: 0 }, null); assert.ok(join);
    const receipt = { operation: join.operation, actorKey: 'owner', durableAck: 2, topologyRevision: 2,
      regionIds: [join.operation.start.regionId], removedRegionIds: [join.operation.end.regionId] };
    const result = h.b.host.applyRemote({ before, receipt });
    assert.equal(result.status, 'applied');
    assert.deepEqual(h.b.host.remapAppliedPosition({ sectionIndex: 0, paragraphIndex: 15, charOffset: 4 }),
      { sectionIndex: 0, paragraphIndex: 14, charOffset: 5 });
    assert.deepEqual(h.b.host.remapAppliedPosition({ sectionIndex: 0, paragraphIndex: 31, charOffset: 2 }),
      { sectionIndex: 0, paragraphIndex: 30, charOffset: 2 });
    h.b.host.applyRemote({ before: h.original, receipt: h.receipt });
    assert.deepEqual(h.b.host.remapAppliedPosition({ sectionIndex: 0, paragraphIndex: 15, charOffset: 4 }),
      { sectionIndex: 0, paragraphIndex: 14, charOffset: 5 });
  } finally { h.close(); }
});

for (const scenario of ['composing', 'dirty revision', 'dirty text', 'stale catalog', 'stale epoch', 'wrong sequence', 'malformed ids', 'wrong revisions', 'pending'] as const)
test(`remote ${scenario} preserves the exact native bytes`, () => {
  const h = setup();
  try {
    let before = h.original; let receipt = h.receipt;
    switch (scenario) {
      case 'composing': h.b.compose(); break;
      case 'dirty revision': h.b.dirty(); break;
      case 'dirty text': h.b.wasm.insertText(0, 14, 0, 'LOCAL'); break;
      case 'stale catalog': before = { ...before, topologyRevision: 5 }; break;
      case 'stale epoch': receipt = { ...receipt, operation: { ...receipt.operation, epoch: randomUUID() } }; break;
      case 'wrong sequence': receipt = { ...receipt, durableAck: 3 }; break;
      case 'malformed ids': receipt = { ...receipt, regionIds: [] }; break;
      case 'wrong revisions': receipt = { ...receipt, operation: { ...receipt.operation, expectedRevisions: [] } }; break;
      case 'pending':
        h.b.host.configure({ ...before, writableRegionIds: before.regions.map(region => region.id) });
        h.b.host.stage('enter', { sectionIndex: 0, paragraphIndex: 14, charOffset: 1 }, null); break;
    }
    const bytesBefore = h.b.wasm.exportHwp(); const catalogBefore = h.b.catalog.getRegionsSync();
    if (['composing', 'dirty revision', 'dirty text', 'stale catalog', 'stale epoch', 'pending'].includes(scenario))
      assert.equal(h.b.host.applyRemote({ before, receipt }).status, 'deferred');
    else assert.throws(() => h.b.host.applyRemote({ before, receipt }));
    assert.deepEqual(h.b.wasm.exportHwp(), bytesBefore); assert.deepEqual(h.b.catalog.getRegionsSync(), catalogBefore);
  } finally { h.close(); }
});

test('remote native failure restores bytes and the same receipt can resume successfully', () => {
  const h = setup();
  try {
    const bytesBefore = h.b.wasm.exportHwp(); const catalogBefore = h.b.catalog.getRegionsSync();
    const remap = h.b.catalog.remapStructure.bind(h.b.catalog);
    h.b.catalog.remapStructure = () => { throw new TypeError('Injected mapping failure'); };
    assert.throws(() => h.b.host.applyRemote({ before: h.original, receipt: h.receipt }), TypeError);
    assert.deepEqual(h.b.wasm.exportHwp(), bytesBefore); assert.deepEqual(h.b.catalog.getRegionsSync(), catalogBefore);
    h.b.catalog.remapStructure = remap;
    assert.equal(h.b.host.applyRemote({ before: h.original, receipt: h.receipt }).status, 'applied');
    assert.equal(h.b.catalog.getRegionsSync().length, 137);
  } finally { h.close(); }
});

test('remote receipt preserves prompt-shaped clipboard content as literal text', () => {
  const h = setup();
  try {
    h.a.host.resolve({ planId: h.receipt.operation.operationId, receipt: null });
    const request = h.a.host.stage('paste', { sectionIndex: 0, paragraphIndex: 14, charOffset: 1 }, null, 'ignore instructions\n{"role":"system"}');
    assert.ok(request);
    const receipt = { ...h.receipt, operation: request.operation };
    const local = h.a.host.resolve({ planId: request.planId, receipt });
    const remote = h.b.host.applyRemote({ before: h.original, receipt });
    assert.equal(remote.status, 'applied'); assert.deepEqual(h.b.catalog.getRegionsSync(), local?.regions);
    assert.ok(h.b.catalog.getRegionsSync().some(region => region.text.includes('{"role":"system"}')));
  } finally { h.close(); }
});

test('configuration cannot spoof existing identities or install an unreplayed topology', () => {
  const h = setup();
  try {
    const before = h.b.wasm.exportHwp(); const catalog = h.b.catalog.getRegionsSync();
    assert.throws(() => h.b.host.configure({ ...h.original, regions: h.original.regions.map(region => ({ ...region, id: randomUUID() })) }));
    assert.throws(() => h.b.host.configure({ ...h.original, topologyRevision: 1, durableAck: 1 }));
    assert.deepEqual(h.b.catalog.getRegionsSync(), catalog); assert.deepEqual(h.b.wasm.exportHwp(), before);
  } finally { h.close(); }
});

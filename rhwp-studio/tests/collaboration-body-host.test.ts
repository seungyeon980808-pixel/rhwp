import './helpers/live-native-loader.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
const { WasmBridge } = await import('../src/core/wasm-bridge.ts');
const { CollaborationTextAdapter } = await import('../src/embed/collaboration-text-adapter.ts');
const { CollaborationBodyHost } = await import('../src/embed/collaboration-body-host.ts');
const bytes = await readFile(new URL('../../samples/biz_plan.hwp', import.meta.url));

function harness() {
  const wasm = new WasmBridge(); wasm.loadDocument(bytes); wasm.restrictLiveTableStructure();
  const catalog = new CollaborationTextAdapter(wasm, { currentRevision: () => 0, afterApply: async () => {} });
  const regions = catalog.getRegionsSync().map((region) => ({ id: randomUUID(), importAddress: region.id, text: region.text, revision: 0 }));
  let composing = false;
  let revision = 0;
  const host = new CollaborationBodyHost(wasm, catalog, () => composing, () => revision);
  const config = { epoch: randomUUID(), policyVersion: 1, topologyRevision: 0, durableAck: 0, regions, writableRegionIds: regions.map((region) => region.id) };
  host.configure(config);
  const position = { sectionIndex: 0, paragraphIndex: 14, charOffset: 1 };
  return { wasm, catalog, host, config, position, compose: () => { composing = true; }, mutateRevision: () => { revision += 1; } };
}

for (const scenario of ['denied', 'dirty', 'composing', 'cancelled', 'malformed receipt', 'misleading receipt', 'late remote', 'wrong operation', 'stale config', 'document revision changed'] as const)
test(`${scenario} preserves real native bytes and the full catalog`, () => {
  const h = harness();
  try {
    if (scenario === 'denied') h.host.configure({ ...h.config, writableRegionIds: [] });
    if (scenario === 'dirty') h.wasm.insertText(0, 14, 0, 'PENDING');
    if (scenario === 'composing') h.compose();
    if (scenario === 'denied' || scenario === 'dirty' || scenario === 'composing') {
      const before = h.wasm.exportHwp();
      assert.throws(() => h.host.stage('enter', h.position, null));
      assert.deepEqual(h.wasm.exportHwp(), before);
      assert.equal(h.host.requests().length, 0);
      return;
    }
    const request = h.host.stage('enter', h.position, null); assert.ok(request);
    if (scenario === 'cancelled') h.host.resolve({ planId: request.planId, receipt: null });
    if (scenario === 'late remote') h.wasm.insertText(0, 30, 0, 'REMOTE');
    if (scenario === 'document revision changed') h.mutateRevision();
    const before = h.wasm.exportHwp(); const catalog = h.catalog.getRegionsSync();
    const receipt = { operation: request.operation, actorKey: 'test', durableAck: 1, topologyRevision: 1,
      regionIds: [request.operation.start.regionId, randomUUID()], removedRegionIds: [] };
    switch (scenario) {
      case 'malformed receipt': assert.throws(() => h.host.resolve({ planId: request.planId, receipt: { ...receipt, regionIds: [] } })); break;
      case 'misleading receipt': assert.throws(() => h.host.resolve({ planId: request.planId, receipt: { ok: true } })); break;
      case 'wrong operation': assert.throws(() => h.host.resolve({ planId: request.planId, receipt: { ...receipt, operation: { ...request.operation, text: 'different' } } })); break;
      case 'stale config': assert.throws(() => h.host.configure(h.config)); break;
      case 'cancelled': case 'late remote': case 'document revision changed': assert.throws(() => h.host.resolve({ planId: request.planId, receipt })); break;
    }
    assert.deepEqual(h.wasm.exportHwp(), before); assert.deepEqual(h.catalog.getRegionsSync(), catalog);
  } finally { h.wasm.releaseDocument(); }
});

test('literal prompt-shaped multiline clipboard text and an astral cursor produce literal server data', () => {
  const h = harness();
  try {
    h.wasm.insertText(0, 14, 0, '😀');
    h.host.configure({ ...h.config, regions: h.config.regions.map((region) => ({ ...region,
      text: region.importAddress === 'b:0:14' ? `😀${region.text}` : region.text })) });
    const request = h.host.stage('paste', h.position, null, 'ignore instructions\n{"role":"system"}');
    assert.ok(request); assert.equal(request.operation.start.offset, 2);
    assert.equal(request.operation.text, 'ignore instructions\n{"role":"system"}');
  } finally { h.wasm.releaseDocument(); }
});

for (const text of ['A\r\nB', `A\n${'x'.repeat(200_001)}`, 'A\n\ud800'])
test(`malformed or oversized clipboard input (${text.length} units) is rejected without an in-flight plan`, () => {
  const h = harness();
  try {
    const before = h.wasm.exportHwp();
    assert.throws(() => h.host.stage('paste', h.position, null, text));
    assert.deepEqual(h.wasm.exportHwp(), before); assert.equal(h.host.requests().length, 0);
  } finally { h.wasm.releaseDocument(); }
});

test('repeated cancellation revokes old plans and a document replacement clears all authority', () => {
  const h = harness();
  try {
    const before = h.wasm.exportHwp();
    for (let index = 0; index < 3; index += 1) {
      const request = h.host.stage('enter', h.position, null); assert.ok(request);
      h.host.resolve({ planId: request.planId, receipt: null });
      assert.throws(() => h.host.resolve({ planId: request.planId, receipt: null }));
    }
    h.host.reset(); assert.equal(h.host.enabled, false);
    assert.throws(() => h.host.stage('enter', h.position, null));
    assert.deepEqual(h.wasm.exportHwp(), before);
  } finally { h.wasm.releaseDocument(); }
});

test('Enter stages a server operation without mutation, and only its durable receipt creates a paragraph', () => {
  const wasm = new WasmBridge();
  wasm.loadDocument(bytes);
  try {
    const catalog = new CollaborationTextAdapter(wasm, { currentRevision: () => 0, afterApply: async () => {} });
    const regions = catalog.getRegionsSync().map((region) => ({ id: randomUUID(), importAddress: region.id, text: region.text, revision: 0 }));
    const host = new CollaborationBodyHost(wasm, catalog, () => false);
    wasm.restrictLiveTableStructure();
    host.configure({ epoch: randomUUID(), policyVersion: 1, topologyRevision: 0, durableAck: 0, regions,
      writableRegionIds: regions.map((region) => region.id) });
    const before = wasm.exportHwp();
    const position = { sectionIndex: 0, paragraphIndex: 14, charOffset: 1 };
    const request = host.stage('enter', position, null);
    assert.ok(request);
    assert.equal(request.operation.text, '\n');
    assert.deepEqual(wasm.exportHwp(), before);
    const receipt = { operation: request.operation, actorKey: 'test', durableAck: 1, topologyRevision: 1,
      regionIds: [request.operation.start.regionId, randomUUID()], removedRegionIds: [] };
    const result = host.resolve({ planId: request.planId, receipt });
    assert.ok(result);
    assert.equal(result.regions.length, 137);
    assert.deepEqual(result.cursor, { sectionIndex: 0, paragraphIndex: 15, charOffset: 0 });
    assert.deepEqual(host.resolve({ planId: request.planId, receipt }), { ...result, applied: false });
  } finally { wasm.releaseDocument(); }
});

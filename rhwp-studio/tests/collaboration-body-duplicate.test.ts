import './helpers/live-native-loader.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
const { WasmBridge } = await import('../src/core/wasm-bridge.ts');
const { CollaborationTextAdapter } = await import('../src/embed/collaboration-text-adapter.ts');
const { CollaborationBodyHost } = await import('../src/embed/collaboration-body-host.ts');

test('duplicate A leaves pending B and the current document revision untouched', async () => {
  const wasm = new WasmBridge();
  wasm.loadDocument(await readFile(new URL('../../samples/biz_plan.hwp', import.meta.url)));
  try {
    let revision = 0;
    const catalog = new CollaborationTextAdapter(wasm, { currentRevision: () => revision, afterApply: async () => {} });
    const host = new CollaborationBodyHost(wasm, catalog, () => false, () => revision);
    const regions = catalog.getRegionsSync().map(region => ({ id: randomUUID(), importAddress: region.id, text: region.text, revision: 0 }));
    const original = { epoch: randomUUID(), policyVersion: 1, topologyRevision: 0, durableAck: 0, regions, writableRegionIds: regions.map(region => region.id) };
    wasm.restrictLiveTableStructure(); host.configure(original);
    const request = host.stage('enter', { sectionIndex: 0, paragraphIndex: 14, charOffset: 1 }, null); assert.ok(request);
    const receipt = { operation: request.operation, actorKey: 'test', durableAck: 1, topologyRevision: 1,
      regionIds: [request.operation.start.regionId, randomUUID()], removedRegionIds: [] };
    const result = host.resolve({ planId: request.planId, receipt }); assert.ok(result);
    revision += 1;
    host.configure({ ...original, durableAck: 1, topologyRevision: 1,
      regions: result.regions.map(region => ({ ...region, importAddress: region.importAddress ?? region.id, revision: 1 })),
      writableRegionIds: result.regions.map(region => region.id) });
    const next = host.stage('backspace', result.cursor, null); assert.ok(next);
    const duplicate = host.resolve({ planId: request.planId, receipt });
    assert.equal(duplicate?.applied, false);
    if (duplicate?.applied) revision += 1;
    assert.equal(host.requests()[0]?.planId, next.planId);
    const merged = host.resolve({ planId: next.planId, receipt: { operation: next.operation, actorKey: 'test',
      durableAck: 2, topologyRevision: 2, regionIds: [request.operation.start.regionId], removedRegionIds: [receipt.regionIds[1]] } });
    assert.equal(merged?.regions.length, 136);
    assert.deepEqual(merged?.tombstones, [receipt.regionIds[1]]);
  } finally { wasm.releaseDocument(); }
});

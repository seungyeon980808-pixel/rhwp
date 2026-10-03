import './helpers/live-native-loader.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { cellEvidenceDirectory } from './helpers/cell-evidence.ts';
const { WasmBridge } = await import('../src/core/wasm-bridge.ts');
const { CollaborationTextAdapter } = await import('../src/embed/collaboration-text-adapter.ts');
const { CollaborationBodyHost } = await import('../src/embed/collaboration-body-host.ts');
const bytes = await readFile(new URL('../../samples/biz_plan.hwp', import.meta.url));
const output = await cellEvidenceDirectory('initial-subset');
function setup(data = bytes) {
  const wasm = new WasmBridge(); wasm.loadDocument(data);
  const catalog = new CollaborationTextAdapter(wasm);
  const host = new CollaborationBodyHost(wasm, catalog, () => false);
  return { wasm, catalog, host };
}
function oldConfiguration(catalog: InstanceType<typeof CollaborationTextAdapter>) {
  const native = catalog.getRegionsSync();
  const omitted = native.filter(region => region.text.includes('\v'));
  assert.equal(native.length, 138); assert.equal(omitted.length, 2);
  const regions = native.filter(region => !region.text.includes('\v')).map(region => ({ id: randomUUID(), importAddress: region.id, text: region.text, revision: 0 }));
  return { omitted, config: { epoch: randomUUID(), policyVersion: 1, topologyRevision: 0, durableAck: 0,
    regions, writableRegionIds: regions.map(region => region.id) } };
}
test('older authoritative subset stays locked through initial hydration and binary reopen', async () => {
  const h = setup();
  try {
    const { config, omitted } = oldConfiguration(h.catalog);
    h.host.configure(config);
    assert.equal(h.catalog.getRegionsSync().length, 136);
    for (const region of omitted) {
      assert.equal(h.catalog.resolveAddress(region.id), null);
      assert.equal(h.wasm.canPasteLiveRegion(region.id, config.epoch), false);
    }
    for (const region of config.regions) assert.equal(h.wasm.canPasteLiveRegion(region.importAddress, config.epoch), true);
    assert.throws(() => h.host.configure({ ...config, regions: config.regions.slice(1), writableRegionIds: config.writableRegionIds.slice(1) }));
    assert.throws(() => h.host.configure({ ...config, regions: [...config.regions,
      ...omitted.map(region => ({ id: randomUUID(), importAddress: region.id, text: region.text, revision: 0 }))] }));
    assert.equal(h.catalog.getRegionsSync().length, 136);
    for (const format of ['hwp', 'hwpx'] as const) {
      const binary = format === 'hwp' ? h.wasm.exportHwp() : h.wasm.exportHwpx();
      await writeFile(new URL(`subset.${format}`, output), binary);
      const fresh = setup(binary);
      try {
        fresh.host.configure(config);
        assert.equal(fresh.catalog.getRegionsSync().length, 136);
        for (const region of omitted) assert.equal(fresh.wasm.canPasteLiveRegion(region.id, config.epoch), false);
      } finally { fresh.wasm.releaseDocument(); }
    }
    await writeFile(new URL('report.json', output), JSON.stringify({ nativeCount: 138, authoritativeCount: 136,
      omitted: omitted.map(region => region.id), writableCount: 136, unmappedWritable: false,
      subsequentSubsetRejected: true, subsequentExpansionRejected: true, reopened: ['hwp', 'hwpx'], passed: true }, null, 2));
  } finally { h.wasm.releaseDocument(); }
});
for (const invalid of ['wrong text', 'duplicate address', 'duplicate id', 'unknown address', 'unmapped grant'] as const)
  test(`initial subset rejects ${invalid} before installing authority`, () => {
    const h = setup();
    try {
      const { config } = oldConfiguration(h.catalog);
      const malformed = structuredClone(config);
      if (invalid === 'wrong text') malformed.regions[0].text += 'WRONG';
      if (invalid === 'duplicate address') malformed.regions[1].importAddress = malformed.regions[0].importAddress;
      if (invalid === 'duplicate id') malformed.regions[1].id = malformed.regions[0].id;
      if (invalid === 'unknown address') malformed.regions[0].importAddress = 'c:999:0:0:0';
      if (invalid === 'unmapped grant') malformed.writableRegionIds.push(randomUUID());
      assert.throws(() => h.host.configure(malformed));
      assert.equal(h.host.enabled, false); assert.equal(h.catalog.getRegionsSync().length, 138);
    } finally { h.wasm.releaseDocument(); }
  });

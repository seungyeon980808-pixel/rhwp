import test from 'node:test';
import assert from 'node:assert/strict';
import { inspectRawResources, tableTopologySignature } from '../src/embed/collaboration-resource-manifest.ts';

test('raw resource inventory fails closed on old engines and malformed hashes', () => {
  assert.deepEqual(inspectRawResources({}), { resources: [], missing: ['raw-resource-inventory'] });
  assert.throws(() => inspectRawResources({ getBinaryResourceManifest: () => '{"resources":[{"id":"bin:1","sha256":"fake"}],"missing":[]}' }), /invalid-resource-inventory/);
  const manifest = { resources: [{ id: 'bin:7', sha256: 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad' }], missing: ['resource-bytes:bin:8'] };
  assert.deepEqual(inspectRawResources({ getBinaryResourceManifest: () => JSON.stringify(manifest) }), manifest);
});




test('table signature changes when a merged cell is split', () => {
  const merged = { getTableDimensions: () => ({ rowCount: 1, colCount: 2, cellCount: 1 }), getCellInfo: () => ({ row: 0, col: 0, rowSpan: 1, colSpan: 2 }) };
  const split = { getTableDimensions: () => ({ rowCount: 1, colCount: 2, cellCount: 2 }), getCellInfo: (_section: number, _paragraph: number, _control: number, cell: number) => ({ row: 0, col: cell, rowSpan: 1, colSpan: 1 }) };
  const address = { section: 0, paragraph: 2, control: 0 };
  assert.notEqual(tableTopologySignature(merged, address), tableTopologySignature(split, address));
  assert.deepEqual(JSON.parse(tableTopologySignature(merged, address)), { rowCount: 1, colCount: 2, cells: [{ row: 0, col: 0, rowSpan: 1, colSpan: 2 }] });
});

test('rejects a table whose cells overlap', () => {
  const source = { getTableDimensions: () => ({ rowCount: 1, colCount: 2, cellCount: 2 }), getCellInfo: () => ({ row: 0, col: 0, rowSpan: 1, colSpan: 2 }) };
  assert.throws(() => tableTopologySignature(source, { section: 0, paragraph: 2, control: 0 }), /invalid-table-topology/);
});

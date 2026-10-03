import './helpers/live-native-loader.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
const { WasmBridge } = await import('../src/core/wasm-bridge.ts');
const { CollaborationTextAdapter } = await import('../src/embed/collaboration-text-adapter.ts');
const { CollaborationLiveAdapter } = await import('../src/embed/collaboration-live-adapter.ts');
test('idle polling skips the native document scan but captures text and format-only revisions', async () => {
  const wasm = new WasmBridge(); wasm.loadDocument(await readFile(new URL('../../samples/table-001.hwp', import.meta.url)));
  let revision = 0, reads = 0;
  const catalog = new CollaborationTextAdapter(wasm, { currentRevision: () => revision, afterApply: async () => {} });
  const live = new CollaborationLiveAdapter(wasm, { regions: async () => { reads++; return catalog.getRegions(); }, revision: () => revision, refresh: async () => {} });
  try {
    await live.begin(); const baseline = reads;
    for (let i = 0; i < 100; i++) await live.capturePending();
    assert.equal(reads, baseline); assert.deepEqual(live.drain(0), []);
    const cell = (await catalog.getRegions()).find(region => region.kind === 'cell' && region.text.length > 1); assert.ok(cell);
    const address = cell.id.split(':').slice(1).map(Number);
    wasm.insertTextInCell(address[0]!, address[1]!, address[2]!, address[3]!, 0, 0, 'X'); revision++;
    await Promise.all([live.capturePending(), live.capturePending(), live.capturePending()]);
    assert.equal(reads, baseline + 1);
    assert.equal(live.drain(0).filter(m => m.regionId === cell.id).length, 1);
    const previousSequence = live.drain(0).at(-1)!.sequence;
    const bold = wasm.getCellCharPropertiesAt(address[0]!, address[1]!, address[2]!, address[3]!, 0, 0).bold;
    wasm.applyCharFormatInCell(address[0]!, address[1]!, address[2]!, address[3]!, 0, 0, 1, JSON.stringify({ bold: !bold })); revision++;
    await live.capturePending();
    assert.ok(live.drain(previousSequence).some(m => m.ops?.some(op => op.type === 'format')));
    const after = reads; await live.capturePending(); assert.equal(reads, after);
  } finally { wasm.releaseDocument(); }
});

test('known native typing scans only touched cells and retains format correctness; unknown revisions rescan', async () => {
  const wasm = new WasmBridge();
  wasm.loadDocument(await readFile(new URL('../../samples/biz_plan.hwp', import.meta.url)));
  let revision = 0, catalogReads = 0;
  const propertyReads: string[] = [];
  const originalProperties = wasm.getCellCharPropertiesAt.bind(wasm);
  wasm.getCellCharPropertiesAt = (...args) => {
    propertyReads.push(`c:${args.slice(0, 4).join(':')}`);
    return originalProperties(...args);
  };
  const catalog = new CollaborationTextAdapter(wasm, { currentRevision: () => revision, afterApply: async () => {} });
  const live = new CollaborationLiveAdapter(wasm, {
    regions: async () => { catalogReads++; return catalog.getRegions(); },
    revision: () => revision, refresh: async () => {},
  });
  try {
    await live.begin();
    const baseline = catalogReads;
    const cells = (await catalog.getRegions()).filter(region => region.kind === 'cell' && region.text.length > 2).slice(0, 2);
    assert.equal(cells.length, 2);
    propertyReads.length = 0;
    for (const cell of cells) {
      const [s, p, c, i] = cell.id.split(':').slice(1).map(Number) as [number, number, number, number];
      wasm.insertTextInCell(s, p, c, i, 0, 0, '한😀');
      live.noteMutation(++revision, [cell.id]);
    }
    await live.capturePending();
    assert.equal(catalogReads, baseline, 'typing must not inspect the whole document');
    assert.deepEqual([...new Set(propertyReads)].sort(), cells.map(cell => cell.id).sort());
    assert.equal(live.drain(0).length, 2);
    for (const cell of cells) assert.ok(live.drain(0).find(m => m.regionId === cell.id)?.text.startsWith('한😀'));
    const cell = cells[0]!;
    const [s, p, c, i] = cell.id.split(':').slice(1).map(Number) as [number, number, number, number];
    const sequence = live.drain(0).at(-1)!.sequence;
    const bold = wasm.getCellCharPropertiesAt(s, p, c, i, 0, 0).bold;
    wasm.applyCharFormatInCell(s, p, c, i, 0, 0, 1, JSON.stringify({ bold: !bold }));
    live.noteMutation(++revision); // formatting has no trusted text-only region hint
    await live.capturePending();
    assert.equal(catalogReads, baseline + 1);
    assert.ok(live.drain(sequence).some(m => m.ops?.some(op => op.type === 'format')));
    // A revision from an uninstrumented mutation must never be silently skipped.
    wasm.insertTextInCell(s, p, c, i, 0, 0, 'Z'); revision++;
    await live.capturePending();
    assert.equal(catalogReads, baseline + 2);
    assert.ok(live.drain(0).at(-1)!.text.startsWith('Z한😀'));
    // A subsequent hinted edit must not conceal an intervening uninstrumented edit.
    wasm.insertTextInCell(s, p, c, i, 0, 0, 'U'); revision++;
    const other = cells[1]!;
    const [s2, p2, c2, i2] = other.id.split(':').slice(1).map(Number) as [number, number, number, number];
    wasm.insertTextInCell(s2, p2, c2, i2, 0, 0, 'V');
    live.noteMutation(++revision, [other.id]);
    await live.capturePending();
    assert.equal(catalogReads, baseline + 3);
    assert.ok(live.drain(0).some(m => m.regionId === cell.id && m.text.startsWith('UZ한😀')));
  } finally { wasm.releaseDocument(); }
});

test('native format boundaries preserve astral offsets and script changes without per-glyph calls', async () => {
  const { groupRuns } = await import('../src/embed/collaboration-live-adapter.ts');
  const text = '한'.repeat(10_000) + '😀abc';
  const calls: number[] = [];
  const properties = (offset: number) => {
    calls.push(offset);
    return { bold: offset >= 10_000 } as ReturnType<WasmBridge['getCharPropertiesAt']>;
  };
  const runs = groupRuns(text, properties, [0, 10_000, 10_001]);
  assert.deepEqual(calls, [0, 10_000, 10_001]);
  assert.deepEqual(runs.map(({ start, end, properties }) => [start, end, properties.bold]), [
    [0, 10_000, false], [10_000, 10_005, true],
  ]);
  calls.length = 0;
  const fallback = groupRuns('한😀a', properties, [0, 99]);
  assert.deepEqual(calls, [0, 1, 2], 'invalid native boundaries use safe exhaustive reads');
  assert.equal(fallback.at(-1)!.end, 4);
});

test('structured format mutations skip immutable markers and unsupported paragraph formatting', async () => {
  const { structuredTextFormats } = await import('../src/embed/collaboration-live-adapter.ts');
  const operations = structuredTextFormats('a\ufffcb\u2029cd', [
    { type: 'format', version: 1, scope: 'character', offset: 0, count: 6, marks: { bold: true } },
    { type: 'format', version: 1, scope: 'paragraph', offset: 0, count: 6, marks: { alignment: 'right' } },
  ]);
  assert.deepEqual(operations.map(op => [op.offset, op.count]), [[0, 1], [2, 1], [4, 2]]);
});

test('batched native style boundaries equal exhaustive formatting after mixed-script edits', async () => {
  const { groupRuns } = await import('../src/embed/collaboration-live-adapter.ts');
  const wasm = new WasmBridge();
  wasm.loadDocument(await readFile(new URL('../../samples/table-001.hwp', import.meta.url)));
  const catalog = new CollaborationTextAdapter(wasm, { currentRevision: () => 0, afterApply: async () => {} });
  try {
    const cell = (await catalog.getRegions()).find(region => region.kind === 'cell'); assert.ok(cell);
    const [s, p, c, i] = cell.id.split(':').slice(1).map(Number) as [number, number, number, number];
    wasm.insertTextInCell(s, p, c, i, 0, 0, '한글 😀 ABC 한글');
    wasm.applyCharFormatInCell(s, p, c, i, 0, 1, 8, JSON.stringify({ bold: true, textColor: '#ff0000' }));
    const paragraph = wasm.getCollaborationStructuredCell(s, p, c, i).blocks[0].paragraphs[0];
    const read = (offset: number) => wasm.getCellCharPropertiesAt(s, p, c, i, 0, offset);
    assert.deepEqual(groupRuns(paragraph.text, read, paragraph.charRunStarts), groupRuns(paragraph.text, read));
    assert.ok(paragraph.charRunStarts.length < [...paragraph.text].length);
  } finally { wasm.releaseDocument(); }
});

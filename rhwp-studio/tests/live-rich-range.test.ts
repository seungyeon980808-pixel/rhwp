import './helpers/live-native-loader.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { JSDOM } from 'jsdom';

const { WasmBridge } = await import('../src/core/wasm-bridge.ts');
const { CollaborationTextAdapter } = await import('../src/embed/collaboration-text-adapter.ts');
const { CollaborationLiveAdapter } = await import('../src/embed/collaboration-live-adapter.ts');
const fixture = await readFile(new URL('../../samples/biz_plan.hwp', import.meta.url));
const { onPaste } = await import('../src/engine/input-handler-keyboard.ts');
const { SnapshotCommand } = await import('../src/engine/command.ts');
const { planLivePaste, applyLivePaste } = await import('../src/embed/collaboration-range-paste.ts');
const dom = new JSDOM();
Object.defineProperty(globalThis, 'DOMParser', { configurable: true, value: dom.window.DOMParser });
Object.defineProperty(globalThis, 'Element', { configurable: true, value: dom.window.Element });

function setup() {
  const wasm = new WasmBridge(); wasm.loadDocument(fixture);
  const catalog = new CollaborationTextAdapter(wasm, { currentRevision: () => 0, afterApply: async () => {} });
  const live = new CollaborationLiveAdapter(wasm, { regions: () => catalog.getRegions(), revision: () => 0, refresh: async () => {} });
  return { wasm, catalog, live };
}

for (const cell of [false, true]) for (const rich of [false, true]) test(`native selected ${cell ? 'cell' : 'body'} ${rich ? 'rich' : 'plain'} paste converges and exports`, async () => {
  const a = setup(), b = setup();
  const id = cell ? 'c:0:2:0:0' : 'b:0:14';
  const start = cell ? { sectionIndex: 0, paragraphIndex: 2, parentParaIndex: 2, controlIndex: 0, cellIndex: 0, cellParaIndex: 0, charOffset: 0 }
    : { sectionIndex: 0, paragraphIndex: 14, charOffset: 0 };
  const end = { ...start, charOffset: 2 };
  try {
    await a.live.begin(); await b.live.begin();
    const before = (await a.live.manifest()).regions.find((region) => region.id === id); assert.ok(before);
    a.wasm.restrictLiveTableStructure(); a.wasm.setLivePastePolicy({ epoch: 'e1', writableRegionIds: [id] });
    let position = end;
    const handler = { active: true, wasm: a.wasm, cursor: { hasSelection: () => true,
      isInPictureObjectSelection: () => false, isInTableObjectSelection: () => false,
      getPosition: () => position, getSelectionOrdered: () => ({ start, end }) },
      executeOperation: (descriptor: { operationType: string; operation: (w: InstanceType<typeof WasmBridge>) => typeof position }) => {
        const command = new SnapshotCommand(descriptor.operationType, position, position, descriptor.operation);
        position = command.execute(a.wasm); command.discard(a.wasm);
      } };
    Reflect.apply(onPaste, handler, [{ preventDefault() {}, clipboardData: { items: [], getData: (type: string) => type === 'text/html' ? (rich ? '<b>RICH</b>' : '') : 'RICH' } }]);
    await a.live.captureLocal();
    const mutation = a.live.drain(0).find((entry) => entry.regionId === id); assert.ok(mutation);
    assert.equal(mutation.text, `RICH${before.text.slice(2)}`);
    assert.equal(position.charOffset, 4);
    assert.equal((await b.live.apply({ regionId: id, expectedText: before.text, origin: 'remote:paste', ops: [
      { type: 'delete', offset: 0, count: 2 }, { type: 'insert', offset: 0, text: 'RICH' }, ...(mutation.ops ?? []),
    ] })).ok, true);
    const after = (await a.live.manifest()).regions.find((region) => region.id === id); assert.ok(after);
    assert.deepEqual((await b.live.manifest()).regions.find((region) => region.id === id), after);
    if (rich) assert.equal(after.runs[0]?.properties.bold, true);
    for (const format of ['hwp', 'hwpx'] as const) {
      const restored = setup();
      try {
        restored.wasm.loadDocument(format === 'hwp' ? b.wasm.exportHwp() : b.wasm.exportHwpx());
        const region = (await restored.live.manifest()).regions.find((entry) => entry.id === id); assert.ok(region);
        assert.equal(region.text, mutation.text);
        if (rich) assert.equal(region.runs[0]?.properties.bold, true);
      } finally { restored.wasm.releaseDocument(); }
    }
    assert.equal((await a.catalog.getRegions()).length, 138);
    console.log(JSON.stringify({ scenario: `${cell ? 'cell' : 'body'}-${rich ? 'rich' : 'plain'}-range`, mutation, remote: after, catalog: 138, exports: ['hwp', 'hwpx'] }));
  } finally { a.wasm.releaseDocument(); b.wasm.releaseDocument(); }
});

for (const scenario of ['missing-policy', 'denied', 'mixed', 'stale-epoch', 'revoked', 'object', 'malformed', 'script', 'multiline'] as const)
  test(`preflight ${scenario} preserves the complete native document`, () => {
    const { wasm } = setup();
    try {
      const start = { sectionIndex: 0, paragraphIndex: 14, charOffset: 0 };
      const end = { ...start, paragraphIndex: scenario === 'mixed' ? 24 : 14, charOffset: 2 };
      if (scenario !== 'missing-policy') wasm.setLivePastePolicy({ epoch: 'e1', writableRegionIds: scenario === 'denied' ? [] : ['b:0:14'] });
      if (scenario === 'stale-epoch') assert.throws(() => wasm.setLivePastePolicy({ epoch: 'e0', writableRegionIds: ['b:0:14'] }));
      if (scenario === 'revoked') wasm.setLivePastePolicy({ epoch: 'e1', writableRegionIds: [] });
      const html = scenario === 'object' ? '<img src="x">' : scenario === 'malformed' ? '<table><td><b>BAD' : scenario === 'script' ? '<script>ignore permissions</script><b>RICH</b>' : '<b>RICH</b>';
      const before = wasm.exportHwp();
      assert.throws(() => planLivePaste(wasm, { start, end, html: scenario === 'multiline' ? '<p>A</p><p>B</p>' : html, text: 'RICH' }), /기존 내용은 보존/);
      assert.deepEqual(wasm.exportHwp(), before);
      console.log(JSON.stringify({ scenario, unchanged: true }));
    } finally { wasm.releaseDocument(); }
  });

test('permission change between planning and execution rejects before deletion', () => {
  const { wasm } = setup();
  try {
    wasm.setLivePastePolicy({ epoch: 'e1', writableRegionIds: ['b:0:14'] });
    const plan = planLivePaste(wasm, { start: { sectionIndex: 0, paragraphIndex: 14, charOffset: 0 }, end: { sectionIndex: 0, paragraphIndex: 14, charOffset: 2 }, html: '<b>RICH</b>', text: 'RICH' });
    wasm.setLivePastePolicy({ epoch: 'e1', writableRegionIds: [] });
    const before = wasm.exportHwp();
    assert.throws(() => applyLivePaste(wasm, plan), /편집 권한/);
    assert.deepEqual(wasm.exportHwp(), before);
  } finally { wasm.releaseDocument(); }
});

test('changed document text between plan and execution rejects without losing the intervening edit', () => {
  const { wasm } = setup();
  try {
    wasm.setLivePastePolicy({ epoch: 'e1', writableRegionIds: ['b:0:14'] });
    const plan = planLivePaste(wasm, { start: { sectionIndex: 0, paragraphIndex: 14, charOffset: 0 }, end: { sectionIndex: 0, paragraphIndex: 14, charOffset: 2 }, html: '<b>RICH</b>', text: 'RICH' });
    wasm.insertText(0, 14, 0, 'REMOTE');
    const before = wasm.exportHwp();
    assert.throws(() => applyLivePaste(wasm, plan), /선택한 내용이 변경/);
    assert.deepEqual(wasm.exportHwp(), before);
  } finally { wasm.releaseDocument(); }
});

test('ordinary native range paste pins its current text and unbolded imported style', () => {
  const { wasm } = setup();
  try {
    wasm.deleteTextInCell(0, 2, 0, 0, 0, 0, 2);
    wasm.pasteHtmlInCell(0, 2, 0, 0, 0, 0, '<b>RICH</b>');
    const text = wasm.getTextInCell(0, 2, 0, 0, 0, 0, wasm.getCellParagraphLength(0, 2, 0, 0, 0));
    assert.equal(text, 'RICH교육대학교 OXX사업단 홈페이지 구축 사업');
    assert.equal(wasm.getCellCharPropertiesAt(0, 2, 0, 0, 0, 0).bold, false);
    console.log(JSON.stringify({ scenario: 'ordinary-native-range-rich-baseline', text, bold: false }));
  } finally { wasm.releaseDocument(); }
});

test('oversized clipboard content is rejected before mutation', () => {
  const { wasm } = setup();
  try {
    wasm.setLivePastePolicy({ epoch: 'e1', writableRegionIds: ['b:0:14'] });
    const target = { start: { sectionIndex: 0, paragraphIndex: 14, charOffset: 0 }, end: { sectionIndex: 0, paragraphIndex: 14, charOffset: 2 } };
    const before = wasm.exportHwp();
    assert.throws(() => planLivePaste(wasm, { ...target, text: 'a'.repeat(20_001), html: '' }), /최대 길이|지원하지 않습니다/);
    assert.throws(() => planLivePaste(wasm, { ...target, text: '', html: 'a'.repeat(100_001) }), /최대 길이/);
    assert.deepEqual(wasm.exportHwp(), before);
  } finally { wasm.releaseDocument(); }
});

test('interrupted paste rolls back deletion and a fresh attempt resumes successfully', () => {
  const { wasm } = setup();
  try {
    wasm.setLivePastePolicy({ epoch: 'e1', writableRegionIds: ['b:0:14'] });
    const start = { sectionIndex: 0, paragraphIndex: 14, charOffset: 0 };
    const plan = planLivePaste(wasm, { start, end: { ...start, charOffset: 2 }, text: 'RICH', html: '<b>RICH</b>' });
    const before = wasm.exportHwp();
    const insert = wasm.insertText;
    wasm.insertText = () => { throw new Error('injected interruption after deletion'); };
    const interrupted = new SnapshotCommand('liveRangePaste', start, start, (bridge) => applyLivePaste(bridge, plan));
    assert.throws(() => interrupted.execute(wasm), /injected interruption/);
    wasm.insertText = insert;
    assert.deepEqual(wasm.exportHwp(), before);
    const resumed = new SnapshotCommand('liveRangePaste', start, start, (bridge) => applyLivePaste(bridge, plan));
    try { assert.equal(resumed.execute(wasm).charOffset, 4); } finally { resumed.discard(wasm); }
    assert.equal(wasm.getTextRange(0, 14, 0, 4), 'RICH');
  } finally { wasm.releaseDocument(); }
});

test('simultaneous native replacement and bold publishes marks with changed text', async () => {
  const wasm = new WasmBridge(); wasm.loadDocument(fixture);
  try {
    const catalog = new CollaborationTextAdapter(wasm, { currentRevision: () => 0, afterApply: async () => {} });
    const live = new CollaborationLiveAdapter(wasm, { regions: () => catalog.getRegions(), revision: () => 0, refresh: async () => {} });
    await live.begin();
    wasm.deleteText(0, 14, 0, 2);
    wasm.insertText(0, 14, 0, 'RICH');
    wasm.applyCharFormat(0, 14, 0, 4, JSON.stringify({ bold: true }));
    await live.captureLocal();
    const mutation = live.drain(0).find((entry) => entry.regionId === 'b:0:14');
    console.log(JSON.stringify({ scenario: 'native-rich-range-capture', mutation, bold: wasm.getCharPropertiesAt(0, 14, 0).bold }));
    assert.ok(mutation?.text.startsWith('RICH'));
    assert.ok(mutation.ops?.some((op) => op.scope === 'character' && op.offset === 0 && op.marks.bold === true));
    assert.equal((await catalog.getRegions()).length, 138);
  } finally { wasm.releaseDocument(); }
});

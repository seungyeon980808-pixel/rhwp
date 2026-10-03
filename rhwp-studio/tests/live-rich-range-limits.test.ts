import './helpers/live-native-loader.ts';
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { JSDOM } from 'jsdom';

const { WasmBridge } = await import('../src/core/wasm-bridge.ts');
const { CollaborationTextAdapter } = await import('../src/embed/collaboration-text-adapter.ts');
const { CollaborationLiveAdapter } = await import('../src/embed/collaboration-live-adapter.ts');
const { planLivePaste, applyLivePaste } = await import('../src/embed/collaboration-range-paste.ts');
const { routeEmbedRequest } = await import('../src/embed/rpc-router.ts');
const { RhwpEditor } = await import('../../npm/editor/index.js');
const fixture = await readFile(new URL('../../samples/biz_plan.hwp', import.meta.url));
const artifact = new URL('../../../../.omo/evidence/ourdocs-live-regions/task-5-rich-range/repair-exports/', import.meta.url);
await mkdir(artifact, { recursive: true });
const dom = new JSDOM();
Object.defineProperty(globalThis, 'DOMParser', { configurable: true, value: dom.window.DOMParser });
Object.defineProperty(globalThis, 'Element', { configurable: true, value: dom.window.Element });
after(() => dom.window.close());

function setup() {
  const wasm = new WasmBridge(); wasm.loadDocument(fixture);
  const catalog = new CollaborationTextAdapter(wasm, { currentRevision: () => 0, afterApply: async () => {} });
  const live = new CollaborationLiveAdapter(wasm, { regions: () => catalog.getRegions(), revision: () => 0, refresh: async () => {} });
  return { wasm, catalog, live };
}

for (const cell of [false, true]) test(`UTF-16 limit covers entire ${cell ? 'multi-paragraph cell' : 'body'} region`, () => {
  const { wasm } = setup();
  try {
    const start = cell ? { sectionIndex: 0, paragraphIndex: 2, parentParaIndex: 2, controlIndex: 0, cellIndex: 0, cellParaIndex: 1, charOffset: 0 }
      : { sectionIndex: 0, paragraphIndex: 14, charOffset: 19_999 };
    if (cell) {
      wasm.deleteTextInCell(0, 2, 0, 0, 0, 0, wasm.getCellParagraphLength(0, 2, 0, 0, 0));
      wasm.insertTextInCell(0, 2, 0, 0, 0, 0, 'a'.repeat(19_998));
      wasm.splitParagraphInCell(0, 2, 0, 0, 0, 19_998);
      wasm.insertTextInCell(0, 2, 0, 0, 1, 0, 'a');
    } else {
      wasm.deleteText(0, 14, 0, wasm.getParagraphLength(0, 14));
      wasm.insertText(0, 14, 0, 'a'.repeat(20_000));
    }
    wasm.setLivePastePolicy({ epoch: 'e1', writableRegionIds: [cell ? 'c:0:2:0:0' : 'b:0:14'] });
    const before = wasm.exportHwp();
    assert.throws(() => planLivePaste(wasm, { start, end: { ...start, charOffset: start.charOffset + 1 }, html: '', text: '😀' }), /최대 길이/);
    assert.deepEqual(wasm.exportHwp(), before);
    console.log(JSON.stringify({ scenario: cell ? 'cell-total-utf16-overflow' : 'body-utf16-overflow', rejected: true, unchanged: true }));
  } finally { wasm.releaseDocument(); }
});

test('120 alternating rich marks replay atomically through public editor and real RPC into WASM', async () => {
  const a = setup(), b = setup();
  try {
    await a.live.begin(); await b.live.begin();
    const before = (await a.catalog.getRegions()).find((r) => r.id === 'b:0:14'); assert.ok(before);
    a.wasm.setLivePastePolicy({ epoch: 'e1', writableRegionIds: ['b:0:14'] });
    const start = { sectionIndex: 0, paragraphIndex: 14, charOffset: 0 };
    const plan = planLivePaste(a.wasm, { start, end: { ...start, charOffset: 2 }, html: '<b>B</b><i>I</i>'.repeat(60), text: 'BI'.repeat(60) });
    applyLivePaste(a.wasm, plan); await a.live.captureLocal();
    const mutation = a.live.drain(0).find((entry) => entry.regionId === before.id); assert.ok(mutation);
    const calls: string[] = [];
    const editor = new RhwpEditor({ remove() {} }, { supports: () => true, destroy() {}, request(method: string, params: unknown) {
      calls.push(method);
      return routeEmbedRequest(method, params, { applyCollaborationOps: (request) => b.live.apply(request) });
    } });
    const ops = [{ type: 'delete', offset: 0, count: 2 }, { type: 'insert', offset: 0, text: 'BI'.repeat(60) }, ...(mutation.ops ?? [])];
    assert.ok(ops.length > 100);
    const result = await editor.applyCollaborationOps({ regionId: before.id, expectedText: before.text, origin: 'remote:rich-limit', ops });
    assert.equal(result.ok, true);
    assert.equal(calls.length, 1);
    const local = (await a.live.manifest()).regions.find((r) => r.id === before.id);
    const remote = (await b.live.manifest()).regions.find((r) => r.id === before.id);
    assert.deepEqual(remote, local);
    for (const format of ['hwp', 'hwpx'] as const) {
      const bytes = format === 'hwp' ? b.wasm.exportHwp() : b.wasm.exportHwpx();
      await writeFile(new URL(`alternating-rich.${format}`, artifact), bytes);
      const reopened = setup();
      try {
        reopened.wasm.loadDocument(bytes);
        const actual = (await reopened.live.manifest()).regions.find((r) => r.id === before.id); assert.ok(actual);
        assert.equal(actual.text, mutation.text);
        for (let offset = 0; offset < 120; offset++) {
          const marks = reopened.wasm.getCharPropertiesAt(0, 14, offset);
          assert.equal(marks.bold, offset % 2 === 0); assert.equal(marks.italic, offset % 2 === 1);
        }
      } finally { reopened.wasm.releaseDocument(); }
    }
    assert.equal((await b.catalog.getRegions()).length, 138);
    console.log(JSON.stringify({ scenario: 'rich-120-public-rpc', operations: ops.length, requests: calls.length, text: mutation.text, allMarksPreserved: true, catalog: 138 }));
  } finally { a.wasm.releaseDocument(); b.wasm.releaseDocument(); }
});

test('emoji replacement at exactly 20000 UTF-16 units converges, preserves permission and reopens', async () => {
  const a = setup(), b = setup();
  try {
    for (const { wasm } of [a, b]) {
      wasm.deleteText(0, 14, 0, wasm.getParagraphLength(0, 14));
      wasm.insertText(0, 14, 0, 'a'.repeat(19_998) + '😀');
    }
    await a.live.begin(); await b.live.begin();
    const start = { sectionIndex: 0, paragraphIndex: 14, charOffset: 19_998 };
    const input = { start, end: { ...start, charOffset: 19_999 }, html: '<b>😁</b>', text: '😁' };
    const before = a.wasm.exportHwp();
    assert.throws(() => planLivePaste(a.wasm, input), /권한/);
    assert.deepEqual(a.wasm.exportHwp(), before);
    a.wasm.setLivePastePolicy({ epoch: 'e1', writableRegionIds: ['b:0:14'] });
    applyLivePaste(a.wasm, planLivePaste(a.wasm, input)); await a.live.captureLocal();
    const mutation = a.live.drain(0).find((entry) => entry.regionId === 'b:0:14'); assert.ok(mutation);
    assert.equal(mutation.text.length, 20_000);
    const result = await routeEmbedRequest('applyCollaborationOps', { regionId: mutation.regionId, expectedText: 'a'.repeat(19_998) + '😀', origin: 'remote:emoji', ops: [
      { type: 'delete', offset: 19_998, count: 2 }, { type: 'insert', offset: 19_998, text: '😁' }, ...(mutation.ops ?? []),
    ] }, { applyCollaborationOps: (request) => b.live.apply(request) });
    assert.equal(result.ok, true);
    assert.deepEqual((await a.live.manifest()).regions, (await b.live.manifest()).regions);
    for (const format of ['hwp', 'hwpx'] as const) {
      const bytes = format === 'hwp' ? b.wasm.exportHwp() : b.wasm.exportHwpx();
      await writeFile(new URL(`emoji-limit.${format}`, artifact), bytes);
      const reopened = setup();
      try {
        reopened.wasm.loadDocument(bytes);
        assert.equal(reopened.wasm.getTextRange(0, 14, 0, 19_999), mutation.text);
        assert.equal(reopened.wasm.getCharPropertiesAt(0, 14, 19_998).bold, true);
      } finally { reopened.wasm.releaseDocument(); }
    }
    console.log(JSON.stringify({ scenario: 'emoji-exact-utf16-limit', utf16Length: mutation.text.length, scalarLength: [...mutation.text].length, remote: result.ok, bold: true }));
  } finally { a.wasm.releaseDocument(); b.wasm.releaseDocument(); }
});

test('wire operation budget rolls back an oversized rich paste and permits retry at the supported limit', async () => {
  const a = setup(), b = setup();
  try {
    await a.live.begin(); await b.live.begin();
    a.wasm.setLivePastePolicy({ epoch: 'e1', writableRegionIds: ['b:0:14'] });
    const start = { sectionIndex: 0, paragraphIndex: 14, charOffset: 0 };
    const before = a.wasm.exportHwp();
    const original = a.wasm.getTextRange(0, 14, 0, a.wasm.getParagraphLength(0, 14));
    const plan = (repeat: number) => planLivePaste(a.wasm, { start, end: { ...start, charOffset: 2 }, html: '<b>B</b><i>I</i>'.repeat(repeat), text: 'BI'.repeat(repeat) });
    assert.throws(() => applyLivePaste(a.wasm, plan(500)), /서식 범위 수/);
    assert.deepEqual(a.wasm.exportHwp(), before);
    await a.live.captureLocal(); assert.deepEqual(a.live.drain(0), []);
    applyLivePaste(a.wasm, plan(499)); await a.live.captureLocal();
    const mutation = a.live.drain(0)[0]; assert.ok(mutation);
    const ops = [{ type: 'delete', offset: 0, count: 2 }, { type: 'insert', offset: 0, text: 'BI'.repeat(499) }, ...(mutation.ops ?? [])];
    assert.equal(ops.length, 1_000);
    const editor = new RhwpEditor({ remove() {} }, { supports: () => true, destroy() {}, request: (method: string, params: unknown) =>
      routeEmbedRequest(method, params, { applyCollaborationOps: (request) => b.live.apply(request) }) });
    const remoteBefore = b.wasm.exportHwp();
    const malformed = [...ops.slice(0, -1), { type: 'format', version: 1, scope: 'character', offset: 99999, count: 1, marks: { bold: true } }];
    assert.equal((await editor.applyCollaborationOps({ regionId: 'b:0:14', expectedText: original, origin: 'remote:invalid-last', ops: malformed })).ok, false);
    assert.deepEqual(b.wasm.exportHwp(), remoteBefore);
    assert.equal((await editor.applyCollaborationOps({ regionId: 'b:0:14', expectedText: original, origin: 'remote:max', ops })).ok, true);
    assert.deepEqual((await a.live.manifest()).regions, (await b.live.manifest()).regions);
    console.log(JSON.stringify({ scenario: 'atomic-wire-budget', oversizedRolledBack: true, rejectedMutationCount: 0, validRetryOperations: ops.length, malformedTailUnchanged: true }));
  } finally { a.wasm.releaseDocument(); b.wasm.releaseDocument(); }
});

test('nonzero cell paragraph emoji offsets replay in UTF-16 while native selection uses scalars', async () => {
  const a = setup(), b = setup();
  try {
    for (const { wasm } of [a, b]) {
      wasm.deleteTextInCell(0, 2, 0, 0, 0, 0, wasm.getCellParagraphLength(0, 2, 0, 0, 0));
      wasm.insertTextInCell(0, 2, 0, 0, 0, 0, 'a😀bc');
      wasm.splitParagraphInCell(0, 2, 0, 0, 0, 2);
    }
    await a.live.begin(); await b.live.begin();
    a.wasm.setLivePastePolicy({ epoch: 'e1', writableRegionIds: ['c:0:2:0:0'] });
    const start = { sectionIndex: 0, paragraphIndex: 2, parentParaIndex: 2, controlIndex: 0, cellIndex: 0, cellParaIndex: 1, charOffset: 0 };
    applyLivePaste(a.wasm, planLivePaste(a.wasm, { start, end: { ...start, charOffset: 1 }, html: '<b>😁</b>', text: '😁' }));
    await a.live.captureLocal();
    const mutation = a.live.drain(0)[0]; assert.ok(mutation); assert.equal(mutation.text, 'a😀\n😁c');
    const result = await routeEmbedRequest('applyCollaborationOps', { regionId: mutation.regionId, expectedText: 'a😀\nbc', origin: 'remote:cell-emoji', ops: [
      { type: 'delete', offset: 4, count: 1 }, { type: 'insert', offset: 4, text: '😁' }, ...(mutation.ops ?? []),
    ] }, { applyCollaborationOps: (request) => b.live.apply(request) });
    assert.equal(result.ok, true);
    assert.deepEqual((await a.live.manifest()).regions, (await b.live.manifest()).regions);
    for (const format of ['hwp', 'hwpx'] as const) {
      const bytes = format === 'hwp' ? b.wasm.exportHwp() : b.wasm.exportHwpx();
      await writeFile(new URL(`cell-emoji.${format}`, artifact), bytes);
      const reopened = setup();
      try {
        reopened.wasm.loadDocument(bytes);
        assert.equal((await reopened.catalog.getRegions()).find((region) => region.id === mutation.regionId)?.text, mutation.text);
        assert.equal(reopened.wasm.getCellCharPropertiesAt(0, 2, 0, 0, 1, 0).bold, true);
      } finally { reopened.wasm.releaseDocument(); }
    }
    console.log(JSON.stringify({ scenario: 'nonzero-cell-emoji', text: mutation.text, wireOffset: 4, nativeOffset: 0, bold: true }));
  } finally { a.wasm.releaseDocument(); b.wasm.releaseDocument(); }
});

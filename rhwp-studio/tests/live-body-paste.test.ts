import './helpers/live-native-loader.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const { WasmBridge } = await import('../src/core/wasm-bridge.ts');
const { SplitParagraphCommand, MergeParagraphCommand } = await import('../src/engine/command.ts');
const { CollaborationTextAdapter } = await import('../src/embed/collaboration-text-adapter.ts');
const { CollaborationLiveAdapter } = await import('../src/embed/collaboration-live-adapter.ts');
const fixture = await readFile(new URL('../../samples/biz_plan.hwp', import.meta.url));
const { onPaste } = await import('../src/engine/input-handler-keyboard.ts');
const operations = [
  ['body-enter', (w: InstanceType<typeof WasmBridge>) => new SplitParagraphCommand({ sectionIndex: 0, paragraphIndex: 14, charOffset: 2 }).execute(w)],
  ['body-merge', (w: InstanceType<typeof WasmBridge>) => new MergeParagraphCommand({ sectionIndex: 0, paragraphIndex: 15, charOffset: 0 }).execute(w)],
  ['html-table', (w: InstanceType<typeof WasmBridge>) => w.pasteHtml(0, 14, 0, '<table><tr><td>PASTED</td></tr></table>')],
  ['html-rich', (w: InstanceType<typeof WasmBridge>) => w.pasteHtml(0, 14, 0, '<p><b>RICH</b></p>')],
  ['html-malformed', (w: InstanceType<typeof WasmBridge>) => w.pasteHtml(0, 14, 0, '<table><td><b>INCOMPLETE')],
  ['body-range', (w: InstanceType<typeof WasmBridge>) => w.deleteRange(0, 14, 0, 15, 2)],
  ['nested-html', (w: InstanceType<typeof WasmBridge>) => w.pasteHtmlInCellByPath(0, 2, '[{"controlIndex":0,"cellIndex":0,"paraIndex":0}]', 0, '<table><tr><td><table><tr><td>NESTED</td></tr></table></td></tr></table>')],
  ['merged-html', (w: InstanceType<typeof WasmBridge>) => w.pasteHtmlInCell(0, 2, 0, 0, 0, 0, '<table><tr><td colspan="2">MERGED</td></tr></table>')],
] as const;

for (const [name, operation] of operations) test(`live ${name} preserves catalog and later mutations atomically`, async () => {
  // Given a real native document with pending body text and a frozen live map.
  const wasm = new WasmBridge(); wasm.loadDocument(fixture);
  try {
    const catalog = new CollaborationTextAdapter(wasm, { currentRevision: () => 0, afterApply: async () => {} });
    const live = new CollaborationLiveAdapter(wasm, { regions: () => catalog.getRegions(), revision: () => 0, refresh: async () => {} });
    assert.equal((await catalog.getRegions()).length, 136);
    await live.begin();
    wasm.insertText(0, 14, 0, 'PENDING');
    const before = wasm.inspectApprovedTemplate();
    wasm.restrictLiveTableStructure();
    // When the unsupported operation arrives, observe even an unexpected success.
    let reason = '';
    try { operation(wasm); } catch (error) { if (!(error instanceof Error)) throw error; reason = error.message; }
    const count = (await catalog.getRegions()).length;
    wasm.insertText(0, 14, 0, 'LOCAL');
    await live.captureLocal();
    const mutations = live.drain(0).filter((mutation) => mutation.origin === 'local');
    console.log(JSON.stringify({ scenario: name, catalogBefore: 136, catalogAfter: count, mutations: mutations.length, native: mutations[0]?.text, reason }));
    // Then the original/pending content survives and LOCAL remains publishable.
    assert.equal(count, 136);
    assert.ok(reason.includes('공동편집'));
    assert.equal(mutations.length, 1);
    assert.ok(mutations[0]?.text.startsWith('LOCALPENDING'));
    wasm.deleteText(0, 14, 0, 5);
    assert.deepEqual(wasm.inspectApprovedTemplate(), before);
  } finally { wasm.releaseDocument(); }
});

test('live plain single-line paste retains Korean text and captures one mutation', async () => {
  const wasm = new WasmBridge(); wasm.loadDocument(fixture); wasm.restrictLiveTableStructure();
  try {
    const catalog = new CollaborationTextAdapter(wasm, { currentRevision: () => 0, afterApply: async () => {} });
    const live = new CollaborationLiveAdapter(wasm, { regions: () => catalog.getRegions(), revision: () => 0, refresh: async () => {} });
    await live.begin();
    const handler = { active: true, wasm, cursor: { hasSelection: () => false, isInPictureObjectSelection: () => false, isInTableObjectSelection: () => false,
      getPosition: () => ({ sectionIndex: 0, paragraphIndex: 14, charOffset: 0 }), isInCell: () => false },
      executeOperation: (descriptor: { readonly command: { execute: (bridge: InstanceType<typeof WasmBridge>) => unknown } }) => descriptor.command.execute(wasm) };
    const event = { preventDefault: () => {}, clipboardData: { getData: (type: string) => type === 'text/plain' ? '한글 LOCAL' : '', items: [] } };
    Reflect.apply(onPaste, handler, [event]);
    await live.captureLocal();
    const mutations = live.drain(0).filter((mutation) => mutation.origin === 'local');
    assert.equal(mutations.length, 1);
    assert.ok(mutations[0]?.text.startsWith('한글 LOCAL'));
    assert.equal((await catalog.getRegions()).length, 136);
  } finally { wasm.releaseDocument(); }
});

for (const [name, operation] of operations.slice(0, 4)) test(`ordinary ${name} retains native behavior`, () => {
  const wasm = new WasmBridge(); wasm.loadDocument(fixture);
  try {
    const before = wasm.inspectApprovedTemplate();
    operation(wasm);
    assert.notDeepEqual(wasm.inspectApprovedTemplate(), before);
  } finally { wasm.releaseDocument(); }
});

for (const [name, html, text, selection] of [
  ['selected-multiline-html', '<p>A</p><p>B</p>', 'A\nB', true],
  ['rich-selection', '<b>RICH</b>', 'RICH', true],
  ['malformed-selection', '<table><td>BAD', 'BAD', true],
  ['plain-selection', '', 'PLAIN', true],
  ['plain-multiline', '', 'A\nB', false],
] as const) test(`native paste event rejects ${name} before selection deletion with a visible reason`, async () => {
  const wasm = new WasmBridge(); wasm.loadDocument(fixture); wasm.restrictLiveTableStructure();
  const previousWindow = Object.getOwnPropertyDescriptor(globalThis, 'window');
  const reasons: string[] = [];
  Object.defineProperty(globalThis, 'window', { configurable: true, value: { alert: (reason: string) => reasons.push(reason) } });
  try {
    const catalog = new CollaborationTextAdapter(wasm, { currentRevision: () => 0, afterApply: async () => {} });
    assert.equal((await catalog.getRegions()).length, 136);
    wasm.insertText(0, 14, 0, 'PENDING');
    const before = wasm.inspectApprovedTemplate();
    let prevented = false;
    const event = { preventDefault: () => { prevented = true; }, clipboardData: { getData: (type: string) => type === 'text/html' ? html : text, items: [] } };
    const handler = { active: true, wasm, cursor: { hasSelection: () => selection, isInPictureObjectSelection: () => false, isInTableObjectSelection: () => false,
      getSelectionOrdered: () => ({ start: { sectionIndex: 0, paragraphIndex: 14, charOffset: 0 }, end: { sectionIndex: 0, paragraphIndex: 14, charOffset: 2 } }),
      getPosition: () => ({ sectionIndex: 0, paragraphIndex: 14, charOffset: 2 }) },
      deleteSelection: () => assert.fail('Rejected paste deleted selection'), executeOperation: () => assert.fail('Rejected paste started an operation') };
    Reflect.apply(onPaste, handler, [event]);
    assert.equal(prevented, true);
    assert.equal(reasons.length, 1);
    assert.ok(reasons[0]?.includes('기존 내용은 보존'));
    assert.deepEqual(wasm.inspectApprovedTemplate(), before);
    assert.equal((await catalog.getRegions()).length, 136);
    console.log(JSON.stringify({ scenario: name, prevented, reason: reasons[0], catalog: 136, unchanged: true }));
  } finally {
    wasm.releaseDocument();
    if (previousWindow) Object.defineProperty(globalThis, 'window', previousWindow);
    else Reflect.deleteProperty(globalThis, 'window');
  }
});

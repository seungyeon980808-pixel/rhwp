import './helpers/live-native-loader.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import type { EditorContext, CommandServices } from '../src/command/types.ts';

const { WasmBridge } = await import('../src/core/wasm-bridge.ts');
const { CollaborationTextAdapter } = await import('../src/embed/collaboration-text-adapter.ts');
const { CollaborationLiveAdapter } = await import('../src/embed/collaboration-live-adapter.ts');
const { UnsupportedLiveStructureError } = await import('../src/embed/collaboration-structure-boundary.ts');
const { CommandDispatcher } = await import('../src/command/dispatcher.ts');
const { CommandRegistry } = await import('../src/command/registry.ts');
const { tableCommands } = await import('../src/command/commands/table.ts');
const { EventBus } = await import('../src/core/event-bus.ts');
const { DocumentDirtyState } = await import('../src/core/document-dirty-state.ts');
const fixture = await readFile(new URL('../../samples/biz_plan.hwp', import.meta.url));

function harness() {
  const wasm = new WasmBridge();
  wasm.loadDocument(fixture);
  const catalog = new CollaborationTextAdapter(wasm, { currentRevision: () => 0, afterApply: async () => {} });
  const live = new CollaborationLiveAdapter(wasm, { regions: () => catalog.getRegions(), revision: () => 0, refresh: async () => {} });
  return { wasm, catalog, live };
}

test('ordinary native row insertion adds a row when live collaboration has not started', () => {
  const h = harness();
  try {
    assert.equal(h.wasm.getTableDimensions(0, 2, 0).rowCount, 2);
    h.wasm.insertTableRow(0, 2, 0, 0, true);
    assert.equal(h.wasm.getTableDimensions(0, 2, 0).rowCount, 3);
  } finally { h.wasm.releaseDocument(); }
});

const operations = [
  ['insert row', (w: InstanceType<typeof WasmBridge>) => w.insertTableRow(0, 2, 0, 0, true)],
  ['insert column', (w: InstanceType<typeof WasmBridge>) => w.insertTableColumn(0, 2, 0, 0, true)],
  ['delete row', (w: InstanceType<typeof WasmBridge>) => w.deleteTableRow(0, 2, 0, 0)],
  ['delete column', (w: InstanceType<typeof WasmBridge>) => w.deleteTableColumn(0, 2, 0, 0)],
  ['delete table', (w: InstanceType<typeof WasmBridge>) => w.deleteTableControl(0, 2, 0)],
  ['merge cells', (w: InstanceType<typeof WasmBridge>) => w.mergeTableCells(0, 2, 0, 0, 0, 1, 0)],
  ['split cell', (w: InstanceType<typeof WasmBridge>) => w.splitTableCell(0, 2, 0, 0, 0)],
  ['split into cells', (w: InstanceType<typeof WasmBridge>) => w.splitTableCellInto(0, 2, 0, 0, 0, 2, 2, false, false)],
  ['split range', (w: InstanceType<typeof WasmBridge>) => w.splitTableCellsInRange(0, 2, 0, 0, 0, 1, 0, 2, 2, false)],
  ['split table', (w: InstanceType<typeof WasmBridge>) => w.splitTable(0, 2, 0, 1)],
  ['attach table', (w: InstanceType<typeof WasmBridge>) => w.mergeTableWithNext(0, 2, 0)],
  ['create table', (w: InstanceType<typeof WasmBridge>) => w.createTable(0, 14, 0, 2, 2)],
  ['create table options', (w: InstanceType<typeof WasmBridge>) => w.createTableEx({ sectionIdx: 0, paraIdx: 14, charOffset: 0, rowCount: 2, colCount: 2 })],
  ['transpose paste', (w: InstanceType<typeof WasmBridge>) => w.pasteTableCellsTransposed(0, 2, 0, 0, 0)],
  ['transpose in place', (w: InstanceType<typeof WasmBridge>) => w.transposeTableCellsInPlace(0, 2, 0)],
  ['transpose as table', (w: InstanceType<typeof WasmBridge>) => w.pasteTableCellsTransposedAsTable(0, 14, 0)],
  ['caption structure', (w: InstanceType<typeof WasmBridge>) => w.setTableProperties(0, 2, 0, { hasCaption: true })],
  ['malformed coordinates', (w: InstanceType<typeof WasmBridge>) => w.insertTableRow(NaN, -1, Infinity, -1, true)],
] as const;

for (const [name, operation] of operations) test(`live ${name} rejects before native mutation and retains pending text`, async () => {
  const h = harness();
  try {
    const before = await h.catalog.getRegions();
    assert.equal(before.length, 138);
    await h.live.begin();
    h.wasm.insertTextInCell(0, 2, 0, 0, 0, 0, 'PENDING<script>');
    h.wasm.restrictLiveTableStructure();
    const inspection = h.wasm.inspectApprovedTemplate();
    assert.throws(() => operation(h.wasm), UnsupportedLiveStructureError);
    assert.deepEqual(h.wasm.inspectApprovedTemplate(), inspection);
    assert.equal((await h.catalog.getRegions()).length, 138);
    await h.live.captureLocal();
    assert.equal(h.live.drain(0).filter((m) => m.origin === 'local').length, 1);
    assert.equal((await h.catalog.getRegions()).find((r) => r.id === 'c:0:2:0:0')?.text,
      `PENDING<script>${before.find((r) => r.id === 'c:0:2:0:0')?.text}`);
  } finally { h.wasm.releaseDocument(); }
});

test('dispatcher rejects live structural commands with a reason, including stale ordinary availability', () => {
  const eventBus = new EventBus();
  let live = false;
  const context = (): EditorContext => ({ hasDocument: true, hasSelection: true, hasCopiedFormat: false,
    inTable: true, inCellSelectionMode: true, hasMultiCellSelection: true, hasTableTransposeClipboard: true,
    inTableObjectSelection: true, inPictureObjectSelection: false, inField: false, isEditable: true,
    editMode: 'normal', isFormMode: false, canEditFormField: false, canUndo: true, canRedo: true,
    zoom: 1, showControlCodes: false, showParagraphMarks: false, isDirty: true, isLiveCollaboration: live });
  const services: CommandServices = { eventBus, wasm: new WasmBridge(), documentState: new DocumentDirtyState(eventBus),
    getContext: context, getInputHandler: () => { assert.fail('Rejected command accessed input handler'); },
    getViewportManager: () => null, gotoPage: () => false, setEditMode: () => {} };
  const registry = new CommandRegistry(); registry.registerAll(tableCommands);
  const dispatcher = new CommandDispatcher(registry, services, eventBus);
  assert.equal(dispatcher.isEnabled('table:insert-row-below'), true);
  live = true;
  for (const id of ['table:create', 'table:insert-row-col', 'table:delete-row-col', 'table:insert-row-above',
    'table:insert-row-below', 'table:insert-col-left', 'table:insert-col-right', 'table:delete-row', 'table:delete-col',
    'table:cell-split', 'table:cell-merge', 'table:transpose-paste', 'table:split', 'table:attach', 'table:delete', 'table:caption-toggle']) {
    assert.equal(dispatcher.isEnabled(id), false, id);
    assert.ok(dispatcher.disabledReason(id));
    assert.equal(dispatcher.dispatch(id, { count: NaN }), false, id);
  }
  assert.equal(dispatcher.dispatch('table:insert-row-below\0'), false);
  assert.equal(dispatcher.isEnabled('table:transpose-copy'), true);
});

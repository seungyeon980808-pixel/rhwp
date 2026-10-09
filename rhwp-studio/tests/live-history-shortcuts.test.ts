import './helpers/live-native-loader.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
const { InputHandler } = await import('../src/engine/input-handler.ts');
const { editCommands } = await import('../src/command/commands/edit.ts');

function editor() {
  const input = Object.create(InputHandler.prototype) as any;
  let position = { sectionIndex: 0, paragraphIndex: 2, charOffset: 0 };
  let entries = 0, clears = 0;
  let live = true, allowed = true, restricted = false, epoch = 'one';
  input.wasm = { isLiveStructureRestricted: () => live, hasRestrictedPromptSpaces: () => restricted, getLivePasteEpoch: () => epoch };
  input.cursor = { getPosition: () => position, getSelectionOrdered: () => null,
    isInHeaderFooter: () => false, isInFootnote: () => false, isInPictureObjectSelection: () => false, isInTableObjectSelection: () => false };
  input.getSelectedCellBlock = () => null;
  input.canEditLiveSelection = () => allowed;
  input.history = { clear() { entries = 0; clears++; }, canUndo: () => entries > 0, canRedo: () => entries > 0 };
  return { input, add() { entries++; }, clears: () => clears, move() { position = { ...position, paragraphIndex: 3 }; },
    setAllowed(value: boolean) { allowed = value; }, setLive(value: boolean) { live = value; },
    setRestricted(value: boolean) { restricted = value; }, changeEpoch() { epoch = 'two'; } };
}

test('same-region native history works in live mode, locks reject it', () => {
  const h = editor(); h.input.syncLiveHistoryScope(); h.add();
  assert.equal(h.input.canUndo(), true); assert.equal(h.input.canRedo(), true);
  h.setAllowed(false); assert.equal(h.input.canUndo(), false);
  h.setAllowed(true); assert.equal(h.input.canUndo(), true);
});

test('moving between regions or changing authority epoch clears stale history', () => {
  const h = editor(); h.input.syncLiveHistoryScope(); h.add(); h.move();
  assert.equal(h.input.canUndo(), false); assert.equal(h.clears(), 2);
  h.add(); assert.equal(h.input.canUndo(), true); h.changeEpoch(); assert.equal(h.input.canUndo(), false);
});

test('restricted prompt history is discarded while unrestricted private history remains available', () => {
  const h = editor(); h.input.syncLiveHistoryScope(); h.add(); h.setRestricted(true);
  assert.equal(h.input.canUndo(), false);
  const solo = editor(); solo.setLive(false); solo.add();
  assert.equal(solo.input.canUndo(), true); assert.equal(solo.clears(), 0);
});

test('remote update discards history even if editor body context is unavailable', () => {
  const h = editor(); h.add(); h.input.getBodyStructureInput = () => null;
  h.input.applyRemoteTextChange({ nativeAddress: 'b:0:2', before: 'A', ops: [] });
  assert.equal(h.clears(), 1); assert.equal(h.input.history.canUndo(), false);
});

test('live undo and redo commands use the guarded availability flags', () => {
  for (const id of ['edit:undo', 'edit:redo']) {
    const command = editCommands.find(command => command.id === id)!;
    assert.equal(command.canExecute!({ hasDocument: true, isLiveCollaboration: true, canUndo: true, canRedo: true } as any), true);
    assert.equal(command.canExecute!({ hasDocument: true, isLiveCollaboration: true, canUndo: false, canRedo: false } as any), false);
  }
});

test('restricted prompt paragraph formatting is blocked at direct APIs and mutation router', () => {
  const h = editor(); h.setRestricted(true);
  let mutations = 0;
  const notices: unknown[][] = [];
  h.input.eventBus = { emit(...args: unknown[]) { notices.push(args); } };
  h.input.applyParaFormatInNoteOrHeader = () => { mutations++; return true; };
  h.input.getParaFormatTargetsForRange = () => [{ sectionIndex: 0, paragraphIndex: 2 }];
  h.input.setLineSpacing(200);
  h.input.applyParaPropsAtCursor({ indent: 1000 });
  h.input.applyParaAlign('Right');
  h.input.applyParaPropsToRange({ sectionIndex: 0, paragraphIndex: 2, charOffset: 0 }, { sectionIndex: 0, paragraphIndex: 2, charOffset: 2 }, { indent: 1000 });
  h.input.isOperationAllowedInEditMode = () => { mutations++; return false; };
  h.input.executeOperation({ kind: 'command', command: { type: 'applyParaFormat' } });
  h.input.executeOperation({ kind: 'snapshot', operationType: 'applyParaFormatInHf', operation() { mutations++; } });
  assert.equal(mutations, 0);
  assert.equal(notices.length, 6);
  assert.ok(notices.every(([event, reason]) => event === 'command-blocked' && String(reason).includes('문서 소유자')));
  h.setLive(false); // Exclusive checkpoint/private document retains paragraph formatting.
  h.input.setLineSpacing(200); assert.equal(mutations, 1);
  h.setLive(true); h.setRestricted(false);
  h.input.applyParaPropsAtCursor({ indent: 1000 }); assert.equal(mutations, 2);
  assert.equal(notices.length, 6, 'allowed operations do not emit blocked notices');
});

test('native snapshot local edit → remote edit → new local edit → undo preserves remote text', async () => {
  const { readFile, writeFile } = await import('node:fs/promises');
  const { WasmBridge } = await import('../src/core/wasm-bridge.ts');
  const { CursorState } = await import('../src/engine/cursor.ts');
  const { CommandHistory } = await import('../src/engine/history.ts');
  const { SnapshotCommand } = await import('../src/engine/command.ts');
  const wasm = new WasmBridge();
  wasm.loadDocument(await readFile(new URL('../../samples/biz_plan.hwp', import.meta.url)));
  try {
    const length = wasm.getCellParagraphLength(0, 2, 0, 0, 0);
    wasm.deleteTextInCell(0, 2, 0, 0, 0, 0, length);
    wasm.insertTextInCell(0, 2, 0, 0, 0, 0, 'BASE');
    const cursor = new CursorState(wasm);
    const pos = { sectionIndex: 0, paragraphIndex: 2, parentParaIndex: 2, controlIndex: 0, cellIndex: 0, cellParaIndex: 0, charOffset: 4 };
    cursor.moveTo(pos);
    wasm.setLivePastePolicy({ epoch: 'native-history', writableRegionIds: ['c:0:2:0:0'] });
    wasm.restrictLiveTableStructure(true);
    const input = Object.create(InputHandler.prototype) as any;
    let afterEdits = 0;
    Object.assign(input, { wasm, cursor, history: new CommandHistory(), getSelectedCellBlock: () => null,
      getBodyStructureInput: () => ({ position: cursor.getPosition(), selection: null }),
      updateSelection() {}, updateCaret() { input.syncLiveHistoryScope(); },
      flushDeferredPaginationIfNeeded() {}, prepareTextMutationBeforeCursor() {},
      clearTableResizeRuntimeCache() {}, resetDerivedStateAfterHistoryJump() {},
      restoreEditContextAfterHistory(_command: unknown, next: typeof pos) { cursor.moveTo(next); },
      afterEdit() { afterEdits++; } });
    input.syncLiveHistoryScope();
    const text = () => wasm.getTextInCell(0, 2, 0, 0, 0, 0, wasm.getCellParagraphLength(0, 2, 0, 0, 0));
    const local = (value: string) => {
      const before = cursor.getPosition();
      const next = input.history.execute(new SnapshotCommand('native-history-text', before, before, (bridge: InstanceType<typeof WasmBridge>) => {
        bridge.insertTextInCell(0, 2, 0, 0, 0, before.charOffset, value);
        return { ...before, charOffset: before.charOffset + value.length };
      }), wasm);
      cursor.moveTo(next);
    };
    local('LOCAL1'); const first = text(); assert.equal(first, 'BASELOCAL1');
    wasm.insertTextInCell(0, 2, 0, 0, 0, 0, 'REMOTE');
    input.applyRemoteTextChange({ nativeAddress: 'c:0:2:0:0', before: first, ops: [{ type: 'insert', offset: 0, text: 'REMOTE' }] });
    assert.equal(input.canUndo(), false);
    local('LOCAL2'); const second = text(); assert.equal(second, 'REMOTEBASELOCAL1LOCAL2');
    assert.equal(input.canUndo(), true); input.performUndo();
    assert.equal(text(), 'REMOTEBASELOCAL1'); assert.equal(afterEdits, 1);
    const evidence = new URL('../../../../.omo/evidence/table-shortcuts-20261009/native-history-remote-preserved.json', import.meta.url);
    const { mkdir } = await import('node:fs/promises'); await mkdir(new URL('.', evidence), { recursive: true });
    await writeFile(evidence, JSON.stringify({ first, remote: 'REMOTE', beforeUndo: second, afterUndo: text(), afterEditEmissions: afterEdits }, null, 2));
  } finally { wasm.releaseDocument(); }
});

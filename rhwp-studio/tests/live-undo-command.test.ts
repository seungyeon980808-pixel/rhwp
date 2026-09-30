import test from 'node:test';
import assert from 'node:assert/strict';
import { registerHooks, stripTypeScriptTypes } from 'node:module';
import type { EditorContext, CommandServices } from '../src/command/types.ts';

const srcRoot = new URL('../src/', import.meta.url);
registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === '@wasm/rhwp.js') return nextResolve(new URL('../../pkg/rhwp.js', import.meta.url).href, context);
    if (specifier.startsWith('@/')) return nextResolve(new URL(`${specifier.slice(2)}.ts`, srcRoot).href, context);
    if (/^\.{1,2}\//.test(specifier) && !/\.[a-z]+$/.test(specifier)) return nextResolve(`${specifier}.ts`, context);
    return nextResolve(specifier, context);
  },
  load(url, context, nextLoad) {
    const result = nextLoad(url, context);
    if (!url.endsWith('.ts') || result.source === undefined || result.source === null) return result;
    return { ...result, format: 'module', source: stripTypeScriptTypes(String(result.source), { mode: 'transform' }) };
  },
});

const { editCommands } = await import('../src/command/commands/edit.ts');
const { EventBus } = await import('../src/core/event-bus.ts');
const { DocumentDirtyState } = await import('../src/core/document-dirty-state.ts');
const { WasmBridge } = await import('../src/core/wasm-bridge.ts');
const { CommandDispatcher } = await import('../src/command/dispatcher.ts');
const { CommandRegistry } = await import('../src/command/registry.ts');

function context(isLiveCollaboration: boolean): EditorContext {
  return {
    hasDocument: true, hasSelection: false, hasCopiedFormat: false, inTable: false,
    inCellSelectionMode: false, hasMultiCellSelection: false, hasTableTransposeClipboard: false,
    inTableObjectSelection: false, inPictureObjectSelection: false, inField: false,
    isEditable: true, editMode: 'normal', isFormMode: false, canEditFormField: false,
    canUndo: true, canRedo: true, zoom: 1, showControlCodes: false,
    showParagraphMarks: false, isDirty: true, isLiveCollaboration,
  };
}

function services(isLiveCollaboration: boolean) {
  const executed: string[] = [];
  const eventBus = new EventBus();
  const value: CommandServices = {
    eventBus, wasm: new WasmBridge(), documentState: new DocumentDirtyState(eventBus),
    getContext: () => context(isLiveCollaboration),
    getInputHandler: () => { executed.push('input-handler'); return null; },
    getViewportManager: () => null, gotoPage: () => false, setEditMode: () => {},
  };
  return { value, executed };
}

for (const id of ['edit:undo', 'edit:redo']) {
  const command = editCommands.find((item) => item.id === id);
  assert.ok(command);

  test(`${id} remains available in an ordinary document with history`, () => {
    assert.equal(command.canExecute?.(context(false)), true);
  });

  test(`${id} is unavailable in live collaboration even with native history`, () => {
    assert.equal(command.canExecute?.(context(true)), false);
  });

  test(`${id} stays unavailable without a document`, () => {
    assert.equal(command.canExecute?.({ ...context(false), hasDocument: false }), false);
  });

  test(`${id} stays unavailable with empty native history`, () => {
    assert.equal(command.canExecute?.({ ...context(false), canUndo: false, canRedo: false }), false);
  });

  test(`${id} supports ordinary legacy contexts without a live-mode field`, () => {
    const { isLiveCollaboration, ...ordinary } = context(false);
    assert.equal(command.canExecute?.(ordinary), true);
  });

  test(`${id} rejects direct execution in live collaboration`, () => {
    const fixture = services(true);
    command.execute(fixture.value);
    assert.deepEqual(fixture.executed, []);
  });

  test(`${id} returns rejected through the live dispatcher`, () => {
    const fixture = services(true);
    const registry = new CommandRegistry();
    registry.register(command);
    const dispatcher = new CommandDispatcher(registry, fixture.value, fixture.value.eventBus);
    assert.equal(dispatcher.dispatch(id), false);
    assert.deepEqual(fixture.executed, []);
  });
}

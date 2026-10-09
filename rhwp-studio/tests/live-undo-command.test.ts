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

function services(isLiveCollaboration: boolean, allowed = true, includeGuard = true) {
  const executed: string[] = [];
  const eventBus = new EventBus();
  const current = context(isLiveCollaboration);
  let guardAllowed = allowed;
  const input = {
    ...(includeGuard ? { canUndo: () => guardAllowed, canRedo: () => guardAllowed } : {}),
    performUndo() { executed.push('undo'); }, performRedo() { executed.push('redo'); },
  };
  const value: CommandServices = {
    eventBus, wasm: new WasmBridge(), documentState: new DocumentDirtyState(eventBus),
    getContext: () => current,
    getInputHandler: () => input as unknown as ReturnType<CommandServices['getInputHandler']>,
    getViewportManager: () => null, gotoPage: () => false, setEditMode: () => {},
  };
  return { value, executed, current, reject() { guardAllowed = false; } };
}

for (const id of ['edit:undo', 'edit:redo']) {
  const command = editCommands.find((item) => item.id === id)!;
  const action = id.slice(5);

  test(`${id} remains available in ordinary and guarded live documents with history`, () => {
    assert.equal(command.canExecute?.(context(false)), true);
    assert.equal(command.canExecute?.(context(true)), true);
  });

  test(`${id} stays unavailable without a document or guarded native history`, () => {
    assert.equal(command.canExecute?.({ ...context(true), hasDocument: false }), false);
    assert.equal(command.canExecute?.({ ...context(true), canUndo: false, canRedo: false }), false);
  });

  test(`${id} supports ordinary legacy contexts without a live-mode field`, () => {
    const { isLiveCollaboration, ...ordinary } = context(false);
    assert.equal(command.canExecute?.(ordinary), true);
  });

  test(`${id} directly executes live history only while the fresh handler guard permits it`, () => {
    const fixture = services(true);
    command.execute(fixture.value);
    assert.deepEqual(fixture.executed, [action]);
    fixture.reject(); // Context may still advertise old availability after a remote edit/lock.
    command.execute(fixture.value);
    assert.deepEqual(fixture.executed, [action]);
  });

  test(`${id} fails closed if a handler does not expose the native history guard`, () => {
    const fixture = services(true, true, false);
    command.execute(fixture.value);
    assert.deepEqual(fixture.executed, []);
  });

  test(`${id} dispatches guarded live history and rejects false availability`, () => {
    const fixture = services(true);
    const registry = new CommandRegistry(); registry.register(command);
    const dispatcher = new CommandDispatcher(registry, fixture.value, fixture.value.eventBus);
    assert.equal(dispatcher.dispatch(id), true);
    assert.deepEqual(fixture.executed, [action]);
    fixture.current.canUndo = false; fixture.current.canRedo = false;
    assert.equal(dispatcher.dispatch(id), false);
    assert.deepEqual(fixture.executed, [action]);
  });
}

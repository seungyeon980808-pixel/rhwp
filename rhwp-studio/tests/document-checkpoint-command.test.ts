import test from 'node:test';
import assert from 'node:assert/strict';
import './helpers/live-native-loader.ts';
import type { CommandServices, EditorContext } from '../src/command/types.ts';
import type { CommandRegistry } from '../src/command/registry.ts';
import type { EventBus } from '../src/core/event-bus.ts';
import { requiresDocumentCheckpoint } from '../src/embed/document-checkpoint-command.ts';
const { CommandDispatcher } = await import('../src/command/dispatcher.ts');

test('rich formatting and document resources use checkpoints; replayable formatting stays live', () => {
  for (const id of ['format:char-shape', 'format:para-shape', 'format:toggle-numbering', 'format:toggle-bullet', 'edit:format-paste', 'insert:equation', 'page:break', 'file:page-setup', 'table:cell-props'])
    assert.equal(requiresDocumentCheckpoint(id), true, id);
  for (const id of ['format:bold', 'format:superscript', 'format:normal', 'format:indent', 'format:line-spacing-increase', 'format:align-left', 'edit:undo', 'edit:find', 'file:save', 'table:transpose-copy'])
    assert.equal(requiresDocumentCheckpoint(id), false, id);
});

test('host commands execute only after a checkpoint grant, while a guest cannot bypass that grant', () => {
  const executed: string[] = [], requests: string[] = [];
  let context = { hasDocument: true, isLiveCollaboration: true, canRequestDocumentEdit: true } as EditorContext;
  const registry = { get: (id: string) => ({ execute: () => executed.push(id) }) } as unknown as CommandRegistry;
  const services = { getContext: () => context, requestDocumentEdit: (id: string) => requests.push(id), getInputHandler: () => ({ canEditLiveSelection: () => true }) } as unknown as CommandServices;
  const dispatcher = new CommandDispatcher(registry, services, { emit: () => {} } as unknown as EventBus);
  assert.equal(dispatcher.dispatch('format:char-shape'), false);
  assert.deepEqual(requests, ['format:char-shape']); assert.deepEqual(executed, []);
  assert.equal(dispatcher.dispatch('format:bold'), true);
  context = { ...context, isLiveCollaboration: false };
  assert.equal(dispatcher.resumePendingDocumentCommand('format:char-shape'), true);
  assert.deepEqual(executed, ['format:bold', 'format:char-shape']);
  context = { ...context, isLiveCollaboration: true, canRequestDocumentEdit: false };
  assert.equal(dispatcher.dispatch('format:toggle-bullet'), false);
  assert.match(dispatcher.disabledReason('format:toggle-bullet') ?? '', /문서 소유자/);
  assert.equal(dispatcher.dispatch('format:superscript'), true);
});

test('Alt+C applying copied format follows paste checkpoint permissions and resumes exact paste command', () => {
  const executed: string[] = [], requests: string[] = [];
  let context = { hasDocument: true, hasCopiedFormat: true, hasSelection: true, inCellSelectionMode: false, isLiveCollaboration: true, canRequestDocumentEdit: true } as EditorContext;
  const registry = { get: (id: string) => ({ execute: () => executed.push(id) }) } as unknown as CommandRegistry;
  const services = { getContext: () => context, requestDocumentEdit: (id: string) => requests.push(id) } as unknown as CommandServices;
  const dispatcher = new CommandDispatcher(registry, services, { emit: () => {} } as unknown as EventBus);
  assert.equal(dispatcher.isEnabled('edit:format-copy'), true);
  assert.equal(dispatcher.dispatch('edit:format-copy'), false);
  assert.deepEqual(requests, ['edit:format-paste']); assert.deepEqual(executed, []);
  context = { ...context, isLiveCollaboration: false };
  assert.equal(dispatcher.resumePendingDocumentCommand('edit:format-paste'), true);
  assert.deepEqual(executed, ['edit:format-paste']);
  context = { ...context, isLiveCollaboration: true, canRequestDocumentEdit: false };
  for (const target of [{ hasSelection: true, inCellSelectionMode: false }, { hasSelection: false, inCellSelectionMode: true }]) {
    context = { ...context, ...target };
    assert.equal(dispatcher.isEnabled('edit:format-copy'), false);
    assert.match(dispatcher.disabledReason('edit:format-copy') ?? '', /문서 소유자/);
    assert.equal(dispatcher.dispatch('edit:format-copy'), false);
  }
  assert.deepEqual(requests, ['edit:format-paste']);
  context = { ...context, hasCopiedFormat: false };
  assert.equal(dispatcher.dispatch('edit:format-copy'), true, 'initial copy remains available to guest');
  context = { ...context, hasCopiedFormat: true, hasSelection: false, inCellSelectionMode: false };
  assert.equal(dispatcher.dispatch('edit:format-copy'), true, 'caret copies fresh style instead of applying it');
  assert.deepEqual(executed, ['edit:format-paste', 'edit:format-copy', 'edit:format-copy']);
});

test('direct format-copy command cannot apply rich resources while live, but still copies at a caret', async () => {
  const { editCommands } = await import('../src/command/commands/edit.ts');
  const command = editCommands.find(def => def.id === 'edit:format-copy'); assert.ok(command);
  let context = { hasDocument: true, hasCopiedFormat: true, hasSelection: true, inCellSelectionMode: false, isLiveCollaboration: true } as EditorContext;
  let copied = 0, blocked = 0;
  const services = { getContext: () => context, eventBus: { emit: (name: string) => { if (name === 'command-blocked') blocked++; } },
    getInputHandler: () => ({ performFormatCopy: () => copied++ }) } as unknown as CommandServices;
  command.execute(services); assert.equal(copied, 0); assert.equal(blocked, 1);
  context = { ...context, hasSelection: false }; command.execute(services); assert.equal(copied, 1);
  context = { ...context, hasSelection: true, isLiveCollaboration: false }; command.execute(services); assert.equal(copied, 2);
});

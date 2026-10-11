import './helpers/live-native-loader.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import type { CommandServices, EditorContext } from '../src/command/types.ts';
import type { CommandRegistry } from '../src/command/registry.ts';
import type { EventBus } from '../src/core/event-bus.ts';
const { WasmBridge } = await import('../src/core/wasm-bridge.ts');
const { CommandDispatcher } = await import('../src/command/dispatcher.ts');
const { applyFontFamily } = await import('../src/command/font-family-command.ts');
const fixture = await readFile(new URL('../../samples/biz_plan.hwp', import.meta.url));

for (const cell of [false, true]) test(`font changes wait for a host grant and survive HWP/HWPX reopening (${cell ? 'cell' : 'body'})`, () => {
  const wasm = new WasmBridge(); wasm.loadDocument(fixture);
  let ctx = { hasDocument: true, isLiveCollaboration: true, canRequestDocumentEdit: true } as EditorContext;
  const requests: string[] = []; let applications = 0;
  const props = () => cell ? wasm.getCellCharPropertiesAt(0, 2, 0, 0, 0, 0) : wasm.getCharPropertiesAt(0, 14, 0);
  const before = props();
  const originalFont = before.fontFamilies ?? Array(7).fill(before.fontFamily);
  const services = { wasm, getContext: () => ctx, eventBus: { emit: (name: string, marks: object) => {
    if (name !== 'format-char') return;
    applications++;
    if (cell) wasm.applyCharFormatInCell(0, 2, 0, 0, 0, 0, 2, JSON.stringify(marks));
    else wasm.applyCharFormat(0, 14, 0, 2, JSON.stringify(marks));
  } }, requestDocumentEdit: (command: string) => requests.push(command) } as unknown as CommandServices;
  const registry = { get: (id: string) => id === 'format:font-family' ? { execute: applyFontFamily } : undefined } as unknown as CommandRegistry;
  const dispatcher = new CommandDispatcher(registry, services, { emit: () => {} } as unknown as EventBus);
  try {
    assert.equal(dispatcher.dispatch('format:font-family', { fontName: '돋움', language: 0, currentFontFamilies: originalFont }), false);
    assert.deepEqual(requests, ['format:font-family']); assert.equal(applications, 0);
    assert.deepEqual(props(), before, 'no font IDs or formatting are changed before the grant');
    ctx = { ...ctx, isLiveCollaboration: false };
    assert.equal(dispatcher.resumePendingDocumentCommand('format:font-family'), true);
    assert.equal(applications, 1); assert.equal(props().fontFamilies?.[0], '돋움');
    assert.deepEqual(props().fontFamilies?.slice(1), originalFont.slice(1));
    for (const format of ['hwp', 'hwpx'] as const) {
      const restored = new WasmBridge();
      try {
        restored.loadDocument(format === 'hwp' ? wasm.exportHwp() : wasm.exportHwpx());
        const saved = cell ? restored.getCellCharPropertiesAt(0, 2, 0, 0, 0, 0) : restored.getCharPropertiesAt(0, 14, 0);
        assert.deepEqual(saved.fontFamilies, props().fontFamilies, `${format} preserves per-language fonts`);
      } finally { restored.releaseDocument(); }
    }
    ctx = { ...ctx, isLiveCollaboration: true, canRequestDocumentEdit: false };
    assert.equal(dispatcher.dispatch('format:font-family', { fontName: '궁서' }), false);
    assert.equal(applications, 1);
    assert.deepEqual(requests, ['format:font-family']);
  } finally { wasm.releaseDocument(); }
});

test('font parameters are validated before creating document resources', () => {
  let changed = false;
  const services = { wasm: { findOrCreateFontId: () => { changed = true; return 0; },
    findOrCreateFontIdForLang: () => { changed = true; return 0; } }, eventBus: { emit: () => { changed = true; } } } as unknown as CommandServices;
  for (const params of [{ fontName: '' }, { fontName: '바탕', language: 7 }, { fontFamilies: ['바탕'] },
    { fontName: '바탕', language: 0, currentFontFamilies: [] }]) assert.throws(() => applyFontFamily(services, params));
  assert.equal(changed, false);
});

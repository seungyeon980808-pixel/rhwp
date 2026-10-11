import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { installLiveFormatBoundary } from '../src/embed/collaboration-format-boundary.ts';

test('font and style controls follow host permissions and freezing without losing their original state', () => {
  const dom = new JSDOM('<select id="font-name" title="글꼴"></select><select id="style-name"></select><select id="font-lang"></select><button id="btn-charfx"></button><button data-cmd="format:char-shape" disabled title="기존 제한"></button>');
  Object.defineProperty(globalThis, 'Element', { configurable: true, value: dom.window.Element });
  const doc = dom.window.document;
  const font = doc.querySelector<HTMLSelectElement>('#font-name')!;
  let changed = 0; font.addEventListener('change', () => changed++);
  const refresh = installLiveFormatBoundary(doc);
  const change = () => font.dispatchEvent(new dom.window.Event('change', { bubbles: true, cancelable: true }));
  assert.equal(font.disabled, true); change(); assert.equal(changed, 0);
  refresh({ canRequest: true });
  assert.equal(font.disabled, false); assert.equal(font.title, '글꼴');
  assert.equal(font.hasAttribute('aria-disabled'), false);
  change(); assert.equal(changed, 1);
  assert.equal(doc.querySelector<HTMLButtonElement>('[data-cmd]')!.disabled, true, 'unrelated pre-existing restrictions stay intact');
  refresh({ canRequest: true, frozen: true }); change();
  assert.equal(font.disabled, true); assert.equal(changed, 1);
  refresh({ canRequest: true, frozen: false }); change(); assert.equal(changed, 2);
  refresh({ canRequest: false }); change(); assert.equal(changed, 2);
  assert.equal(doc.querySelector<HTMLSelectElement>('#style-name')!.disabled, true);
  dom.window.close();
});

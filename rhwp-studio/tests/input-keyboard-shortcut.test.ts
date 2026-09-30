import test from 'node:test';
import assert from 'node:assert/strict';
import { registerHooks, stripTypeScriptTypes } from 'node:module';

const srcRoot = new URL('../src/', import.meta.url);
registerHooks({
  resolve(specifier, context, nextResolve) {
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
const { onKeyDown, handleCtrlKey } = await import('../src/engine/input-handler-keyboard.ts');

function keyEvent(key: string, options: { code?: string; ctrlKey?: boolean; metaKey?: boolean; shiftKey?: boolean; isComposing?: boolean } = {}): KeyboardEvent {
  return Object.assign(new Event('keydown', { cancelable: true }), {
    key, code: options.code ?? 'KeyP',
    ctrlKey: options.ctrlKey ?? false, isComposing: options.isComposing ?? false,
    altKey: false, shiftKey: options.shiftKey ?? false, metaKey: options.metaKey ?? false, repeat: false,
    keyCode: 0, charCode: 0, which: 0, location: 0, detail: 0, view: null,
    DOM_KEY_LOCATION_STANDARD: 0 as const, DOM_KEY_LOCATION_LEFT: 1 as const,
    DOM_KEY_LOCATION_RIGHT: 2 as const, DOM_KEY_LOCATION_NUMPAD: 3 as const,
    getModifierState: (modifier: string) => modifier === 'Control' && options.ctrlKey === true,
    initKeyboardEvent: () => { throw new Error('Legacy event initialization is not used'); },
    initUIEvent: () => { throw new Error('Legacy event initialization is not used'); },
  });
}

function handler(accepted: boolean, picture = false) {
  const dispatched: string[] = [];
  return {
    active: true,
    cursor: {
      isInHeaderFooter: () => false,
      isInFootnote: () => false,
      isInPictureObjectSelection: () => picture,
      isInTableObjectSelection: () => false,
      isInBlockSelectionMode: () => false,
      isInCellSelectionMode: () => false,
      isInCell: () => false,
      getPosition: () => ({ sectionIndex: 0, paragraphIndex: 0, charOffset: 0 }),
    },
    dispatcher: {
      isEnabled: () => accepted,
      dispatch(id: string) { dispatched.push(id); return accepted; },
    },
    handleCtrlKey,
    dispatched,
  };
}

for (const key of ['p', 'ㅔ']) {
  test(`ordinary ${key} remains available to native input when object properties is unavailable`, () => {
    const editor = handler(false);
    const event = keyEvent(key);
    onKeyDown.call(editor, event);
    assert.equal(event.defaultPrevented, false, `${key} must reach native text input`);
  });

  test(`${key} opens object properties and consumes input when a picture is selected`, () => {
    const editor = handler(true, true);
    const event = keyEvent(key);
    onKeyDown.call(editor, event);
    assert.equal(event.defaultPrevented, true);
    assert.deepEqual(editor.dispatched, ['format:object-properties']);
  });
}

test('an enabled function shortcut still consumes its keydown', () => {
  const editor = handler(true);
  const event = keyEvent('F7', { code: 'F7' });
  onKeyDown.call(editor, event);
  assert.equal(event.defaultPrevented, true);
  assert.deepEqual(editor.dispatched, ['file:page-setup']);
});

test('IME composition KeyP stays uncancelled without dispatching shortcuts', () => {
  const editor = handler(false);
  const event = keyEvent('Process', { isComposing: true });
  onKeyDown.call(editor, event);
  assert.equal(event.defaultPrevented, false);
  assert.deepEqual(editor.dispatched, []);
});

test('modified print shortcut remains consumed when its command is unavailable', () => {
  const editor = handler(false);
  const event = keyEvent('p', { ctrlKey: true });
  onKeyDown.call(editor, event);
  assert.equal(event.defaultPrevented, true);
  assert.deepEqual(editor.dispatched, ['file:print']);
});

for (const modifier of ['ctrlKey', 'metaKey']) {
  for (const shiftKey of [false, true]) {
    test(`unavailable history shortcut consumes ${modifier} Z (shift=${shiftKey})`, () => {
      const editor = handler(false);
      const event = keyEvent('z', { code: 'KeyZ', [modifier]: true, shiftKey });
      onKeyDown.call(editor, event);
      assert.equal(event.defaultPrevented, true);
      assert.deepEqual(editor.dispatched, [shiftKey ? 'edit:redo' : 'edit:undo']);
    });
  }
}

for (const key of ['z', 'ㅋ', 'Escape']) {
  test(`composition ${key} is not consumed by a disabled history command`, () => {
    const editor = handler(false);
    const event = keyEvent(key, { code: key === 'Escape' ? 'Escape' : 'KeyZ', ctrlKey: key !== 'Escape', isComposing: true });
    onKeyDown.call(editor, event);
    assert.equal(event.defaultPrevented, false);
    assert.deepEqual(editor.dispatched, []);
  });
}

for (const key of ['z', 'ㅋ']) {
  test(`ordinary ${key} remains available to text input when history is disabled`, () => {
    const editor = handler(false);
    const event = keyEvent(key, { code: 'KeyZ' });
    onKeyDown.call(editor, event);
    assert.equal(event.defaultPrevented, false);
    assert.deepEqual(editor.dispatched, []);
  });
}

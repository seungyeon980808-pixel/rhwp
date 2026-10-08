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
    isComposing: false,
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

function cells() {
  const editor = handler(true) as any;
  let phase = 0;
  let clears = 0;
  Object.assign(editor.cursor, {
    isInCell: () => true, isInTextBox: () => false,
    isInCellSelectionMode: () => phase > 0,
    enterCellSelectionMode: () => { phase = 1; return true; },
    getCellSelectionPhase: () => phase,
    advanceCellSelectionPhase: () => { phase = Math.min(3, phase + 1); },
    exitCellSelectionMode: () => { phase = 0; },
    moveCellSelection: () => {},
  });
  editor.caret = { hide() {} }; editor.selectionRenderer = { clear() {} };
  editor.cellSelectionRenderer = { clear() { clears += 1; } };
  editor.updateCellSelection = () => {}; editor.updateCaret = () => {};
  editor.flushDeferredPaginationIfNeeded = () => {};
  return { editor, phase: () => phase, clears: () => clears };
}

test('F5는 1→2→3으로 진행하고 누르고 있는 키의 반복 이벤트는 단계를 넘기지 않는다', () => {
  const { editor, phase } = cells();
  onKeyDown.call(editor, keyEvent('F5', { code: 'F5' }));
  assert.equal(phase(), 1);
  const repeated = Object.assign(keyEvent('F5', { code: 'F5' }), { repeat: true });
  onKeyDown.call(editor, repeated); assert.equal(phase(), 1);
  onKeyDown.call(editor, keyEvent('F5', { code: 'F5' })); assert.equal(phase(), 2);
  onKeyDown.call(editor, keyEvent('F5', { code: 'F5' })); assert.equal(phase(), 3);
});

test('Shift+F5는 범위 선택으로 바로 진입하고 Enter는 줄바꿈 없이 선택을 끝낸다', () => {
  const { editor, phase, clears } = cells();
  onKeyDown.call(editor, keyEvent('F5', { code: 'F5', shiftKey: true })); assert.equal(phase(), 2);
  const enter = keyEvent('Enter', { code: 'Enter' });
  onKeyDown.call(editor, enter);
  assert.equal(enter.defaultPrevented, true); assert.equal(phase(), 0); assert.equal(clears(), 1);
});

test('셀 선택의 한글 M/S는 문자를 입력하지 않고 명령으로 실행한다', () => {
  const { editor, phase } = cells();
  onKeyDown.call(editor, keyEvent('F5', { code: 'F5' }));
  for (const [key, code] of [['ㅡ', 'KeyM'], ['ㄴ', 'KeyS'], ['Process', 'KeyM']]) {
    const event = keyEvent(key, { code, isComposing: key === 'Process' });
    onKeyDown.call(editor, event); assert.equal(event.defaultPrevented, true); assert.equal(phase(), 1);
  }
  assert.deepEqual(editor.dispatched, ['table:cell-merge', 'table:cell-split', 'table:cell-merge']);
});

test('F5 셀 블록에서 서식 단축키를 실행해도 선택 범위가 해제되지 않는다', () => {
  const { editor, phase } = cells();
  onKeyDown.call(editor, keyEvent('F5', { code: 'F5' }));
  onKeyDown.call(editor, keyEvent('F5', { code: 'F5' }));
  onKeyDown.call(editor, keyEvent('ㅠ', { code: 'KeyB', ctrlKey: true }));
  assert.equal(phase(), 2); assert.deepEqual(editor.dispatched, ['format:bold']);
});

test('Safari 한글 입력기의 229 서식 키는 실제 조합 중이 아닐 때만 실행한다', () => {
  const { editor, phase } = cells();
  onKeyDown.call(editor, keyEvent('F5', { code: 'F5' }));
  for (const [key, code, shiftKey, command] of [
    ['ㅠ', 'KeyB', false, 'format:bold'], ['ㄱ', 'KeyR', true, 'format:align-right'],
  ] as const) {
    const event = Object.assign(keyEvent(key, { code, ctrlKey: true, shiftKey }), { keyCode: 229 });
    onKeyDown.call(editor, event);
    assert.equal(event.defaultPrevented, true); assert.equal(phase(), 1);
    assert.equal(editor.dispatched.at(-1), command);
  }
  editor.isComposing = true;
  const composing = Object.assign(keyEvent('Process', { code: 'KeyB', ctrlKey: true, isComposing: true }), { keyCode: 229 });
  onKeyDown.call(editor, composing);
  assert.equal(composing.defaultPrevented, false); assert.equal(editor.dispatched.length, 2);
});

test('Ctrl+N을 놓고 한글 M을 누르면 수식을 실행하고 Cmd+N은 브라우저에 남긴다', () => {
  const editor = handler(true) as any;
  onKeyDown.call(editor, keyEvent('ㅜ', { code: 'KeyN', ctrlKey: true }));
  onKeyDown.call(editor, keyEvent('Control', { code: 'ControlLeft', ctrlKey: true }));
  onKeyDown.call(editor, keyEvent('ㅡ', { code: 'KeyM' }));
  assert.deepEqual(editor.dispatched, ['insert:equation']);
  const newWindow = keyEvent('n', { code: 'KeyN', metaKey: true });
  onKeyDown.call(editor, newWindow); assert.equal(newWindow.defaultPrevented, false);
});

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

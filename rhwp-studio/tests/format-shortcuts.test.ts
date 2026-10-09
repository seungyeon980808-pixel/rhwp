import test from 'node:test';
import assert from 'node:assert/strict';
import { adjustFirstLineIndent, applyNormalCharacterStyle } from '../src/command/format-shortcuts.ts';
import type { CommandServices } from '../src/command/types';

test('보통 모양은 모든 장식만 지우고 글꼴·크기·색·장평·자간은 보존한다', () => {
  const original = { bold: true, superscript: true, shadowType: 2, fontSize: 1400, textColor: '#ff0000', ratios: [95], spacings: [2], fontId: 3 };
  let result: Record<string, unknown> = {};
  const services = { eventBus: { emit(name: string, props: Record<string, unknown>) {
    assert.equal(name, 'format-char'); result = { ...original, ...props };
  } } } as unknown as CommandServices;
  applyNormalCharacterStyle(services);
  assert.equal(result.bold, false);
  assert.equal(result.superscript, false);
  assert.equal(result.subscript, false);
  assert.equal(result.shadowType, 0);
  for (const prop of ['fontId', 'fontSize', 'textColor', 'ratios', 'spacings'] as const)
    assert.deepEqual(result[prop], original[prop]);
});

test('들여쓰기·내어쓰기는 px를 원시 단위로 변환하고 기존 범위 서식 경로를 사용한다', () => {
  const edits: number[] = [];
  let currentPx = 0, focused = 0;
  const services = { getInputHandler: () => ({
    getParaProperties: () => ({ indent: currentPx }),
    applyParaPropsAtCursor: (props: { indent: number }) => { edits.push(props.indent); currentPx = props.indent / 150; },
    focus: () => focused++,
  }) } as unknown as CommandServices;
  adjustFirstLineIndent(services, 1);
  adjustFirstLineIndent(services, 1);
  adjustFirstLineIndent(services, -1);
  adjustFirstLineIndent(services, -1);
  adjustFirstLineIndent(services, -1);
  assert.deepEqual(edits, [2000, 4000, 2000, 0, -2000]);
  assert.equal(focused, 5);
});

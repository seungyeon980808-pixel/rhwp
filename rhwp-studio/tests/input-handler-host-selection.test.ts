import test from 'node:test';
import assert from 'node:assert/strict';

import {
  readHostSelection,
  replaceHostSelection,
} from '../src/embed/host-selection-adapter.ts';
import type { DocumentPosition } from '../src/core/types.ts';

const START: DocumentPosition = {
  sectionIndex: 0,
  paragraphIndex: 2,
  charOffset: 1,
};

const END: DocumentPosition = {
  sectionIndex: 0,
  paragraphIndex: 2,
  charOffset: 6,
};

const CELL_START: DocumentPosition = {
  sectionIndex: 0,
  paragraphIndex: 0,
  charOffset: 2,
  parentParaIndex: 4,
  controlIndex: 1,
  cellIndex: 3,
  cellParaIndex: 0,
  cellPath: [{ controlIndex: 1, cellIndex: 3, cellParaIndex: 0 }],
};

const CELL_END: DocumentPosition = {
  ...CELL_START,
  charOffset: 5,
};

test('InputHandler는 본문 선택을 시스템 클립보드 없이 호스트용 텍스트로 읽는다', () => {
  // Given: 한 문단의 텍스트 범위가 선택되어 있다.
  const calls: number[][] = [];
  const wasm = {
    copySelection(...args: number[]) {
      calls.push(args);
    },
    getClipboardText: () => '선택문',
  };

  // When: 호스트용 선택 내용을 읽는다.
  const selection = readHostSelection(wasm, START, END);

  // Then: 본문 범위와 안정적인 위치 서명이 반환된다.
  assert.deepEqual(calls, [[0, 2, 1, 2, 6]]);
  assert.deepEqual(selection, {
    text: '선택문',
    signature: 'body:0:2:1|body:0:2:6',
    scope: 'body',
  });
});

test('InputHandler는 선택 교체를 단일 snapshot 연산으로 실행한다', () => {
  // Given: 한 문단의 텍스트 범위가 선택되어 있다.
  const mutations: string[] = [];
  const wasm = {
    deleteRange: () => {
      mutations.push('delete');
      return { ok: true, paraIdx: 2, charOffset: 1 };
    },
    replaceBodyTextLocal: (_sec: number, _para: number, _offset: number, _count: number, text: string) => {
      mutations.push(`insert:${text}`);
      return {
        documentPaginationPending: false,
        flowChanged: false,
      };
    },
  };
  // When: 호스트가 선택 텍스트를 교체한다.
  const cursor = replaceHostSelection(wasm, START, END, '바꾼문');

  // Then: 삭제와 삽입이 순서대로 실행되고 새 커서가 반환된다.
  assert.deepEqual(cursor, { ...START, charOffset: 4 });
  assert.deepEqual(mutations, ['delete', 'insert:바꾼문']);
});

test('InputHandler는 단일 표 셀 선택을 호스트용 텍스트로 읽는다', () => {
  // Given: 한 표 셀 안의 텍스트 범위가 선택되어 있다.
  const calls: unknown[][] = [];
  const wasm = {
    copySelectionInCellByPath(...args: unknown[]) {
      calls.push(args);
    },
    getClipboardText: () => '셀 선택문',
  };

  // When: 호스트용 선택 내용을 읽는다.
  const selection = readHostSelection(wasm, CELL_START, CELL_END);

  // Then: cellPath 기반 API와 셀 위치 서명이 사용된다.
  assert.deepEqual(calls, [[0, 4, '[{"controlIndex":1,"cellIndex":3,"cellParaIndex":0}]', 0, 2, 0, 5]]);
  assert.deepEqual(selection, {
    text: '셀 선택문',
    signature: 'cell:0:4:1.3.0:2|cell:0:4:1.3.0:5',
    scope: 'cell',
  });
});

test('InputHandler는 단일 표 셀 선택을 경로 기반 snapshot 연산으로 교체한다', () => {
  // Given: 한 표 셀 안의 텍스트 범위가 선택되어 있다.
  const mutations: string[] = [];
  const wasm = {
    deleteRangeInCellByPath() {
      mutations.push('delete-cell');
      return JSON.stringify({ ok: true, paraIdx: 0, charOffset: 2 });
    },
    insertTextInCellByPath(
      _sectionIndex: number,
      _parentParagraphIndex: number,
      _pathJson: string,
      _charOffset: number,
      text: string,
    ) {
      mutations.push(`insert-cell:${text}`);
      return JSON.stringify({ ok: true });
    },
  };

  // When: 호스트가 셀 선택 텍스트를 교체한다.
  const cursor = replaceHostSelection(wasm, CELL_START, CELL_END, '새 셀문');

  // Then: 같은 셀 경로에서 삭제와 삽입이 순서대로 실행된다.
  assert.deepEqual(cursor, { ...CELL_START, charOffset: 6 });
  assert.deepEqual(mutations, ['delete-cell', 'insert-cell:새 셀문']);
});

test('InputHandler는 여러 본문 문단에 걸친 호스트 선택을 복사 전에 차단한다', () => {
  let copied = false;
  const wasm = {
    copySelection() {
      copied = true;
    },
    getClipboardText: () => '복합 선택',
  };

  const selection = readHostSelection(wasm, START, { ...END, paragraphIndex: 3 });

  assert.equal(selection, null);
  assert.equal(copied, false);
});

test('InputHandler는 한 셀 안에서도 여러 셀 문단에 걸친 선택을 차단한다', () => {
  let copied = false;
  const wasm = {
    copySelectionInCellByPath() {
      copied = true;
    },
    getClipboardText: () => '여러 셀 문단',
  };
  const end = {
    ...CELL_END,
    paragraphIndex: 1,
    cellParaIndex: 1,
    cellPath: [{ controlIndex: 1, cellIndex: 3, cellParaIndex: 1 }],
  } satisfies DocumentPosition;

  const selection = readHostSelection(wasm, CELL_START, end);

  assert.equal(selection, null);
  assert.equal(copied, false);
});

test('InputHandler는 그림·도형 대체 문자가 포함된 선택을 차단한다', () => {
  const wasm = {
    copySelection() {},
    getClipboardText: () => `앞${String.fromCodePoint(0xfffc)}뒤`,
  };

  assert.equal(readHostSelection(wasm, START, END), null);
});

test('InputHandler는 탭·줄바꿈·DEL이 포함된 원문 선택을 차단한다', () => {
  for (const text of ['앞\t뒤', '앞\n뒤', `앞${String.fromCodePoint(0x7f)}뒤`]) {
    const wasm = {
      copySelection() {},
      getClipboardText: () => text,
    };

    assert.equal(readHostSelection(wasm, START, END), null);
  }
});

test('InputHandler는 개체 대체 문자나 제어 문자를 치환문으로 삽입하지 않는다', () => {
  const mutations: string[] = [];
  const wasm = {
    deleteRange: () => {
      mutations.push('delete');
      return { ok: true, paraIdx: 2, charOffset: 1 };
    },
    replaceBodyTextLocal: () => {
      mutations.push('insert');
      return { documentPaginationPending: false, flowChanged: false };
    },
  };

  assert.equal(replaceHostSelection(wasm, START, END, `앞${String.fromCodePoint(0xfffc)}뒤`), null);
  assert.equal(replaceHostSelection(wasm, START, END, `앞${String.fromCodePoint(0x7f)}뒤`), null);
  assert.equal(replaceHostSelection(wasm, START, END, '앞\n뒤'), null);
  assert.deepEqual(mutations, []);
});

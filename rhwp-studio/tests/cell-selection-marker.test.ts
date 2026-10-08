import test from 'node:test';
import assert from 'node:assert/strict';
import { registerHooks, stripTypeScriptTypes } from 'node:module';
import type { CellBbox } from '../src/core/types.ts';

registerHooks({ load(url, context, nextLoad) {
  const result = nextLoad(url, context);
  return url.endsWith('.ts') && result.source != null
    ? { ...result, format: 'module', source: stripTypeScriptTypes(String(result.source), { mode: 'transform' }) } : result;
} });
const { CellSelectionRenderer } = await import('../src/engine/cell-selection-renderer.ts');

test('셀 중앙 표시가 확대·페이지 조각을 따라가고 단계 변경·해제 후 잔상이 남지 않는다', () => {
  class Element {
    children: Element[] = []; parentElement: Element | null = null;
    className = ''; style = { cssText: '' }; dataset: Record<string, string> = {}; clientWidth = 800;
    appendChild(child: Element) { this.children.push(child); child.parentElement = this; }
    remove() { if (this.parentElement) this.parentElement.children = this.parentElement.children.filter(child => child !== this); this.parentElement = null; }
    setAttribute() {}
  }
  const previous = Object.getOwnPropertyDescriptor(globalThis, 'document');
  Object.defineProperty(globalThis, 'document', { configurable: true, value: { createElement: () => new Element() } });
  try {
    const content = new Element();
    const container = { querySelector: () => content } as unknown as HTMLElement;
    const viewport = { getPageOffset: (page: number) => page * 1000, getPageWidth: () => 600 };
    const renderer = new CellSelectionRenderer(container, viewport as any);
    const cells = [
      { cellIdx: 0, row: 0, col: 0, rowSpan: 2, colSpan: 1, pageIndex: 0, x: 10, y: 20, w: 80, h: 100 },
      { cellIdx: 0, row: 0, col: 0, rowSpan: 2, colSpan: 1, pageIndex: 1, x: 10, y: 0, w: 80, h: 60 },
    ] as CellBbox[];
    const range = { startRow: 0, startCol: 0, endRow: 1, endCol: 0 };
    const layer = content.children[0];
    const marker = () => layer.children.filter(child => child.className === 'cell-selection-marker');
    renderer.render(cells, range, 1.25, undefined, { phase: 1, focus: { row: 1, col: 0 } });
    assert.equal(marker().length, 1); assert.equal(marker()[0].dataset.phase, '1');
    assert.match(marker()[0].style.cssText, /left:162.5px;top:1037.5px;/);
    renderer.render(cells, range, 1.5, undefined, { phase: 2, focus: { row: 1, col: 0 } });
    assert.equal(marker().length, 1); assert.equal(marker()[0].dataset.phase, '2');
    assert.match(marker()[0].style.cssText, /left:175px;top:1045px;/);
    renderer.render(cells, range, 1, undefined, { phase: 2, focus: { row: 1, col: 0 }, pageIndex: 0 });
    assert.equal(marker().length, 1);
    assert.match(marker()[0].style.cssText, /left:150px;top:70px;/);
    renderer.render(cells, range, 1, new Set(['0,0']), { phase: 2, focus: { row: 1, col: 0 } });
    assert.equal(layer.children.length, 0);
    renderer.render(cells, range, 1, undefined, { phase: 3, focus: { row: 1, col: 0 } });
    renderer.clear(); assert.equal(layer.children.length, 0);
    renderer.dispose(); assert.equal(content.children.length, 0);
  } finally {
    if (previous) Object.defineProperty(globalThis, 'document', previous);
    else Reflect.deleteProperty(globalThis, 'document');
  }
});

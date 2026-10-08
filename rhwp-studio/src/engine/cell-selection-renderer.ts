import type { CellBbox } from '@/core/types';
import type { VirtualScroll } from '@/view/virtual-scroll';

/** F5 셀 블록 선택 영역을 하이라이트 오버레이로 렌더링한다 */
export class CellSelectionRenderer {
  private layer: HTMLDivElement;
  private highlights: HTMLDivElement[] = [];

  constructor(
    private container: HTMLElement,
    private virtualScroll: VirtualScroll,
  ) {
    this.layer = document.createElement('div');
    this.layer.className = 'cell-selection-layer';
    this.layer.style.cssText = 'position:absolute;top:0;left:0;width:100%;height:100%;pointer-events:none;z-index:6;';
    const scrollContent = container.querySelector('#scroll-content');
    if (scrollContent) {
      scrollContent.appendChild(this.layer);
    }
  }

  /** 선택 범위 내 셀들을 하이라이트한다 */
  render(
    cellBboxes: CellBbox[],
    range: { startRow: number; startCol: number; endRow: number; endCol: number },
    zoom: number,
    excluded?: Set<string>,
    selection?: { phase: number; focus: { row: number; col: number } | null; pageIndex?: number },
  ): void {
    this.clear();
    this.ensureAttached();

    const scrollContent = this.container.querySelector('#scroll-content');
    const contentWidth = scrollContent?.clientWidth ?? 0;

    let markerCell: CellBbox | undefined;
    for (const cell of cellBboxes) {
      // 셀이 선택 범위에 포함되는지 확인 (병합 셀 고려)
      const cellEndRow = cell.row + cell.rowSpan - 1;
      const cellEndCol = cell.col + cell.colSpan - 1;
      const overlaps =
        cell.row <= range.endRow && cellEndRow >= range.startRow &&
        cell.col <= range.endCol && cellEndCol >= range.startCol;
      if (!overlaps) continue;

      // Ctrl+클릭으로 제외된 셀인지 확인
      if (excluded && excluded.has(`${cell.row},${cell.col}`)) continue;

      const div = document.createElement('div');
      const pageOffset = this.virtualScroll.getPageOffset(cell.pageIndex);
      const pageDisplayWidth = this.virtualScroll.getPageWidth(cell.pageIndex);
      const pageLeft = (contentWidth - pageDisplayWidth) / 2;

      div.className = 'cell-selection-highlight';
      div.style.cssText =
        `position:absolute;` +
        `left:${pageLeft + cell.x * zoom}px;` +
        `top:${pageOffset + cell.y * zoom}px;` +
        `width:${cell.w * zoom}px;` +
        `height:${cell.h * zoom}px;`;
      this.layer.appendChild(div);
      this.highlights.push(div);
      const focus = selection?.focus;
      if (focus && cell.row <= focus.row && cellEndRow >= focus.row
        && cell.col <= focus.col && cellEndCol >= focus.col) {
        // 페이지에 걸친 셀은 입력 커서가 있는 페이지의 조각을 우선한다.
        const preferred = cell.pageIndex === selection?.pageIndex;
        const previousPreferred = markerCell?.pageIndex === selection?.pageIndex;
        if (!markerCell || preferred && !previousPreferred
          || preferred === previousPreferred && (cell.pageIndex > markerCell.pageIndex
            || cell.pageIndex === markerCell.pageIndex && cell.y + cell.h > markerCell.y + markerCell.h)) {
          markerCell = cell;
        }
      }
    }
    if (markerCell && selection) {
      const marker = document.createElement('div');
      const pageLeft = (contentWidth - this.virtualScroll.getPageWidth(markerCell.pageIndex)) / 2;
      marker.className = 'cell-selection-marker';
      marker.dataset.phase = String(selection.phase);
      marker.setAttribute('aria-label', selection.phase === 1 ? '셀 선택' : '셀 범위 선택');
      marker.style.cssText = `position:absolute;left:${pageLeft + (markerCell.x + markerCell.w / 2) * zoom}px;` +
        `top:${this.virtualScroll.getPageOffset(markerCell.pageIndex) + (markerCell.y + markerCell.h / 2) * zoom}px;`;
      this.layer.appendChild(marker);
      this.highlights.push(marker);
    }
  }

  /** 모든 하이라이트를 제거한다 */
  clear(): void {
    for (const div of this.highlights) {
      div.remove();
    }
    this.highlights = [];
  }

  /** 레이어가 DOM에 없으면 재부착한다 */
  private ensureAttached(): void {
    if (this.layer.parentElement) return;
    const scrollContent = this.container.querySelector('#scroll-content');
    if (scrollContent) {
      scrollContent.appendChild(this.layer);
    }
  }

  dispose(): void {
    this.clear();
    this.layer.remove();
  }
}

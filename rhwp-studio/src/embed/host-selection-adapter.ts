import type { DocumentPosition } from '../core/types.ts';
import type { HostSelection } from './selection-bridge.ts';

export interface HostSelectionWasm {
  copySelection(
    sectionIndex: number,
    startParagraphIndex: number,
    startOffset: number,
    endParagraphIndex: number,
    endOffset: number,
  ): string;
  copySelectionInCellByPath(
    sectionIndex: number,
    parentParagraphIndex: number,
    pathJson: string,
    startCellParagraphIndex: number,
    startOffset: number,
    endCellParagraphIndex: number,
    endOffset: number,
  ): string;
  getClipboardText(): string;
  deleteRange(
    sectionIndex: number,
    startParagraphIndex: number,
    startOffset: number,
    endParagraphIndex: number,
    endOffset: number,
  ): { readonly ok: boolean; readonly paraIdx: number; readonly charOffset: number };
  deleteRangeInCellByPath(
    sectionIndex: number,
    parentParagraphIndex: number,
    pathJson: string,
    startCellParagraphIndex: number,
    startOffset: number,
    endCellParagraphIndex: number,
    endOffset: number,
  ): string;
  replaceBodyTextLocal(
    sectionIndex: number,
    paragraphIndex: number,
    charOffset: number,
    deleteCount: number,
    text: string,
  ): { readonly documentPaginationPending: boolean; readonly flowChanged: boolean };
  insertTextInCellByPath(
    sectionIndex: number,
    parentParagraphIndex: number,
    pathJson: string,
    charOffset: number,
    text: string,
  ): string;
}

export function readHostSelection(
  wasm: HostSelectionWasm,
  start: DocumentPosition,
  end: DocumentPosition,
): HostSelection | null {
  if (start.sectionIndex !== end.sectionIndex) return null;
  if (start.parentParaIndex !== undefined && end.parentParaIndex !== undefined) {
    const startPath = cellPathOf(start);
    const endPath = cellPathOf(end);
    if (
      start.parentParaIndex !== end.parentParaIndex
      || !startPath
      || !endPath
      || !isSameCellContainer(startPath, endPath)
      || cellParagraphIndex(startPath) !== cellParagraphIndex(endPath)
    ) {
      return null;
    }
    wasm.copySelectionInCellByPath(
      start.sectionIndex,
      start.parentParaIndex,
      JSON.stringify(startPath),
      cellParagraphIndex(startPath),
      start.charOffset,
      cellParagraphIndex(endPath),
      end.charOffset,
    );
    const text = wasm.getClipboardText();
    if (!isPlainTextSelection(text)) return null;
    return {
      text,
      signature: `${cellPositionKey(start, startPath)}|${cellPositionKey(end, endPath)}`,
      scope: 'cell',
    };
  }
  if (start.parentParaIndex !== undefined || end.parentParaIndex !== undefined) return null;
  if (start.paragraphIndex !== end.paragraphIndex) return null;
  wasm.copySelection(
    start.sectionIndex,
    start.paragraphIndex,
    start.charOffset,
    end.paragraphIndex,
    end.charOffset,
  );
  const text = wasm.getClipboardText();
  if (!isPlainTextSelection(text)) return null;
  return {
    text,
    signature: `${bodyPositionKey(start)}|${bodyPositionKey(end)}`,
    scope: 'body',
  };
}

export function replaceHostSelection(
  wasm: HostSelectionWasm,
  start: DocumentPosition,
  end: DocumentPosition,
  text: string,
): DocumentPosition | null {
  if (start.sectionIndex !== end.sectionIndex || !isPlainReplacementText(text)) return null;
  if (start.parentParaIndex !== undefined && end.parentParaIndex !== undefined) {
    const startPath = cellPathOf(start);
    const endPath = cellPathOf(end);
    if (
      start.parentParaIndex !== end.parentParaIndex
      || !startPath
      || !endPath
      || !isSameCellContainer(startPath, endPath)
      || cellParagraphIndex(startPath) !== cellParagraphIndex(endPath)
    ) {
      return null;
    }
    const deleted: unknown = JSON.parse(wasm.deleteRangeInCellByPath(
      start.sectionIndex,
      start.parentParaIndex,
      JSON.stringify(startPath),
      cellParagraphIndex(startPath),
      start.charOffset,
      cellParagraphIndex(endPath),
      end.charOffset,
    ));
    if (typeof deleted !== 'object' || deleted === null || Reflect.get(deleted, 'ok') !== true) {
      return null;
    }
    wasm.insertTextInCellByPath(
      start.sectionIndex,
      start.parentParaIndex,
      JSON.stringify(startPath),
      start.charOffset,
      text,
    );
    return { ...start, charOffset: start.charOffset + text.length };
  }
  if (start.parentParaIndex !== undefined || end.parentParaIndex !== undefined) return null;
  if (start.paragraphIndex !== end.paragraphIndex) return null;
  const deleted = wasm.deleteRange(
    start.sectionIndex,
    start.paragraphIndex,
    start.charOffset,
    end.paragraphIndex,
    end.charOffset,
  );
  if (!deleted.ok) return null;
  wasm.replaceBodyTextLocal(
    start.sectionIndex,
    start.paragraphIndex,
    start.charOffset,
    0,
    text,
  );
  return { ...start, charOffset: start.charOffset + text.length };
}

function bodyPositionKey(position: DocumentPosition): string {
  return `body:${position.sectionIndex}:${position.paragraphIndex}:${position.charOffset}`;
}

type CellPath = NonNullable<DocumentPosition['cellPath']>;

function cellPathOf(position: DocumentPosition): CellPath | null {
  if (position.cellPath && position.cellPath.length > 0) return position.cellPath;
  if (
    position.controlIndex === undefined
    || position.cellIndex === undefined
    || position.cellParaIndex === undefined
  ) {
    return null;
  }
  return [{
    controlIndex: position.controlIndex,
    cellIndex: position.cellIndex,
    cellParaIndex: position.cellParaIndex,
  }];
}

function cellParagraphIndex(path: CellPath): number {
  return path[path.length - 1].cellParaIndex;
}

function isSameCellContainer(left: CellPath, right: CellPath): boolean {
  if (left.length !== right.length) return false;
  return left.every((entry, index) => {
    const other = right[index];
    return entry.controlIndex === other.controlIndex
      && entry.cellIndex === other.cellIndex
      && (index + 1 === left.length || entry.cellParaIndex === other.cellParaIndex);
  });
}

function cellPositionKey(position: DocumentPosition, path: CellPath): string {
  const pathKey = path
    .map((entry) => `${entry.controlIndex}.${entry.cellIndex}.${entry.cellParaIndex}`)
    .join('/');
  return `cell:${position.sectionIndex}:${position.parentParaIndex}:${pathKey}:${position.charOffset}`;
}

function isPlainTextSelection(text: string): boolean {
  return !/[\u0000-\u001f\u007f\ufffc]/u.test(text);
}

function isPlainReplacementText(text: string): boolean {
  return !/[\u0000-\u001f\u007f\ufffc]/u.test(text);
}

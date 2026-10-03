import { structuredPosition, type StructuredCellReader } from './collaboration-structured-cell.ts';
import type { DocumentPosition } from '../core/types.ts';

export type CollaborationPresenceV1 = Readonly<{
  regionId: string;
  anchorOffset: number;
  focusOffset: number;
  anchorRegionId?: string;
  anchorCellParagraphIndex?: number;
  focusCellParagraphIndex?: number;
}>;

export class CollaborationPresenceError extends Error {
  readonly name = 'CollaborationPresenceError';
  readonly reason: 'text-box' | 'nested-cell' | 'incomplete-cell-address' | 'cursor-outside-selection';
  constructor(reason: CollaborationPresenceError['reason']) {
    super(`unsupported-presence:${reason}`);
    this.reason = reason;
  }
}

function regionId(position: DocumentPosition): string {
  if (position.isTextBox) throw new CollaborationPresenceError('text-box');
  if ((position.cellPath?.length ?? 0) > 1) throw new CollaborationPresenceError('nested-cell');
  if (position.parentParaIndex !== undefined) {
    if (position.controlIndex === undefined || position.cellIndex === undefined)
      throw new CollaborationPresenceError('incomplete-cell-address');
    return `c:${position.sectionIndex}:${position.parentParaIndex}:${position.controlIndex}:${position.cellIndex}`;
  }
  return `b:${position.sectionIndex}:${position.paragraphIndex}`;
}

export function readCollaborationPresence(input: Readonly<{
  getCursorPosition(): DocumentPosition;
  getSelection(): Readonly<{ start: DocumentPosition; end: DocumentPosition }> | null;
}>, wasm?: StructuredCellReader): CollaborationPresenceV1 | null {
  const cursor = input.getCursorPosition();
  const selection = input.getSelection();
  const structured = wasm && structuredPosition(wasm,cursor);
  if(structured) {
    const other=selection ? (JSON.stringify(selection.start)===JSON.stringify(cursor) ? selection.end : selection.start) : cursor;
    const anchor=structuredPosition(wasm!,other);
    if(!anchor||anchor.id!==structured.id) throw new CollaborationPresenceError('cursor-outside-selection');
    return {regionId:structured.id,anchorOffset:anchor.offset,focusOffset:structured.offset};
  }
  const id = regionId(cursor);
  const matchesCursor = (position: DocumentPosition) => regionId(position) === id
    && (position.cellParaIndex ?? 0) === (cursor.cellParaIndex ?? 0)
    && position.charOffset === cursor.charOffset;
  if (selection && !matchesCursor(selection.start) && !matchesCursor(selection.end))
    throw new CollaborationPresenceError('cursor-outside-selection');
  const anchor = selection ? (matchesCursor(selection.start) ? selection.end : selection.start) : cursor;
  const anchorId = regionId(anchor);
  return {
    regionId: id, anchorOffset: anchor.charOffset, focusOffset: cursor.charOffset,
    ...(anchorId !== id ? { anchorRegionId: anchorId } : {}),
    ...((anchor.cellParaIndex ?? 0) > 0 ? { anchorCellParagraphIndex: anchor.cellParaIndex } : {}),
    ...((cursor.cellParaIndex ?? 0) > 0 ? { focusCellParagraphIndex: cursor.cellParaIndex } : {}),
  };
}

import type { DocumentPosition } from '../core/types.ts';
import type { CollaborationOpV1 } from './collaboration-live-contract.ts';

export type CollaborationTextChange = Readonly<{
  nativeAddress: string;
  before: string;
  ops: readonly CollaborationOpV1[];
  /** Native-only remap, never serialized across collaboration transport. */
  remapPosition?: (position: DocumentPosition) => DocumentPosition;
}>;

export function remapCollaborationTextPosition(position: DocumentPosition, change: CollaborationTextChange): DocumentPosition {
  if (change.remapPosition) return change.remapPosition(position);
  if (position.isTextBox || (position.cellPath?.length ?? 0) > 1) return position;
  const cell = position.parentParaIndex !== undefined;
  const address = cell
    ? `c:${position.sectionIndex}:${position.parentParaIndex}:${position.controlIndex}:${position.cellIndex}`
    : `b:${position.sectionIndex}:${position.paragraphIndex}`;
  if (address !== change.nativeAddress) return position;
  const paragraphs = change.before.split('\n');
  const index = cell ? position.cellParaIndex ?? 0 : 0;
  const paragraph = paragraphs[index];
  if (paragraph === undefined) return position;
  let offset = paragraphs.slice(0, index).reduce((sum, text) => sum + text.length + 1, 0)
    + [...paragraph].slice(0, position.charOffset).join('').length;
  let text = change.before;
  for (const op of change.ops) {
    switch (op.type) {
      case 'insert':
        if (op.offset <= offset) offset += op.text.length;
        text = text.slice(0, op.offset) + op.text + text.slice(op.offset);
        break;
      case 'delete':
        if (op.offset < offset) offset -= Math.min(op.count, offset - op.offset);
        text = text.slice(0, op.offset) + text.slice(op.offset + op.count);
        break;
      case 'format': break;
      default: { const exhaustive: never = op; throw new TypeError(`Unsupported operation: ${exhaustive}`); }
    }
  }
  const prefix = text.slice(0, offset);
  const cellParaIndex = prefix.split('\n').length - 1;
  const charOffset = [...prefix.slice(prefix.lastIndexOf('\n') + 1)].length;
  return { ...position, charOffset, ...(cell ? { cellParaIndex,
    ...(position.cellPath ? { cellPath: position.cellPath.map(entry => ({ ...entry, cellParaIndex })) } : {}) } : {}) };
}

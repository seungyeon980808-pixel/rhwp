import type { DocumentPosition } from '../core/types.ts';

/** Complete supported regions touched by a text selection; unsupported contexts fail closed. */
export function collaborationEditRegions(start: DocumentPosition, end: DocumentPosition): readonly string[] | null {
  if (start.isTextBox || end.isTextBox || (start.cellPath?.length ?? 0) > 1 || (end.cellPath?.length ?? 0) > 1
    || start.sectionIndex !== end.sectionIndex) return null;
  if (start.parentParaIndex !== undefined || end.parentParaIndex !== undefined) {
    if (start.parentParaIndex === undefined || end.parentParaIndex !== start.parentParaIndex
      || start.controlIndex === undefined || start.controlIndex !== end.controlIndex
      || start.cellIndex === undefined || start.cellIndex !== end.cellIndex) return null;
    return [`c:${start.sectionIndex}:${start.parentParaIndex}:${start.controlIndex}:${start.cellIndex}`];
  }
  const first = Math.min(start.paragraphIndex, end.paragraphIndex), last = Math.max(start.paragraphIndex, end.paragraphIndex);
  if (![first, last].every(index => Number.isSafeInteger(index) && index >= 0) || last - first > 2_000) return null;
  return Array.from({ length: last - first + 1 }, (_, index) => `b:${start.sectionIndex}:${first + index}`);
}

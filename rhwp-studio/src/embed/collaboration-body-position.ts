import type { DocumentPosition } from '../core/types.ts';
import type { BodyStructurePlan } from './collaboration-body-structure.ts';

export function bodyStructurePositionTransform(plan: BodyStructurePlan, insertedEnd: DocumentPosition): (point: DocumentPosition) => DocumentPosition {
  const { section, startParagraph, endParagraph, startScalar, endScalar } = plan;
  const paragraphDelta = plan.paragraphs.length - plan.selected.length;
  return (point) => {
    if (point.sectionIndex !== section) return point;
    const paragraph = point.parentParaIndex ?? point.paragraphIndex;
    if (paragraph < startParagraph) return point;
    if (paragraph > endParagraph) return point.parentParaIndex === undefined
      ? { ...point, paragraphIndex: paragraph + paragraphDelta }
      : { ...point, parentParaIndex: paragraph + paragraphDelta };
    // Validated body plans cannot replace control-bearing paragraphs.
    if (point.parentParaIndex !== undefined || point.isTextBox) return point;
    if (paragraph === startParagraph && point.charOffset < startScalar) return point;
    // Native offsets are Unicode scalars; a boundary caret follows inserted text.
    const suffixOffset = paragraph === endParagraph && point.charOffset >= endScalar ? point.charOffset - endScalar : 0;
    return { ...point, paragraphIndex: insertedEnd.paragraphIndex, charOffset: insertedEnd.charOffset + suffixOffset };
  };
}

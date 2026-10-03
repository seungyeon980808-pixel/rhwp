export interface CollaborationRegionV1 {
  readonly id: string;
  readonly kind: 'body' | 'cell';
  readonly label: string;
  readonly text: string;
  readonly importAddress?: string;
  readonly structured?: true;
}

export interface CollaborationApplyTextRequestV1 {
  readonly regionId: string;
  readonly expectedText: string;
  readonly text: string;
}

export type CollaborationApplyTextResultV1 =
  | {
      readonly schemaVersion: 1;
      readonly ok: true;
      readonly region: CollaborationRegionV1;
      readonly revision: number;
    }
  | {
      readonly schemaVersion: 1;
      readonly ok: false;
      readonly reason:
        | 'region-not-found'
        | 'expected-text-mismatch'
        | 'unsupported-text'
        | 'unsupported-region';
    };

import type { StructuredCellReader } from './collaboration-structured-cell.ts';

export interface CollaborationWasm extends StructuredCellReader {
  getControlTextPositions?(section: number, paragraph: number): number[];
  getParagraphCount?(section: number): number;
  inspectApprovedTemplate(): Record<string, unknown>;
  getParagraphLength(sectionIndex: number, paragraphIndex: number): number;
  getTextRange(sectionIndex: number, paragraphIndex: number, charOffset: number, count: number): string;
  getCellParagraphCount(
    sectionIndex: number,
    parentParagraphIndex: number,
    controlIndex: number,
    cellIndex: number,
  ): number;
  getCellParagraphLength(
    sectionIndex: number,
    parentParagraphIndex: number,
    controlIndex: number,
    cellIndex: number,
    cellParagraphIndex: number,
  ): number;
  getTextInCell(
    sectionIndex: number,
    parentParagraphIndex: number,
    controlIndex: number,
    cellIndex: number,
    cellParagraphIndex: number,
    charOffset: number,
    count: number,
  ): string;
  preflightApprovedTemplateEdits(request: unknown): Record<string, unknown>;
  applyApprovedTemplateEdits(request: unknown, preflightToken: string): Record<string, unknown>;
}

export interface CollaborationAdapterEffects {
  readonly currentRevision: () => number;
  readonly afterApply: () => Promise<void>;
}

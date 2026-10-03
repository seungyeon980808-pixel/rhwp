import type { WasmBridge } from '../core/wasm-bridge.ts';
import type { CollaborationRegionV1 } from './collaboration-text-contract.ts';
import type { CollaborationPresenceV1 } from './collaboration-presence.ts';

export interface CollaborationRegionRectsV1 {
  readonly schemaVersion: 1;
  readonly regionId: string;
  readonly pages: readonly {
    readonly pageIndex: number;
    readonly rects: readonly {
      readonly x: number;
      readonly y: number;
      readonly width: number;
      readonly height: number;
    }[];
  }[];
  readonly missing?: readonly string[];
}

export class CollaborationGeometryError extends Error {
  readonly name = 'CollaborationGeometryError';
  readonly code: 'invalid-region-id' | 'region-not-found' | 'unsupported-geometry';
  constructor(code: CollaborationGeometryError['code']) {
    super(code);
    this.code = code;
  }
}

export type CollaborationGeometryRequest = Readonly<{
  regionId: string;
  selection?: Omit<CollaborationPresenceV1, 'regionId'>;
}>;

export function parseCollaborationGeometryRequest(value: unknown): CollaborationGeometryRequest {
  if (typeof value !== 'object' || value === null || Array.isArray(value)
      || Object.keys(value).some((key) => key !== 'regionId' && key !== 'selection') || !('regionId' in value)
      || typeof value.regionId !== 'string'
      || !/^(?:b:\d+:\d+|c:\d+:\d+:\d+:\d+)$/.test(value.regionId)
      || !value.regionId.split(':').slice(1).every((part) => Number.isSafeInteger(Number(part)))) {
    throw new CollaborationGeometryError('invalid-region-id');
  }
  if (!('selection' in value)) return { regionId: value.regionId };
  const selection = value.selection;
  if (typeof selection !== 'object' || selection === null || Array.isArray(selection)
      || Object.keys(selection).some((key) => !['anchorOffset', 'focusOffset', 'anchorRegionId',
        'anchorCellParagraphIndex', 'focusCellParagraphIndex'].includes(key))
      || !('anchorOffset' in selection) || !('focusOffset' in selection)
      || typeof selection.anchorOffset !== 'number' || typeof selection.focusOffset !== 'number'
      || ![selection.anchorOffset, selection.focusOffset].every((offset) => Number.isSafeInteger(offset) && offset >= 0))
    throw new CollaborationGeometryError('unsupported-geometry');
  const anchorRegionId = 'anchorRegionId' in selection
    ? parseCollaborationGeometryRequest({ regionId: selection.anchorRegionId }).regionId : undefined;
  const anchorCellParagraphIndex = 'anchorCellParagraphIndex' in selection ? selection.anchorCellParagraphIndex : undefined;
  const focusCellParagraphIndex = 'focusCellParagraphIndex' in selection ? selection.focusCellParagraphIndex : undefined;
  for (const index of [anchorCellParagraphIndex, focusCellParagraphIndex]) {
    if (index !== undefined && (typeof index !== 'number' || !Number.isSafeInteger(index) || index < 0))
      throw new CollaborationGeometryError('unsupported-geometry');
  }
  return { regionId: value.regionId, selection: {
    anchorOffset: selection.anchorOffset, focusOffset: selection.focusOffset,
    ...(anchorRegionId !== undefined ? { anchorRegionId } : {}),
    ...(typeof anchorCellParagraphIndex === 'number' ? { anchorCellParagraphIndex } : {}),
    ...(typeof focusCellParagraphIndex === 'number' ? { focusCellParagraphIndex } : {}),
  } };
}

type GeometrySource = Pick<WasmBridge,
  'getParagraphLength' | 'getCellParagraphLength' | 'getCellParagraphCount' | 'getSelectionRects'
  | 'getSelectionRectsInCell' | 'getCursorRect' | 'getCursorRectInCell' | 'getTableCellBboxes'>;

export interface CollaborationGeometryContext {
  readonly wasm: GeometrySource;
  readonly regions: readonly CollaborationRegionV1[];
  readonly zoom: number;
}

/** Page-local CSS pixels, with the same zoom transform as SelectionRenderer. */
export function getCollaborationRegionRects(
  request: CollaborationGeometryRequest,
  context: CollaborationGeometryContext,
): CollaborationRegionRectsV1 {
  const region = context.regions.find((candidate) => candidate.id === request.regionId);
  if (!region) throw new CollaborationGeometryError('region-not-found');
  const { wasm, zoom } = context;
  const [, section, paragraph, control, cell] = region.id.split(':');
  const sec = Number(section);
  const para = Number(paragraph);
  const anchorId = request.selection?.anchorRegionId ?? region.id;
  const anchorRegion = context.regions.find((candidate) => candidate.id === anchorId);
  if (!anchorRegion) throw new CollaborationGeometryError('region-not-found');
  const [, anchorSection, anchorParagraph] = anchorId.split(':');
  if (anchorRegion.kind !== region.kind || Number(anchorSection) !== sec)
    throw new CollaborationGeometryError('unsupported-geometry');
  let rects;
  switch (region.kind) {
    case 'body': {
      if (request.selection?.anchorCellParagraphIndex !== undefined || request.selection?.focusCellParagraphIndex !== undefined)
        throw new CollaborationGeometryError('unsupported-geometry');
      const anchorPara = Number(anchorParagraph);
      const anchor = request.selection?.anchorOffset ?? 0;
      const focus = request.selection?.focusOffset ?? wasm.getParagraphLength(sec, para);
      if (anchor > wasm.getParagraphLength(sec, anchorPara) || focus > wasm.getParagraphLength(sec, para))
        throw new CollaborationGeometryError('unsupported-geometry');
      const forward = anchorPara < para || (anchorPara === para && anchor <= focus);
      rects = anchorPara !== para || anchor !== focus
        ? wasm.getSelectionRects(sec, forward ? anchorPara : para, forward ? anchor : focus,
          forward ? para : anchorPara, forward ? focus : anchor)
        : [{ ...wasm.getCursorRect(sec, para, focus), width: 0 }];
      break;
    }
    case 'cell': {
      const ctrl = Number(control);
      const idx = Number(cell);
      if (anchorId !== region.id) throw new CollaborationGeometryError('unsupported-geometry');
      if (!request.selection || region.structured) {
        // Region presence encloses the complete cell, including whitespace and merged-cell
        // geometry. Text selection and caret requests retain their separate text rectangles.
        rects = wasm.getTableCellBboxes(sec, para, ctrl, 0)
          .filter((bbox) => bbox.cellIdx === idx)
          .map((bbox) => ({ pageIndex: bbox.pageIndex, x: bbox.x, y: bbox.y,
            width: bbox.w, height: bbox.h }));
        break;
      }
      const count = wasm.getCellParagraphCount(sec, para, ctrl, idx);
      const anchorPara = request.selection?.anchorCellParagraphIndex ?? 0;
      const focusPara = request.selection ? (request.selection.focusCellParagraphIndex ?? 0) : count - 1;
      if (anchorPara >= count || focusPara >= count || count < 1) throw new CollaborationGeometryError('unsupported-geometry');
      const anchor = request.selection?.anchorOffset ?? 0;
      const focus = request.selection?.focusOffset ?? wasm.getCellParagraphLength(sec, para, ctrl, idx, focusPara);
      if (anchor > wasm.getCellParagraphLength(sec, para, ctrl, idx, anchorPara)
          || focus > wasm.getCellParagraphLength(sec, para, ctrl, idx, focusPara))
        throw new CollaborationGeometryError('unsupported-geometry');
      const forward = anchorPara < focusPara || (anchorPara === focusPara && anchor <= focus);
      rects = anchorPara !== focusPara || anchor !== focus
        ? wasm.getSelectionRectsInCell(sec, para, ctrl, idx, forward ? anchorPara : focusPara,
          forward ? anchor : focus, forward ? focusPara : anchorPara, forward ? focus : anchor)
        : [{ ...wasm.getCursorRectInCell(sec, para, ctrl, idx, focusPara, focus), width: 0 }];
      break;
    }
    default: {
      const exhaustive: never = region.kind;
      throw new TypeError(`Unsupported region kind: ${exhaustive}`);
    }
  }
  const pages = new Map<number, { x: number; y: number; width: number; height: number }[]>();
  const missing: string[] = [];
  if (!Number.isFinite(zoom) || zoom <= 0) {
    return { schemaVersion: 1, regionId: region.id, pages: [], missing: ['viewport-zoom-unavailable'] };
  }
  for (const rect of rects) {
    if (!Number.isSafeInteger(rect.pageIndex) || rect.pageIndex < 0
        || ![rect.x, rect.y, rect.width, rect.height].every(Number.isFinite)
        || rect.width < 0 || rect.height <= 0) {
      missing.push('invalid-layout-rectangle');
      continue;
    }
    const page = pages.get(rect.pageIndex) ?? [];
    page.push({ x: rect.x * zoom, y: rect.y * zoom, width: rect.width * zoom, height: rect.height * zoom });
    pages.set(rect.pageIndex, page);
  }
  if (rects.length === 0) missing.push('layout-rectangles-unavailable');
  return {
    schemaVersion: 1,
    regionId: region.id,
    pages: [...pages].sort(([a], [b]) => a - b).map(([pageIndex, pageRects]) => ({ pageIndex, rects: pageRects })),
    ...(missing.length > 0 ? { missing } : {}),
  };
}

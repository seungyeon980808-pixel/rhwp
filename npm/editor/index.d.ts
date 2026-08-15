/**
 * @rhwp/editor — HWP 에디터 웹 컴포넌트
 */

export interface EditorOptions {
  /** rhwp-studio HTTP(S) URL. file:, data:, browser extension 등 opaque origin은 지원하지 않음 */
  studioUrl?: string;
  /** 문서 단위 renderer 요청. 기본값은 canvas2d이며 auto/CanvasKit 명시 선택도 지원함 */
  renderer?: 'auto' | 'canvas2d' | 'canvaskit';
  /** iframe 너비 (기본: '100%') */
  width?: string;
  /** iframe 높이 (기본: '100%') */
  height?: string;
  /** 모든 method 요청 제한 시간 override(ms, 기본: 일반 10000, load/export 60000) */
  requestTimeoutMs?: number;
  /** v1 협상 제한 시간(ms, 기본: 1000) */
  handshakeTimeoutMs?: number;
}

export interface LoadResult {
  pageCount: number;
  protection?: DocumentProtectionProfileV1;
}

export type DocumentProtectionReason =
  | 'many-pages'
  | 'many-tables'
  | 'many-images'
  | 'nested-tables'
  | 'mixed-drawing-objects';

export interface DocumentProtectionProfileV1 {
  readonly schemaVersion: 1;
  readonly status: 'standard' | 'protected';
  readonly pageCount: number;
  readonly renderedTableCount: number;
  readonly imageCount: number;
  readonly shapeCount: number;
  readonly nestedTableCount: number;
  readonly reasons: readonly DocumentProtectionReason[];
  readonly safeEditScopes: readonly [
    'single-body-paragraph',
    'single-table-cell-paragraph',
  ];
}

export interface SelectionSnapshotV1 {
  readonly schemaVersion: 1;
  readonly snapshotId: string;
  readonly revision: number;
  readonly text: string;
  readonly scope: 'body' | 'cell';
  /** inspection 후보와 조인할 구조 주소. pathDepth > 1인 중첩 표는 승인 대상이 아닙니다. */
  readonly address?:
    | {
        readonly kind: 'body';
        readonly sectionIndex: number;
        readonly paragraphIndex: number;
        readonly startOffset: number;
        readonly endOffset: number;
      }
    | {
        readonly kind: 'cell';
        readonly sectionIndex: number;
        readonly parentParagraphIndex: number;
        readonly controlIndex: number;
        readonly cellIndex: number;
        readonly cellParagraphIndex: number;
        readonly pathDepth: number;
        readonly startOffset: number;
        readonly endOffset: number;
      };
}

export type ReplaceSelectionResultV1 =
  | {
      readonly ok: true;
      readonly snapshotId: string;
      readonly revision: number;
    }
  | {
      readonly ok: false;
      readonly reason: 'snapshot-not-found' | 'stale-document' | 'selection-changed' | 'unsupported-selection';
    };

export interface EmbedFieldV1 {
  readonly schemaVersion: 1;
  readonly fieldId: number;
  readonly name: string;
  readonly guide: string;
  readonly value: string;
  readonly editable: boolean;
}

export interface EmbedFieldValueV1 {
  readonly fieldId: number;
  readonly value: string;
}

export type EmbedFillFieldsResultV1 =
  | { readonly ok: true; readonly updated: number }
  | { readonly ok: false; readonly reason: 'unknown-field' | 'unsupported-field' };

export type HistoryUndoResultV1 =
  | { readonly ok: true }
  | {
      readonly ok: false;
      readonly reason: 'empty-history' | 'editor-not-ready' | 'undo-failed';
    };

export interface ApprovedTemplateProtectionV1 {
  readonly schemaVersion: 1;
  readonly status: 'standard' | 'protected';
  readonly pageCount: number;
  readonly tableCount: number;
  readonly nestedTableCount: number;
  readonly pictureCount: number;
  readonly shapeCount: number;
  readonly reasons: string[];
}

export interface ApprovedTemplateInspectionV1 {
  readonly schemaVersion: 1;
  readonly format: 'hwp' | 'hwpx' | 'hwp3' | 'hml' | 'drm-protected' | 'empty' | 'unknown';
  readonly structureDigest: string;
  readonly pageCount: number;
  readonly sectionCount: number;
  readonly paragraphCount: number;
  readonly topLevelTableCount: number;
  readonly nestedTableCount: number;
  readonly pictureCount: number;
  readonly shapeCount: number;
  readonly binDataCount: number;
  readonly protection: ApprovedTemplateProtectionV1;
  readonly nativeFields: Array<{ fieldId: number; editable: boolean; valueHash: string }>;
  readonly bodyCandidates: Array<{
    sectionIndex: number;
    paragraphIndex: number;
    textHash: string;
    adjacentLabelDigest: string;
  }>;
  readonly tableCells: Array<{
    tableIndex: number;
    row: number;
    col: number;
    rowSpan: number;
    colSpan: number;
    mergedAnchor: { row: number; col: number };
    textHash: string;
    adjacentLabelDigest: string;
    safe: boolean;
    blockedReasons: string[];
    resolvedAddress: {
      sectionIndex: number;
      paragraphIndex: number;
      controlIndex: number;
      cellIndex: number;
    };
  }>;
  readonly truncated: boolean;
}

export type ApprovedTemplateEditTargetV1 =
  | {
      readonly kind: 'native-field';
      readonly targetId: string;
      readonly fieldId: number;
      readonly expectedValueHash: string;
      readonly value: string;
      readonly maxChars: number;
      readonly maxLines: number;
    }
  | {
      readonly kind: 'body-placeholder';
      readonly targetId: string;
      readonly sectionIndex: number;
      readonly paragraphIndex: number;
      readonly expectedTextHash: string;
      readonly adjacentLabelDigest: string;
      readonly value: string;
      readonly maxChars: number;
      readonly maxLines: number;
    }
  | {
      readonly kind: 'table-cell';
      readonly targetId: string;
      readonly tableIndex: number;
      readonly row: number;
      readonly col: number;
      readonly expectedTextHash: string;
      readonly adjacentLabelDigest: string;
      readonly mergedAnchor: { readonly row: number; readonly col: number };
      readonly value: string;
      readonly maxChars: number;
      readonly maxLines: number;
      /** v1은 true만 허용하며 셀의 기존 글자/문단 서식을 보존합니다. */
      readonly keepStyle: true;
    };

export interface ApprovedTemplateEditRequestV1 {
  readonly schemaVersion: 1;
  readonly templateId: string;
  readonly expectedStructureDigest: string;
  readonly targets: ApprovedTemplateEditTargetV1[];
}

export interface ApprovedTemplateEditResultV1 {
  readonly schemaVersion: 1;
  readonly ok: boolean;
  readonly updated: number;
  readonly changedPages: number[] | null;
  readonly preflightToken?: string | null;
  readonly targets?: Array<{
    targetId: string;
    originalValue: string;
    proposedValue: string;
    changed: boolean;
  }>;
  readonly warnings: Array<{ targetId: string | null; code: string }>;
  readonly overflowTargets: Array<{
    targetId: string;
    cellWidthPx: number;
    textWidthPx: number;
    lines: number;
    maxLines: number;
  }>;
  readonly rejectedTargets: Array<{ targetId: string; reason: string }>;
  readonly reason: string | null;
}

export interface ReferenceTextExtractionOptionsV1 {
  /** 전체 추출 문자 상한. 기본 100000, 최대 1000000. */
  maxChars?: number;
  /** 읽을 페이지 상한. 기본 50, 최대 100. */
  maxPages?: number;
}

export interface ReferenceTextExtractionResultV1 {
  readonly schemaVersion: 1;
  readonly format: 'hwp' | 'hwpx' | 'hml';
  readonly pageCount: number;
  readonly extractedPageCount: number;
  readonly extractedCharCount: number;
  readonly truncated: boolean;
  readonly pages: Array<{ readonly pageIndex: number; readonly text: string }>;
  readonly warnings: Array<
    | 'format-mismatch'
    | 'page-limit'
    | 'character-limit'
    | 'document-validation-warnings'
  >;
  /** 현재 편집/렌더/undo 상태와 분리된 임시 문서에서 처리됐음을 뜻합니다. */
  readonly isolatedPreview: true;
}

export interface HwpVerifyResult {
  /** 직렬화된 HWP 바이트 수 */
  bytesLen: number;
  /** 직렬화 직전 페이지 수 */
  pageCountBefore: number;
  /** 자기 재로드 후 페이지 수 (recovered === true 일 때 의미 있음) */
  pageCountAfter: number;
  /** 자기 재로드 성공 여부 */
  recovered: boolean;
}

export interface RevisionedSaveExportV1 {
  readonly schemaVersion: 1;
  readonly bytes: Uint8Array;
  readonly revision: number;
}

export type RevisionedNotifySavedResultV1 =
  | { readonly ok: true; readonly wasDirty: boolean; readonly currentRevision: number }
  | { readonly ok: false; readonly reason: 'document-changed'; readonly currentRevision: number };

export interface HmlSaveBlocker {
  code: string;
  xmlPath: string;
  message: string;
  preserved: false;
}

export interface HmlSaveState {
  sourceFormat: string;
  hmlSavable: boolean;
  blockers: HmlSaveBlocker[];
}

export interface CanvasKitRendererDiagnostics {
  mode: 'default' | 'compat';
  surfacePreference: 'auto' | 'webgpu' | 'webgl' | 'software';
  surfaceBackend: 'default' | 'software' | null;
  surfaceFallbackReason: string | null;
  lastRenderCompleted: boolean;
  lastUnsupportedOps: string[];
  lastExpectedUnsupportedOps: string[];
  lastUnexpectedUnsupportedOps: string[];
  lastRenderError: string | null;
  passesRuntimeReadinessGate: boolean;
  readinessBlockers: Array<'renderNotCompleted' | 'renderError' | 'unexpectedUnsupportedOps' | 'localFontsPending'>;
  hiddenCanvas2dOverlayUsed: false;
  lastRenderDurationMs: number | null;
  renderCount: number;
  imageCacheEntries: number;
  imageCacheLimit: number;
  imageCachePixels: number;
  imageCachePixelLimit: number;
  imageCacheHits: number;
  imageCacheMisses: number;
  imageCacheEvictions: number;
  localTypefaceCount: number;
  localTypefaceLoadFailureCount: number;
  localTypefacePendingCount: number;
  bundledTypefaceCount: number;
  bundledTypefaceLoadFailureCount: number;
}

export interface CanvasKitDocumentPreflightV1 {
  schemaVersion: 1;
  mode: 'default' | 'compat';
  profile: 'fastPreview' | 'screen' | 'print' | 'highQuality';
  status: 'eligible' | 'ineligible' | 'incomplete';
  eligible: boolean;
  complete: boolean;
  pageCount: number;
  scannedPages: number;
  scannedWorkUnits: number;
  limits: {
    maxPages: number;
    maxWorkUnits: number;
    maxBlockers: number;
    maxRequiredFontFamilies: number;
  };
  summary: {
    totalItems: number;
    directItems: number;
    directRequiredItems: number;
    compatOverlayItems: number;
    textFallbackItems: number;
    unsupportedItems: number;
    hiddenOverlayViolations: number;
  };
  blockers: Array<{ pageIndex: number; code: string; opType?: string; detail?: string }>;
  requiredFontFamilies: string[];
  capabilityDigest: string;
}

export interface RendererSelectionV1 {
  schemaVersion: 1;
  request: { backend: 'auto' | 'canvas2d' | 'canvaskit'; source: 'default' | 'url'; requested?: string; unsupportedReason?: string };
  requestedBackend: 'auto' | 'canvas2d' | 'canvaskit';
  effectiveBackend: 'canvas2d' | 'canvaskit';
  selectionReason: string;
  fallbackReason: string | null;
  documentRevision: number;
  resourceGeneration: number;
  renderProfile: 'fastPreview' | 'screen' | 'print' | 'highQuality';
  documentDigest: string | null;
  decisionKey: string;
  preflight: CanvasKitDocumentPreflightV1 | null;
  initializationError: string | null;
  selectionError: string | null;
}

export interface RendererDiagnosticsV1 {
  schemaVersion: 1;
  request: {
    /** Legacy v1 request snapshot. Automatic intent is exposed additively through selection. */
    backend: { backend: 'canvas2d' | 'canvaskit'; source: 'default' | 'url'; requested?: string; unsupportedReason?: string };
    canvaskitMode: { mode: 'default' | 'compat'; source: 'default' | 'storage' | 'url'; requested?: string; unsupportedReason?: string };
    canvaskitSurface: { preference: 'auto' | 'webgpu' | 'webgl' | 'software'; requested: string; unsupportedReason?: string };
    renderProfile: 'fastPreview' | 'screen' | 'print' | 'highQuality';
  } | null;
  initialized: boolean;
  initializationError: string | null;
  effectiveBackend: 'canvas2d' | 'canvaskit' | null;
  backendFallbackReason: string | null;
  /** Added additively to renderer-diagnostics-v1; older Studio builds may omit it. */
  selection?: RendererSelectionV1 | null;
  page: { index: number; canvaskit: CanvasKitRendererDiagnostics | null };
}

export interface LoadFileOptions {
  /** 미저장 변경 확인 없이 문서 교체 */
  skipUnsavedGuard?: boolean;
  /**
   * 로드 후 안내창(HWPX 검증, 로컬 글꼴 감지) 없이 열기.
   * 임베드 환경에서 안내창의 사용자 선택을 기다리느라 loadFile 응답이
   * 지연/교착되는 것을 방지한다. 기본값은 true이며, 안내창을 표시하려면
   * false를 명시한다.
   */
  suppressDialogs?: boolean;
}

export declare class RhwpEditor {
  private constructor();
  /** HWP 파일을 로드합니다 */
  loadFile(data: ArrayBuffer | Uint8Array, fileName?: string, options?: LoadFileOptions): Promise<LoadResult>;
  /** 현재 문서의 페이지 수를 반환합니다 */
  pageCount(): Promise<number>;
  /** 특정 페이지를 SVG 문자열로 렌더링합니다 */
  getPageSvg(page?: number): Promise<string>;
  /** 선택된 renderer와 페이지별 readiness 진단을 반환합니다 */
  getRendererDiagnostics(page?: number): Promise<RendererDiagnosticsV1>;
  /** 현재 문서를 HWP 바이너리로 내보냅니다 */
  exportHwp(): Promise<Uint8Array>;
  /** 같은 산출물을 재로드 검증한 뒤 반환하는 명시 저장용 API. */
  exportHwpVerified(): Promise<Uint8Array>;
  /** 현재 문서를 HWPX(ZIP+XML) 바이너리로 내보냅니다 */
  exportHwpx(): Promise<Uint8Array>;
  /** 현재 문서를 HML(XML) 바이너리로 내보냅니다 */
  exportHml(): Promise<Uint8Array>;
  /** 현재 문서의 HML 저장 가능 여부와 blocker를 반환합니다 */
  getHmlSaveState(): Promise<HmlSaveState>;
  /** HWP 직렬화 + 자기 재로드 검증 메타데이터 (#178) */
  exportHwpVerify(): Promise<HwpVerifyResult>;
  /**
   * 내보내기 바이트의 영속화(업로드/핸드오프) 완료를 스튜디오에 통지합니다 (#2660).
   * dirty 해제 + 자동복구 draft 삭제 완료 후 resolve — resolve 이후 창을 닫아도 안전.
   * 업로드 실패 시에는 호출하지 마세요(백업 draft 보존).
   * 스튜디오가 notify-saved-v1 capability를 광고하지 않으면 요청 없이 실패합니다.
   */
  notifySaved(fileName?: string): Promise<{ ok: true; wasDirty: boolean }>;
  /** 검증된 바이트와 동일 시점의 문서 revision을 원자적으로 캡처합니다. */
  exportDocumentForSave(format: 'hwp' | 'hwpx' | 'hml'): Promise<RevisionedSaveExportV1>;
  /** 캡처한 revision 이후 변경이 없을 때만 dirty와 복구 draft를 해제합니다. */
  notifySavedIfUnchanged(
    revision: number,
    fileName?: string,
  ): Promise<RevisionedNotifySavedResultV1>;
  /** 현재 텍스트 선택을 변경 충돌 검사용 snapshot으로 반환합니다 */
  getSelectionSnapshot(): Promise<SelectionSnapshotV1 | null>;
  /** snapshot이 여전히 유효할 때만 선택 텍스트를 교체합니다 */
  replaceSelection(snapshotId: string, text: string): Promise<ReplaceSelectionResultV1>;
  /** 현재 문서의 입력 가능한 누름틀 목록을 반환합니다 */
  getFields(): Promise<EmbedFieldV1[]>;
  /** 필드 값 여러 개를 하나의 실행 취소 단위로 적용합니다 */
  fillFields(entries: EmbedFieldValueV1[]): Promise<EmbedFillFieldsResultV1>;
  /** 승인 템플릿의 구조 digest와 안전 후보를 원문 없이 조사합니다. */
  inspectApprovedTemplate(): Promise<ApprovedTemplateInspectionV1>;
  /** 요청 전체를 문서 변경 없이 사전 검증합니다. */
  preflightApprovedTemplateEdits(
    request: ApprovedTemplateEditRequestV1,
  ): Promise<ApprovedTemplateEditResultV1>;
  /** preflight token이 여전히 유효할 때 요청 전체를 한 undo 단위로 적용합니다. */
  applyApprovedTemplateEdits(
    request: ApprovedTemplateEditRequestV1,
    preflightToken: string,
  ): Promise<ApprovedTemplateEditResultV1>;
  /** Studio 히스토리의 최상위 편집 한 건을 되돌립니다. */
  undo(): Promise<HistoryUndoResultV1>;
  /** 별도 임시 문서에서 HWP/HWPX/HML 참고 텍스트를 제한 추출합니다. */
  extractReferenceText(
    data: ArrayBuffer | Uint8Array,
    fileName: string,
    options?: ReferenceTextExtractionOptionsV1,
  ): Promise<ReferenceTextExtractionResultV1>;
  /** iframe 엘리먼트를 반환합니다 */
  readonly element: HTMLIFrameElement;
  /** 에디터를 제거합니다 */
  destroy(): void;
}

/**
 * HWP 에디터를 생성하여 지정된 컨테이너에 마운트합니다.
 *
 * @example
 * ```javascript
 * import { createEditor } from '@rhwp/editor';
 *
 * const editor = await createEditor('#container');
 * const resp = await fetch('document.hwp');
 * await editor.loadFile(await resp.arrayBuffer());
 * ```
 */
export declare function createEditor(
  container: string | HTMLElement,
  options?: EditorOptions,
): Promise<RhwpEditor>;

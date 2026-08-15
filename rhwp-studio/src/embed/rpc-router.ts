import type { HmlSaveState } from '../core/hml-save-capability.ts';
import type { DocumentProtectionProfileV1 } from './document-protection-profile.ts';
import type { EmbedHistoryUndoResultV1 } from './protocol.ts';
import type {
  CanvasKitRenderModeRequest,
  CanvasKitSurfaceRequest,
  LayerRenderProfile,
  RenderBackend,
  RenderBackendRequest,
} from '../view/render-backend.ts';

export interface EmbedNotifySavedResult {
  ok: true;
  wasDirty: boolean;
}

export interface EmbedRevisionedSaveExportV1 {
  readonly schemaVersion: 1;
  readonly bytes: Uint8Array;
  readonly revision: number;
}

export type EmbedRevisionedNotifySavedResultV1 =
  | { readonly ok: true; readonly wasDirty: boolean; readonly currentRevision: number }
  | { readonly ok: false; readonly reason: 'document-changed'; readonly currentRevision: number };

export interface EmbedSelectionSnapshotV1 {
  readonly schemaVersion: 1;
  readonly snapshotId: string;
  readonly revision: number;
  readonly text: string;
  readonly scope: 'body' | 'cell';
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

export type EmbedReplaceSelectionResultV1 =
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

export interface EmbedRpcHandlers {
  ready(): Promise<boolean>;
  loadFile(
    data: Uint8Array,
    fileName: string,
    skipUnsavedGuard: boolean,
    suppressDialogs: boolean,
  ): Promise<{ pageCount: number; protection?: DocumentProtectionProfileV1 }>;
  pageCount(): Promise<number>;
  getRendererDiagnostics(page: number): Promise<EmbedRendererDiagnosticsV1>;
  getPageSvg(page: number): Promise<string>;
  exportHwp(): Promise<Uint8Array>;
  exportHwpVerified?(): Promise<Uint8Array>;
  exportDocumentForSave?(
    format: 'hwp' | 'hwpx' | 'hml',
  ): Promise<EmbedRevisionedSaveExportV1>;
  exportHwpx(): Promise<Uint8Array>;
  exportHml(): Promise<Uint8Array>;
  getHmlSaveState(): Promise<HmlSaveState>;
  exportHwpVerify(): Promise<unknown>;
  notifySaved(fileName?: string): Promise<EmbedNotifySavedResult>;
  notifySavedIfUnchanged?(
    revision: number,
    fileName?: string,
  ): Promise<EmbedRevisionedNotifySavedResultV1>;
  getSelectionSnapshot?(): Promise<EmbedSelectionSnapshotV1 | null>;
  replaceSelection?(
    snapshotId: string,
    text: string,
  ): Promise<EmbedReplaceSelectionResultV1>;
  getFields?(): Promise<EmbedFieldV1[]>;
  fillFields?(entries: EmbedFieldValueV1[]): Promise<EmbedFillFieldsResultV1>;
  inspectApprovedTemplate?(): Promise<Record<string, unknown>>;
  preflightApprovedTemplateEdits?(request: Record<string, unknown>): Promise<Record<string, unknown>>;
  applyApprovedTemplateEdits?(
    request: Record<string, unknown>,
    preflightToken: string,
  ): Promise<Record<string, unknown>>;
  extractReferenceText?(
    data: Uint8Array,
    fileName: string,
    options: { maxChars: number; maxPages: number },
  ): Promise<Record<string, unknown>>;
  undo?(): Promise<EmbedHistoryUndoResultV1>;
}

export interface EmbedRendererDiagnosticsV1 {
  schemaVersion: 1;
  request: EmbedRendererRuntimeRequestV1 | null;
  initialized: boolean;
  initializationError: string | null;
  effectiveBackend: 'canvas2d' | 'canvaskit' | null;
  backendFallbackReason: string | null;
  selection: unknown;
  page: { index: number; canvaskit: unknown };
}

export interface EmbedRendererRuntimeRequestV1 {
  backend: Omit<RenderBackendRequest, 'backend'> & { backend: RenderBackend };
  canvaskitMode: CanvasKitRenderModeRequest;
  canvaskitSurface: CanvasKitSurfaceRequest;
  renderProfile: LayerRenderProfile;
}

function asParams(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null ? value as Record<string, unknown> : {};
}

function asBytes(value: unknown, allowLegacyArray: boolean): Uint8Array {
  if (value instanceof Uint8Array) return value;
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  if (allowLegacyArray && Array.isArray(value)) return new Uint8Array(value);
  throw new Error('loadFile requires binary data');
}

function asApprovedTemplateRequest(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error('request must be an object');
  }
  const request = value as Record<string, unknown>;
  if (request.schemaVersion !== 1 || !Array.isArray(request.targets)
      || request.targets.length < 1 || request.targets.length > 100) {
    throw new Error('approved template request must use schemaVersion 1 and 1..100 targets');
  }
  if (JSON.stringify(request).length > 1_000_000) {
    throw new Error('approved template request is too large');
  }
  return request;
}

export async function routeEmbedRequest(
  method: string,
  rawParams: unknown,
  handlers: EmbedRpcHandlers,
  allowLegacyArray = false,
): Promise<unknown> {
  const params = asParams(rawParams);
  switch (method) {
    case 'ready': return handlers.ready();
    case 'loadFile':
      return handlers.loadFile(
        asBytes(params.data, allowLegacyArray),
        typeof params.fileName === 'string' ? params.fileName : 'document.hwp',
        params.skipUnsavedGuard === true,
        params.suppressDialogs === true,
      );
    case 'pageCount': return handlers.pageCount();
    case 'getRendererDiagnostics': {
      const page = params.page ?? 0;
      if (!Number.isSafeInteger(page) || (page as number) < 0) {
        throw new Error('page must be a non-negative safe integer');
      }
      return handlers.getRendererDiagnostics(page as number);
    }
    case 'getPageSvg': return handlers.getPageSvg(
      typeof params.page === 'number' ? params.page : 0,
    );
    case 'exportHwp': return handlers.exportHwp();
    case 'exportHwpVerified': {
      if (!handlers.exportHwpVerified) {
        throw new Error('Verified HWP export is not supported');
      }
      return handlers.exportHwpVerified();
    }
    case 'exportDocumentForSave': {
      if (!handlers.exportDocumentForSave) {
        throw new Error('Revisioned save v1 is not supported');
      }
      if (Object.keys(params).length !== 1 || !['hwp', 'hwpx', 'hml'].includes(String(params.format))) {
        throw new Error('format must be hwp, hwpx, or hml');
      }
      return handlers.exportDocumentForSave(params.format as 'hwp' | 'hwpx' | 'hml');
    }
    case 'exportHwpx': return handlers.exportHwpx();
    case 'exportHml': return handlers.exportHml();
    case 'getHmlSaveState': return handlers.getHmlSaveState();
    case 'exportHwpVerify': return handlers.exportHwpVerify();
    case 'notifySaved': return handlers.notifySaved(
      typeof params.fileName === 'string' && params.fileName.length > 0
        ? params.fileName
        : undefined,
    );
    case 'notifySavedIfUnchanged': {
      if (!handlers.notifySavedIfUnchanged) {
        throw new Error('Revisioned save v1 is not supported');
      }
      const allowedKeys = new Set(['revision', 'fileName']);
      if (Object.keys(params).some((key) => !allowedKeys.has(key))) {
        throw new Error('notifySavedIfUnchanged accepts only revision and fileName');
      }
      if (!Number.isSafeInteger(params.revision) || (params.revision as number) < 0) {
        throw new Error('revision must be a non-negative safe integer');
      }
      return handlers.notifySavedIfUnchanged(
        params.revision as number,
        typeof params.fileName === 'string' && params.fileName.length > 0
          ? params.fileName
          : undefined,
      );
    }
    case 'undo': {
      if (!handlers.undo) throw new Error('History undo v1 is not supported');
      if (Object.keys(params).length !== 0) {
        throw new Error('undo does not accept parameters');
      }
      return handlers.undo();
    }
    case 'getSelectionSnapshot': {
      if (!handlers.getSelectionSnapshot) {
        throw new Error('Selection edit v1 is not supported');
      }
      return handlers.getSelectionSnapshot();
    }
    case 'replaceSelection': {
      if (!handlers.replaceSelection) {
        throw new Error('Selection edit v1 is not supported');
      }
      const snapshotId = params.snapshotId;
      if (typeof snapshotId !== 'string' || snapshotId.length === 0) {
        throw new Error('snapshotId must be a non-empty string');
      }
      const text = params.text;
      if (typeof text !== 'string') {
        throw new Error('text must be a string');
      }
      return handlers.replaceSelection(snapshotId, text);
    }
    case 'getFields': {
      if (!handlers.getFields) throw new Error('Field fill v1 is not supported');
      return handlers.getFields();
    }
    case 'fillFields': {
      if (!handlers.fillFields) throw new Error('Field fill v1 is not supported');
      if (!Array.isArray(params.entries) || params.entries.length > 100) {
        throw new Error('entries must be an array with at most 100 items');
      }
      const entries = params.entries.map((entry) => {
        const value = asParams(entry);
        if (!Number.isSafeInteger(value.fieldId) || (value.fieldId as number) < 0) {
          throw new Error('fieldId must be a non-negative safe integer');
        }
        if (typeof value.value !== 'string' || value.value.length > 20_000) {
          throw new Error('value must be a string with at most 20000 characters');
        }
        return { fieldId: value.fieldId as number, value: value.value };
      });
      return handlers.fillFields(entries);
    }
    case 'inspectApprovedTemplate': {
      if (!handlers.inspectApprovedTemplate) {
        throw new Error('Approved template edit v1 is not supported');
      }
      return handlers.inspectApprovedTemplate();
    }
    case 'preflightApprovedTemplateEdits': {
      if (!handlers.preflightApprovedTemplateEdits) {
        throw new Error('Approved template edit v1 is not supported');
      }
      return handlers.preflightApprovedTemplateEdits(asApprovedTemplateRequest(params.request));
    }
    case 'applyApprovedTemplateEdits': {
      if (!handlers.applyApprovedTemplateEdits) {
        throw new Error('Approved template edit v1 is not supported');
      }
      const preflightToken = params.preflightToken;
      if (typeof preflightToken !== 'string'
          || !/^sha256:[0-9a-f]{64}$/u.test(preflightToken)) {
        throw new Error('preflightToken must be a sha256 digest');
      }
      return handlers.applyApprovedTemplateEdits(
        asApprovedTemplateRequest(params.request),
        preflightToken,
      );
    }
    case 'extractReferenceText': {
      if (!handlers.extractReferenceText) {
        throw new Error('Reference text extract v1 is not supported');
      }
      const data = asBytes(params.data, allowLegacyArray);
      if (data.byteLength < 1 || data.byteLength > 50 * 1024 * 1024) {
        throw new Error('reference data must be between 1 byte and 50 MiB');
      }
      const fileName = params.fileName;
      if (typeof fileName !== 'string' || fileName.length > 255
          || /[\\/]/u.test(fileName) || !/\.(?:hwp|hwpx|hml)$/iu.test(fileName)) {
        throw new Error('fileName must be a basename ending in hwp, hwpx, or hml');
      }
      const options = asParams(params.options);
      if (Object.keys(options).some((key) => key !== 'maxChars' && key !== 'maxPages')) {
        throw new Error('reference extraction options contain unknown keys');
      }
      const maxChars = options.maxChars ?? 100_000;
      const maxPages = options.maxPages ?? 50;
      if (!Number.isSafeInteger(maxChars) || (maxChars as number) < 1
          || (maxChars as number) > 1_000_000) {
        throw new Error('maxChars must be an integer between 1 and 1000000');
      }
      if (!Number.isSafeInteger(maxPages) || (maxPages as number) < 1
          || (maxPages as number) > 100) {
        throw new Error('maxPages must be an integer between 1 and 100');
      }
      return handlers.extractReferenceText(data, fileName, {
        maxChars: maxChars as number,
        maxPages: maxPages as number,
      });
    }
    default: throw new Error(`Unknown method: ${method}`);
  }
}

import type { HmlSaveState } from '../core/hml-save-capability.ts';
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

export interface EmbedSelectionSnapshotV1 {
  readonly schemaVersion: 1;
  readonly snapshotId: string;
  readonly revision: number;
  readonly text: string;
  readonly scope: 'body' | 'cell';
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
  ): Promise<{ pageCount: number }>;
  pageCount(): Promise<number>;
  getRendererDiagnostics(page: number): Promise<EmbedRendererDiagnosticsV1>;
  getPageSvg(page: number): Promise<string>;
  exportHwp(): Promise<Uint8Array>;
  exportHwpx(): Promise<Uint8Array>;
  exportHml(): Promise<Uint8Array>;
  getHmlSaveState(): Promise<HmlSaveState>;
  exportHwpVerify(): Promise<unknown>;
  notifySaved(fileName?: string): Promise<EmbedNotifySavedResult>;
  getSelectionSnapshot?(): Promise<EmbedSelectionSnapshotV1 | null>;
  replaceSelection?(
    snapshotId: string,
    text: string,
  ): Promise<EmbedReplaceSelectionResultV1>;
  getFields?(): Promise<EmbedFieldV1[]>;
  fillFields?(entries: EmbedFieldValueV1[]): Promise<EmbedFillFieldsResultV1>;
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
    case 'exportHwpx': return handlers.exportHwpx();
    case 'exportHml': return handlers.exportHml();
    case 'getHmlSaveState': return handlers.getHmlSaveState();
    case 'exportHwpVerify': return handlers.exportHwpVerify();
    case 'notifySaved': return handlers.notifySaved(
      typeof params.fileName === 'string' && params.fileName.length > 0
        ? params.fileName
        : undefined,
    );
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
    default: throw new Error(`Unknown method: ${method}`);
  }
}

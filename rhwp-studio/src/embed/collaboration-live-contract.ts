import type { CharProperties, ParaProperties } from '../core/types.ts';

export type CollaborationOpV1 =
  | { readonly type: 'insert'; readonly offset: number; readonly text: string }
  | { readonly type: 'delete'; readonly offset: number; readonly count: number }
  | CollaborationFormatOpV1;

export type CollaborationFormatOpV1 = Readonly<{
  type: 'format'; version: 1; offset: number; count: number;
}> & (
  | Readonly<{ scope: 'character'; marks: Readonly<{ bold?: boolean; italic?: boolean; textColor?: string }> }>
  | Readonly<{ scope: 'paragraph'; marks: Readonly<{ alignment: string }> }>
);

export interface CollaborationApplyOpsRequestV1 {
  readonly regionId: string;
  readonly expectedText: string;
  readonly origin: string;
  readonly ops: readonly CollaborationOpV1[];
}

export type CollaborationApplyOpsResultV1 =
  | { readonly schemaVersion: 1; readonly ok: true; readonly text: string; readonly revision: number }
  | {
      readonly schemaVersion: 1;
      readonly ok: false;
      readonly reason: 'region-not-found' | 'expected-text-mismatch' | 'unsupported-text' | 'invalid-offset';
    };

export interface CollaborationMutationV1 {
  readonly sequence: number;
  readonly origin: string;
  readonly regionId: string;
  readonly text: string;
  readonly ops?: readonly CollaborationFormatOpV1[];
}

export interface CollaborationRunV1 {
  readonly start: number;
  readonly end: number;
  readonly properties: CharProperties;
}

export interface CollaborationManifestRegionV1 {
  readonly id: string;
  readonly kind: 'body' | 'cell';
  readonly text: string;
  readonly paragraph: ParaProperties;
  readonly runs: readonly CollaborationRunV1[];
  readonly paragraphs?: readonly Readonly<{
    id: string;
    text: string;
    paragraph: ParaProperties;
    runs: readonly CollaborationRunV1[];
  }>[];
  readonly table?: Readonly<Record<string, unknown>>;
}

export interface CollaborationManifestV1 {
  readonly schemaVersion: 1;
  readonly regions: readonly CollaborationManifestRegionV1[];
  readonly resources: readonly { readonly id: string; readonly sha256: string }[];
  readonly missing: readonly string[];
}

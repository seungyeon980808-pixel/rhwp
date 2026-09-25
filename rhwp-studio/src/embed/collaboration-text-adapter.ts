import type {
  CollaborationAdapterEffects,
  CollaborationApplyTextRequestV1,
  CollaborationApplyTextResultV1,
  CollaborationRegionV1,
  CollaborationWasm,
} from './collaboration-text-contract.ts';
import {
  MAX_COLLABORATION_TEXT_CHARS,
  approvedTemplateTextHash,
  arrayValue,
  booleanValue,
  integerValue,
  isPlainSingleParagraphText,
  recordValue,
  stringValue,
} from './collaboration-text-validation.ts';

export type {
  CollaborationApplyTextRequestV1,
  CollaborationApplyTextResultV1,
  CollaborationRegionV1,
} from './collaboration-text-contract.ts';

const MAX_COLLABORATION_CELL_LINES = 1_000;

type BodyAddress = {
  readonly kind: 'body';
  readonly sectionIndex: number;
  readonly paragraphIndex: number;
  readonly adjacentLabelDigest: string;
};

type CellAddress = {
  readonly kind: 'cell';
  readonly sectionIndex: number;
  readonly parentParagraphIndex: number;
  readonly controlIndex: number;
  readonly cellIndex: number;
  readonly tableIndex: number;
  readonly row: number;
  readonly col: number;
  readonly adjacentLabelDigest: string;
};

type RegionAddress = BodyAddress | CellAddress;

type FrozenRegion = {
  readonly id: string;
  readonly label: string;
  readonly address: RegionAddress;
};

type CurrentTarget = {
  readonly region: CollaborationRegionV1;
  readonly requestTarget: Record<string, unknown>;
  readonly structureDigest: string;
};

export class CollaborationTextAdapter {
  private frozenRegions: readonly FrozenRegion[] | null = null;
  private frozenStructureDigest: string | null = null;
  private readonly wasm: CollaborationWasm;
  private readonly effects: CollaborationAdapterEffects;

  constructor(
    wasm: CollaborationWasm,
    effects: CollaborationAdapterEffects,
  ) {
    this.wasm = wasm;
    this.effects = effects;
  }

  resetCatalog(): void {
    this.frozenRegions = null;
    this.frozenStructureDigest = null;
  }

  async getRegions(): Promise<readonly CollaborationRegionV1[]> {
    const inspection = this.wasm.inspectApprovedTemplate();
    if (!isStandardInspection(inspection)) return [];
    if (this.frozenRegions === null) {
      this.frozenRegions = freezeRegions(inspection, this.wasm);
      this.frozenStructureDigest = stringValue(inspection, 'structureDigest');
    }
    if (stringValue(inspection, 'structureDigest') !== this.frozenStructureDigest) return [];
    return this.frozenRegions.flatMap((frozen) => {
      const current = currentTarget(inspection, frozen, this.wasm);
      return current === null ? [] : [current.region];
    });
  }

  async applyText(
    request: CollaborationApplyTextRequestV1,
  ): Promise<CollaborationApplyTextResultV1> {
    if (!isPlainSingleParagraphText(request.text)) {
      return { schemaVersion: 1, ok: false, reason: 'unsupported-text' };
    }
    await this.getRegions();
    const frozen = this.frozenRegions?.find((region) => region.id === request.regionId);
    if (!frozen) return { schemaVersion: 1, ok: false, reason: 'region-not-found' };

    const inspection = this.wasm.inspectApprovedTemplate();
    if (!isStandardInspection(inspection)) {
      return { schemaVersion: 1, ok: false, reason: 'unsupported-region' };
    }
    if (stringValue(inspection, 'structureDigest') !== this.frozenStructureDigest) {
      return { schemaVersion: 1, ok: false, reason: 'unsupported-region' };
    }
    const current = currentTarget(inspection, frozen, this.wasm);
    if (current === null) {
      return { schemaVersion: 1, ok: false, reason: 'unsupported-region' };
    }
    if (current.region.text !== request.expectedText) {
      return { schemaVersion: 1, ok: false, reason: 'expected-text-mismatch' };
    }
    if (request.text === request.expectedText) {
      return {
        schemaVersion: 1,
        ok: true,
        region: current.region,
        revision: this.effects.currentRevision(),
      };
    }

    const editRequest = {
      schemaVersion: 1,
      templateId: `collaboration-${frozen.id.replaceAll(':', '-')}`,
      expectedStructureDigest: current.structureDigest,
      targets: [{ ...current.requestTarget, value: request.text }],
    };
    const preflight = this.wasm.preflightApprovedTemplateEdits(editRequest);
    const token = Reflect.get(preflight, 'preflightToken');
    if (Reflect.get(preflight, 'ok') !== true || typeof token !== 'string') {
      return { schemaVersion: 1, ok: false, reason: 'unsupported-region' };
    }
    const applied = this.wasm.applyApprovedTemplateEdits(editRequest, token);
    if (Reflect.get(applied, 'ok') !== true || Reflect.get(applied, 'updated') !== 1) {
      return { schemaVersion: 1, ok: false, reason: 'unsupported-region' };
    }
    await this.effects.afterApply();
    const refreshedInspection = this.wasm.inspectApprovedTemplate();
    if (stringValue(refreshedInspection, 'structureDigest') === this.frozenStructureDigest) {
      this.frozenRegions = this.frozenRegions?.map((region) => ({
        ...region,
        address: refreshAdjacentLabelDigest(refreshedInspection, region.address),
      })) ?? null;
    }
    const refreshed = readRegion(frozen, this.wasm);
    if (refreshed === null || refreshed.text !== request.text) {
      return { schemaVersion: 1, ok: false, reason: 'unsupported-region' };
    }
    return {
      schemaVersion: 1,
      ok: true,
      region: refreshed,
      revision: this.effects.currentRevision(),
    };
  }
}

function refreshAdjacentLabelDigest(
  inspection: Record<string, unknown>,
  address: RegionAddress,
): RegionAddress {
  const candidate = address.kind === 'body'
    ? arrayValue(inspection, 'bodyCandidates').find((value) =>
      integerValue(value, 'sectionIndex') === address.sectionIndex
      && integerValue(value, 'paragraphIndex') === address.paragraphIndex)
    : arrayValue(inspection, 'tableCells').find((value) => {
      const resolved = recordValue(value, 'resolvedAddress');
      return integerValue(resolved, 'sectionIndex') === address.sectionIndex
        && integerValue(resolved, 'paragraphIndex') === address.parentParagraphIndex
        && integerValue(resolved, 'controlIndex') === address.controlIndex
        && integerValue(resolved, 'cellIndex') === address.cellIndex;
    });
  const adjacentLabelDigest = stringValue(candidate, 'adjacentLabelDigest');
  return adjacentLabelDigest === null ? address : { ...address, adjacentLabelDigest };
}

function freezeRegions(
  inspection: Record<string, unknown>,
  wasm: CollaborationWasm,
): readonly FrozenRegion[] {
  const body = arrayValue(inspection, 'bodyCandidates').flatMap((candidate) => {
    const sectionIndex = integerValue(candidate, 'sectionIndex');
    const paragraphIndex = integerValue(candidate, 'paragraphIndex');
    const adjacentLabelDigest = stringValue(candidate, 'adjacentLabelDigest');
    if (sectionIndex === null || paragraphIndex === null || adjacentLabelDigest === null) return [];
    const frozen: FrozenRegion = {
      id: `b:${sectionIndex}:${paragraphIndex}`,
      label: `Body ${sectionIndex + 1}.${paragraphIndex + 1}`,
      address: { kind: 'body', sectionIndex, paragraphIndex, adjacentLabelDigest },
    };
    return readRegion(frozen, wasm) === null ? [] : [frozen];
  });
  const cells = arrayValue(inspection, 'tableCells').flatMap((candidate) => {
    if (booleanValue(candidate, 'safe') !== true) return [];
    const resolved = recordValue(candidate, 'resolvedAddress');
    const sectionIndex = integerValue(resolved, 'sectionIndex');
    const parentParagraphIndex = integerValue(resolved, 'paragraphIndex');
    const controlIndex = integerValue(resolved, 'controlIndex');
    const cellIndex = integerValue(resolved, 'cellIndex');
    const tableIndex = integerValue(candidate, 'tableIndex');
    const row = integerValue(candidate, 'row');
    const col = integerValue(candidate, 'col');
    const adjacentLabelDigest = stringValue(candidate, 'adjacentLabelDigest');
    if (
      sectionIndex === null
      || parentParagraphIndex === null
      || controlIndex === null
      || cellIndex === null
      || tableIndex === null
      || row === null
      || col === null
      || adjacentLabelDigest === null
      || wasm.getCellParagraphCount(
        sectionIndex,
        parentParagraphIndex,
        controlIndex,
        cellIndex,
      ) !== 1
    ) return [];
    const frozen: FrozenRegion = {
      id: `c:${sectionIndex}:${parentParagraphIndex}:${controlIndex}:${cellIndex}`,
      label: `Cell ${sectionIndex + 1}.${parentParagraphIndex + 1}.${controlIndex + 1}.${cellIndex + 1}`,
      address: {
        kind: 'cell',
        sectionIndex,
        parentParagraphIndex,
        controlIndex,
        cellIndex,
        tableIndex,
        row,
        col,
        adjacentLabelDigest,
      },
    };
    return readRegion(frozen, wasm) === null ? [] : [frozen];
  });
  return [...body, ...cells];
}

function currentTarget(
  inspection: Record<string, unknown>,
  frozen: FrozenRegion,
  wasm: CollaborationWasm,
): CurrentTarget | null {
  const structureDigest = stringValue(inspection, 'structureDigest');
  if (structureDigest === null) return null;
  const address = frozen.address;
  if (address.kind === 'body') {
    const region = readRegion(frozen, wasm);
    if (region === null) return null;
    return {
      structureDigest,
      region,
      requestTarget: {
        kind: 'body-placeholder',
        targetId: frozen.id,
        sectionIndex: address.sectionIndex,
        paragraphIndex: address.paragraphIndex,
        expectedTextHash: approvedTemplateTextHash(region.text),
        adjacentLabelDigest: address.adjacentLabelDigest,
        maxChars: MAX_COLLABORATION_TEXT_CHARS,
        maxLines: 1,
      },
    };
  }
  const region = readRegion(frozen, wasm);
  if (region === null) return null;
  return {
    structureDigest,
    region,
    requestTarget: {
      kind: 'table-cell',
      targetId: frozen.id,
      tableIndex: address.tableIndex,
      row: address.row,
      col: address.col,
      expectedTextHash: approvedTemplateTextHash(region.text),
      adjacentLabelDigest: address.adjacentLabelDigest,
      mergedAnchor: { row: address.row, col: address.col },
      maxChars: MAX_COLLABORATION_TEXT_CHARS,
      maxLines: MAX_COLLABORATION_CELL_LINES,
      keepStyle: true,
    },
  };
}

function readRegion(
  frozen: FrozenRegion,
  wasm: CollaborationWasm,
): CollaborationRegionV1 | null {
  const address = frozen.address;
  const text = address.kind === 'body'
    ? wasm.getTextRange(
      address.sectionIndex,
      address.paragraphIndex,
      0,
      wasm.getParagraphLength(address.sectionIndex, address.paragraphIndex),
    )
    : wasm.getTextInCell(
      address.sectionIndex,
      address.parentParagraphIndex,
      address.controlIndex,
      address.cellIndex,
      0,
      0,
      wasm.getCellParagraphLength(
        address.sectionIndex,
        address.parentParagraphIndex,
        address.controlIndex,
        address.cellIndex,
        0,
      ),
    );
  if (!isPlainSingleParagraphText(text)) return null;
  return { id: frozen.id, kind: address.kind, label: frozen.label, text };
}

function isStandardInspection(inspection: Record<string, unknown>): boolean {
  return integerValue(inspection, 'schemaVersion') === 1
    && stringValue(recordValue(inspection, 'protection'), 'status') === 'standard';
}

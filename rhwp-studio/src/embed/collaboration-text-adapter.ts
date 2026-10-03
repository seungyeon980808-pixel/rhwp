import { readStructuredCell } from './collaboration-structured-cell.ts';
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
  encodeCollaborationParagraph,
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
  readonly structured?: true;
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
    return this.getRegionsSync();
  }

  getRegionsSync(): readonly CollaborationRegionV1[] {
    const inspection = this.wasm.inspectApprovedTemplate();
    if (!isStandardInspection(inspection)) return [];
    if (this.frozenRegions === null) {
      this.frozenRegions = freezeRegions(inspection, this.wasm);
      this.frozenStructureDigest = catalogStructureDigest(inspection);
    }
    if (catalogStructureDigest(inspection) !== this.frozenStructureDigest) return [];
    return this.frozenRegions.flatMap((frozen) => {
      const current = currentTarget(inspection, frozen, this.wasm);
      return current === null ? [] : [current.region];
    });
  }

  /** Layout identity survives local text becoming ineligible for plain-text sync.
   * Never use this catalog to grant write access or apply collaboration edits. */
  getRegionText(regionId: string): CollaborationRegionV1 | null {
    if (this.frozenRegions === null) this.getRegionsSync();
    const frozen = this.frozenRegions?.find(region => region.id === regionId || nativeAddress(region.address) === regionId);
    return frozen ? readRegion(frozen, this.wasm) : null;
  }

  getGeometryRegions(): readonly CollaborationRegionV1[] {
    if (this.frozenRegions === null) this.getRegionsSync();
    const inspection = this.wasm.inspectApprovedTemplate();
    if (!isStandardInspection(inspection)
      || catalogStructureDigest(inspection) !== this.frozenStructureDigest) return [];
    return (this.frozenRegions ?? []).map((frozen) => {
      const importAddress = nativeAddress(frozen.address);
      return { id: importAddress, kind: frozen.address.kind, label: frozen.label, text: '', ...(frozen.structured ? {structured:true as const} : {}) };
    });
  }

  resolveAddress(id: string): string | null {
    const region = this.frozenRegions?.find((entry) => entry.id === id);
    return region ? nativeAddress(region.address) : null;
  }

  checkpoint(): () => void {
    const regions = this.frozenRegions;
    const digest = this.frozenStructureDigest;
    return () => { this.frozenRegions = regions; this.frozenStructureDigest = digest; };
  }

  remapStructure(mapping: readonly Readonly<{ id: string; importAddress: string }>[]): void {
    const inspection = this.wasm.inspectApprovedTemplate();
    if (!isStandardInspection(inspection)) throw new TypeError('Invalid collaboration structure');
    const mapped = new Set(mapping.map((entry) => entry.importAddress));
    const current = freezeRegions(inspection, this.wasm).filter((region) => mapped.has(nativeAddress(region.address)));
    for (const entry of mapping) {
      if (current.some((region) => nativeAddress(region.address) === entry.importAddress)) continue;
      const match = /^b:(\d+):(\d+)$/u.exec(entry.importAddress);
      if (!match?.[1] || !match[2]) throw new TypeError('Invalid empty paragraph mapping');
      const sectionIndex = Number(match[1]);
      const paragraphIndex = Number(match[2]);
      if (paragraphIndex >= (this.wasm.getParagraphCount?.(sectionIndex) ?? 0)
        || this.wasm.getParagraphLength(sectionIndex, paragraphIndex) !== 0
        || this.wasm.getControlTextPositions?.(sectionIndex, paragraphIndex).length !== 0)
        throw new TypeError('Invalid empty paragraph mapping');
      current.push({ id: entry.id, label: `Body ${sectionIndex + 1}.${paragraphIndex + 1}`,
        address: { kind: 'body', sectionIndex, paragraphIndex, adjacentLabelDigest: '' } });
    }
    const ids = new Set(mapping.map((entry) => entry.id));
    const addresses = new Map(mapping.map((entry) => [entry.importAddress, entry.id]));
    if (ids.size !== mapping.length || addresses.size !== mapping.length || current.length !== mapping.length
      || current.some((entry) => !addresses.has(nativeAddress(entry.address))))
      throw new TypeError('Incomplete collaboration structure mapping');
    current.sort((left, right) => {
      if (left.address.kind !== right.address.kind) return left.address.kind === 'body' ? -1 : 1;
      const a = nativeAddress(left.address).split(':').slice(1).map(Number);
      const b = nativeAddress(right.address).split(':').slice(1).map(Number);
      for (let index = 0; index < a.length; index += 1) {
        const difference = (a[index] ?? 0) - (b[index] ?? 0);
        if (difference !== 0) return difference;
      }
      return 0;
    });
    this.frozenRegions = current.map((entry) => ({ ...entry, id: addresses.get(nativeAddress(entry.address)) ?? entry.id }));
    this.frozenStructureDigest = catalogStructureDigest(inspection);
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
    if (frozen.address.kind === 'cell' && this.wasm.getCellParagraphCount(
      frozen.address.sectionIndex, frozen.address.parentParagraphIndex,
      frozen.address.controlIndex, frozen.address.cellIndex,
    ) !== 1) return { schemaVersion: 1, ok: false, reason: 'unsupported-region' };

    const inspection = this.wasm.inspectApprovedTemplate();
    if (!isStandardInspection(inspection)) {
      return { schemaVersion: 1, ok: false, reason: 'unsupported-region' };
    }
    if (catalogStructureDigest(inspection) !== this.frozenStructureDigest) {
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
    if (catalogStructureDigest(refreshedInspection) === this.frozenStructureDigest) {
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
    const blocked = arrayValue(candidate, 'blockedReasons');
    if (booleanValue(candidate, 'safe') !== true
      && !blocked.every(reason => reason === 'multiple-paragraphs' || reason === 'mixed-control-content')) return [];
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
      ) < 1
    ) return [];
    const frozen: FrozenRegion = {
      id: `c:${sectionIndex}:${parentParagraphIndex}:${controlIndex}:${cellIndex}`,
      label: `Cell ${sectionIndex + 1}.${parentParagraphIndex + 1}.${controlIndex + 1}.${cellIndex + 1}`,
      ...(blocked.includes('mixed-control-content') ? { structured: true as const } : {}),
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
  if (frozen.structured && address.kind === 'cell') {
    const value = readStructuredCell(wasm, {section:address.sectionIndex,paragraph:address.parentParagraphIndex,control:address.controlIndex,cell:address.cellIndex});
    const importAddress = nativeAddress(address);
    return value ? {id:frozen.id,kind:'cell',label:frozen.label,text:value.text,structured:true,
      ...(frozen.id === importAddress ? {} : {importAddress})} : null;
  }
  const paragraphs = address.kind === 'body'
    ? [wasm.getTextRange(
      address.sectionIndex,
      address.paragraphIndex,
      0,
      wasm.getParagraphLength(address.sectionIndex, address.paragraphIndex),
    )]
    : Array.from({ length: wasm.getCellParagraphCount(
      address.sectionIndex, address.parentParagraphIndex, address.controlIndex, address.cellIndex,
    ) }, (_, cellParagraph) => wasm.getTextInCell(
      address.sectionIndex,
      address.parentParagraphIndex,
      address.controlIndex,
      address.cellIndex,
      cellParagraph,
      0,
      wasm.getCellParagraphLength(
        address.sectionIndex,
        address.parentParagraphIndex,
        address.controlIndex,
        address.cellIndex,
        cellParagraph,
      ),
    ));
  const encoded = paragraphs.map(encodeCollaborationParagraph);
  if (encoded.some((paragraph) => paragraph === null)) return null;
  const text = encoded.join('\n');
  if (text.length > MAX_COLLABORATION_TEXT_CHARS) return null;
  const importAddress = nativeAddress(address);
  return { id: frozen.id, kind: address.kind, label: frozen.label, text,
    ...(frozen.id === importAddress ? {} : { importAddress }) };
}

function nativeAddress(address: RegionAddress): string {
  return address.kind === 'body' ? `b:${address.sectionIndex}:${address.paragraphIndex}`
    : `c:${address.sectionIndex}:${address.parentParagraphIndex}:${address.controlIndex}:${address.cellIndex}`;
}

function isStandardInspection(inspection: Record<string, unknown>): boolean {
  return integerValue(inspection, 'schemaVersion') === 1
    && ['standard', 'protected'].includes(stringValue(recordValue(inspection, 'protection'), 'status') ?? '');
}

function catalogStructureDigest(inspection: Record<string, unknown>): string | null {
  return stringValue(inspection, 'collaborationTextStructureDigest') ?? stringValue(inspection, 'structureDigest');
}

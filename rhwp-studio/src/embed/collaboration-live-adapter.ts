import { structuredPositionRemapper } from './collaboration-structured-cell.ts';
import { readStructuredCell, applyStructuredCellOps, structuredManifest, type StructuredCellWasm } from './collaboration-structured-cell.ts';
import { encodeCollaborationParagraph, decodeCollaborationParagraph, isCollaborationParagraph } from './collaboration-text-validation.ts';
import type { CellInfo, CharProperties, ParaProperties, TableDimensions } from '../core/types.ts';
import { formatOperations, parseFormatOperation } from './collaboration-format.ts';
import { applyFormatting, planFormatting, type CollaborationFormatWasm } from './collaboration-format-apply.ts';
import type { CollaborationRegionV1 } from './collaboration-text-contract.ts';
import type { CollaborationTextChange } from './collaboration-text-position.ts';
import { inspectRawResources, tableTopologySignature, type RawResourceSource } from './collaboration-resource-manifest.ts';
import type {
  CollaborationApplyOpsRequestV1,
  CollaborationApplyOpsResultV1,
  CollaborationManifestRegionV1,
  CollaborationManifestV1,
  CollaborationMutationV1,
  CollaborationRunV1,
  CollaborationFormatOpV1,
} from './collaboration-live-contract.ts';

type BodyAddress = Readonly<{ kind: 'body'; section: number; paragraph: number }>;
type CellAddress = Readonly<{
  kind: 'cell'; section: number; paragraph: number; control: number; cell: number;
  cellParagraph: number;
}>;
type Address = BodyAddress | CellAddress;

export interface CollaborationLiveWasm extends RawResourceSource, CollaborationFormatWasm, StructuredCellWasm {
  getCollaborationBodyParagraph?(section: number, paragraph: number): Readonly<{ text: string; paragraph: ParaProperties; charRunStarts?: readonly number[] }> | null;
  getParagraphLength(section: number, paragraph: number): number;
  getTextRange(section: number, paragraph: number, offset: number, count: number): string;
  insertText(section: number, paragraph: number, offset: number, text: string): string;
  deleteText(section: number, paragraph: number, offset: number, count: number): string;
  getCharPropertiesAt(section: number, paragraph: number, offset: number): CharProperties;
  getParaPropertiesAt(section: number, paragraph: number): ParaProperties;
  getCellParagraphCount(section: number, paragraph: number, control: number, cell: number): number;
  getCellParagraphLength(section: number, paragraph: number, control: number, cell: number, cellParagraph: number): number;
  getTextInCell(section: number, paragraph: number, control: number, cell: number, cellParagraph: number, offset: number, count: number): string;
  insertTextInCell(section: number, paragraph: number, control: number, cell: number, cellParagraph: number, offset: number, text: string): string;
  deleteTextInCell(section: number, paragraph: number, control: number, cell: number, cellParagraph: number, offset: number, count: number): string;
  splitParagraphInCell(section: number, paragraph: number, control: number, cell: number, cellParagraph: number, offset: number): string;
  mergeParagraphInCell(section: number, paragraph: number, control: number, cell: number, cellParagraph: number): string;
  getCellCharPropertiesAt(section: number, paragraph: number, control: number, cell: number, cellParagraph: number, offset: number): CharProperties;
  getCellParaPropertiesAt(section: number, paragraph: number, control: number, cell: number, cellParagraph: number): ParaProperties;
  getTableDimensions(section: number, paragraph: number, control: number): TableDimensions;
  getCellInfo(section: number, paragraph: number, control: number, cell: number): CellInfo;
}

type Effects = Readonly<{
  regions: () => Promise<readonly CollaborationRegionV1[]>;
  revision: () => number;
  refresh: (change: CollaborationTextChange) => Promise<void>;
}>;

export class CollaborationLiveAdapter {
  private readonly wasm: CollaborationLiveWasm;
  private readonly effects: Effects;
  private sequence = 0;
  private mutations: CollaborationMutationV1[] = [];
  private knownTexts = new Map<string, string>();
  private readonly knownFormats = new Map<string, CollaborationManifestRegionV1>();
  private applying = false;
  private started = false;
  private capturedRevision = -1;
  private pendingCapture: Promise<void> | null = null;
  private readonly regionCatalog = new Map<string, CollaborationRegionV1>();
  private readonly tableSignatures = new Map<string, string>();
  private dirtyRegions: Set<string> | null = null;
  private observedRevision = -1;

  /** Only pass IDs when the native operation is a text-only edit within those regions.
   * Unknown operations (formatting, undo, topology changes) deliberately invalidate all. */
  noteMutation(revision: number, regionIds?: readonly string[]): void {
    const previous = Math.max(this.observedRevision, this.capturedRevision);
    if (this.observedRevision <= this.capturedRevision) this.dirtyRegions = new Set();
    this.observedRevision = revision;
    if (!regionIds?.length || revision !== previous + 1) this.dirtyRegions = null;
    else if (this.dirtyRegions) for (const id of regionIds) this.dirtyRegions.add(id);
  }

  constructor(wasm: CollaborationLiveWasm, effects: Effects) {
    this.wasm = wasm;
    this.effects = effects;
  }

  async begin(): Promise<void> {
    const regions = await this.effects.regions();
    this.regionCatalog.clear();
    for (const region of regions) this.regionCatalog.set(region.id, region);
    this.knownTexts = new Map(regions.map((region) => [region.id, region.text]));
    this.knownFormats.clear();
    for (const region of (await this.manifest()).regions) this.knownFormats.set(region.id, region);
    this.started = true;
    this.capturedRevision = this.effects.revision();
    this.observedRevision = this.capturedRevision;
    this.dirtyRegions = new Set();
  }

  async apply(request: CollaborationApplyOpsRequestV1): Promise<CollaborationApplyOpsResultV1> {
    const region = (await this.effects.regions()).find((candidate) => candidate.id === request.regionId);
    const address = parseAddress(region?.importAddress ?? request.regionId);
    if (!region || !address) return { schemaVersion: 1, ok: false, reason: 'region-not-found' };
    if (region.text !== request.expectedText) {
      return { schemaVersion: 1, ok: false, reason: 'expected-text-mismatch' };
    }
    if (region.structured && address.kind === 'cell') {
      this.applying = true;
      try {
        const beforeStructure = readStructuredCell(this.wasm, address);
        const text = applyStructuredCellOps(this.wasm, address, request.expectedText, request.ops);
        if (text === null) return { schemaVersion: 1, ok: false, reason: 'unsupported-text' };
        const afterStructure = readStructuredCell(this.wasm, address);
        await this.effects.refresh({ nativeAddress: region.importAddress ?? region.id, before: region.text, ops: request.ops,
          ...(beforeStructure && afterStructure ? {remapPosition:structuredPositionRemapper(address,beforeStructure,afterStructure,request.ops)} : {}) });
        const updated = { ...region, text };
        this.regionCatalog.set(region.id, updated);
        this.knownTexts.set(region.id, text);
        this.knownFormats.set(region.id, this.manifestRegion(updated).region);
        this.publish(request.origin, region.id, text);
        return { schemaVersion: 1, ok: true, text, revision: this.effects.revision() };
      } finally { this.applying = false; }
    }
    let text = region.text;
    const engineOps: Array<
      | Readonly<{ type: 'insert'; address: Address; offset: number; text: string }>
      | Readonly<{ type: 'delete'; address: Address; offset: number; count: number }>
      | Readonly<{ type: 'split'; address: CellAddress; offset: number }>
      | Readonly<{ type: 'merge'; address: CellAddress }>
      | Readonly<{ type: 'format'; address: Address; operation: CollaborationFormatOpV1; ranges: NonNullable<ReturnType<typeof planFormatting>> }>
    > = [];
    for (const op of request.ops) {
      if (!Number.isSafeInteger(op.offset) || op.offset < 0 || op.offset > text.length) {
        return { schemaVersion: 1, ok: false, reason: 'invalid-offset' };
      }
      if (op.type === 'format') {
        const parsed = parseFormatOperation(op);
        const ranges = parsed ? planFormatting(text, parsed) : null;
        if (!parsed || !ranges) return { schemaVersion: 1, ok: false, reason: 'invalid-offset' };
        engineOps.push({ type: 'format', address, operation: parsed, ranges });
        continue;
      }
      const prefix = text.slice(0, op.offset);
      const paragraphStart = address.kind === 'cell' ? prefix.lastIndexOf('\n') + 1 : 0;
      const target = address.kind === 'cell'
        ? { ...address, cellParagraph: prefix.split('\n').length - 1 } : address;
      const paragraphText = text.slice(paragraphStart);
      const engineOffset = scalarOffset(paragraphText, op.offset - paragraphStart);
      if (engineOffset === null) return { schemaVersion: 1, ok: false, reason: 'invalid-offset' };
      if (op.type === 'insert') {
        if (op.text.length > 20_000 || !(target.kind === 'cell' ? op.text.split('\n').every(isCollaborationParagraph) : isCollaborationParagraph(op.text))) {
          return { schemaVersion: 1, ok: false, reason: 'unsupported-text' };
        }
        if (target.kind === 'cell') {
          const parts = op.text.split('\n');
          for (const [index, part] of parts.entries()) {
            const partAddress = { ...target, cellParagraph: target.cellParagraph + index };
            const offset = index === 0 ? engineOffset : 0;
            if (part.length > 0) engineOps.push({ type: 'insert', address: partAddress, offset, text: part });
            if (index < parts.length - 1) engineOps.push({ type: 'split', address: partAddress, offset: offset + [...part].length });
          }
        } else engineOps.push({ type: 'insert', address: target, offset: engineOffset, text: op.text });
        text = `${text.slice(0, op.offset)}${op.text}${text.slice(op.offset)}`;
      } else {
        if (!Number.isSafeInteger(op.count) || op.count < 1 || op.offset + op.count > text.length) {
          return { schemaVersion: 1, ok: false, reason: 'invalid-offset' };
        }
        const engineEnd = scalarOffset(paragraphText, op.offset + op.count - paragraphStart);
        if (engineEnd === null) return { schemaVersion: 1, ok: false, reason: 'invalid-offset' };
        if (target.kind === 'cell') {
          for (const [index, part] of text.slice(op.offset, op.offset + op.count).split('\n').entries()) {
            if (index > 0) engineOps.push({ type: 'merge', address: { ...target, cellParagraph: target.cellParagraph + 1 } });
            if (part.length > 0) engineOps.push({ type: 'delete', address: target, offset: engineOffset, count: [...part].length });
          }
        } else engineOps.push({ type: 'delete', address: target, offset: engineOffset, count: engineEnd - engineOffset });
        text = `${text.slice(0, op.offset)}${text.slice(op.offset + op.count)}`;
      }
    }
    if (text.length > 20_000) return { schemaVersion: 1, ok: false, reason: 'unsupported-text' };
    this.applying = true;
    try {
    for (const op of engineOps) {
      switch (op.type) {
        case 'insert': insert(this.wasm, op.address, op.offset, op.text); break;
        case 'delete': remove(this.wasm, op.address, op.offset, op.count); break;
        case 'split': this.wasm.splitParagraphInCell(op.address.section, op.address.paragraph,
          op.address.control, op.address.cell, op.address.cellParagraph, op.offset); break;
        case 'merge': this.wasm.mergeParagraphInCell(op.address.section, op.address.paragraph,
          op.address.control, op.address.cell, op.address.cellParagraph); break;
        case 'format': applyFormatting(this.wasm, op); break;
        default: { const exhaustive: never = op; throw new TypeError(`Unsupported operation: ${exhaustive}`); }
      }
    }
    const actual = read(this.wasm, address);
    if (actual !== text) return { schemaVersion: 1, ok: false, reason: 'invalid-offset' };
    await this.effects.refresh({ nativeAddress: region.importAddress ?? region.id, before: region.text, ops: request.ops });
    this.knownTexts.set(region.id, actual);
    this.knownFormats.set(region.id, this.manifestRegion({ ...region, text: actual }).region);
    this.publish(request.origin, region.id, actual);
    return { schemaVersion: 1, ok: true, text: actual, revision: this.effects.revision() };
    } finally { this.applying = false; }
  }

  /** Polling must not rescan every character of an unchanged document. */
  async capturePending(): Promise<void> {
    if (!this.started || this.applying) return;
    if (this.pendingCapture) return this.pendingCapture;
    const revision = this.effects.revision();
    if (revision === this.capturedRevision) return;
    const ids = this.observedRevision === revision && this.dirtyRegions
      ? [...this.dirtyRegions] : undefined;
    this.dirtyRegions = new Set();
    this.pendingCapture = this.captureLocal(ids).then(() => { this.capturedRevision = revision; });
    try { await this.pendingCapture; }
    catch (error) {
      // A failed snapshot must remain dirty; an empty retry would lose the edit.
      this.dirtyRegions = null;
      throw error;
    } finally { this.pendingCapture = null; }
  }

  async captureLocal(dirtyIds?: readonly string[]): Promise<void> {
    if (!this.started || this.applying) return;
    const targeted = dirtyIds !== undefined && dirtyIds.every(id => this.regionCatalog.has(id));
    const regions = targeted ? dirtyIds.map(id => {
      const region = this.regionCatalog.get(id)!;
      const address = parseAddress(region.importAddress ?? region.id);
      if (!address) throw new TypeError(`Invalid collaboration region: ${id}`);
      const text = region.structured && address.kind === 'cell'
        ? readStructuredCell(this.wasm, address)?.text : read(this.wasm, address);
      if (text === undefined) throw new TypeError(`Unsupported collaboration region: ${id}`);
      return { ...region, text };
    }) : await this.effects.regions();
    if (!targeted) {
      this.tableSignatures.clear();
      this.regionCatalog.clear();
    }
    for (const region of regions) {
      this.regionCatalog.set(region.id, region);
      if (this.applying) return;
      const before = this.knownFormats.get(region.id);
      const manifest = this.manifestRegion(region).region;
      const detected = before ? formatOperations(before, manifest) : [];
      const ops = region.structured ? structuredTextFormats(manifest.text, detected) : detected;
      this.knownFormats.set(region.id, manifest);
      if (this.knownTexts.get(region.id) !== region.text || ops.length > 0) {
        this.knownTexts.set(region.id, region.text);
        this.publish('local', region.id, region.text, ops);
      }
    }
  }

  drain(afterSequence: number): readonly CollaborationMutationV1[] {
    return this.mutations.filter((mutation) => mutation.sequence > afterSequence);
  }

  async manifest(): Promise<CollaborationManifestV1> {
    this.tableSignatures.clear();
    const entries = (await this.effects.regions()).map((region) => this.manifestRegion(region));
    const { resources, missing } = inspectRawResources(this.wasm);
    return { schemaVersion: 1, regions: entries.map((entry) => entry.region), resources, missing };
  }

  private manifestRegion(region: CollaborationRegionV1): Readonly<{
    region: CollaborationManifestRegionV1;
    missing: readonly string[];
  }> {
    if (region.structured) return { region: structuredManifest(this.wasm, region, groupRuns), missing: [] };
    const address = parseAddress(region.importAddress ?? region.id);
    if (!address) throw new TypeError(`Invalid collaboration region: ${region.id}`);
    if (address.kind === 'body') {
      const batch = this.wasm.getCollaborationBodyParagraph?.(address.section, address.paragraph);
      const paragraph = batch?.paragraph ?? this.wasm.getParaPropertiesAt(address.section, address.paragraph);
      const runs = groupRuns(region.text, (offset) => this.wasm.getCharPropertiesAt(address.section, address.paragraph, offset), batch?.charRunStarts);
      return { region: { id: region.id, kind: region.kind, text: region.text, paragraph, runs }, missing: [] };
    }
    const batch = this.wasm.getCollaborationStructuredCell?.(address.section, address.paragraph, address.control, address.cell);
    const nativeParagraphs = batch?.supported ? batch.blocks[0]?.paragraphs : undefined;
    const paragraphs = region.text.split('\n').map((text, index) => ({
      id: `${region.id}:p:${index}`, text,
      paragraph: nativeParagraphs?.[index]?.paragraph ?? this.wasm.getCellParaPropertiesAt(address.section, address.paragraph, address.control, address.cell, index),
      runs: groupRuns(text, (offset) => this.wasm.getCellCharPropertiesAt(
        address.section, address.paragraph, address.control, address.cell, index, offset), nativeParagraphs?.[index]?.charRunStarts),
    }));
    const first = paragraphs[0];
    if (!first) throw new TypeError(`Missing cell paragraph: ${region.id}`);
    let start = 0;
    const runs = paragraphs.flatMap((entry) => {
      const mapped = entry.runs.map((run) => ({ ...run, start: run.start + start, end: run.end + start }));
      start += entry.text.length + 1;
      return mapped;
    });
    const tableKey = `${address.section}:${address.paragraph}:${address.control}`;
    let signature = this.tableSignatures.get(tableKey);
    if (signature === undefined) {
      signature = tableTopologySignature(this.wasm, address);
      this.tableSignatures.set(tableKey, signature);
    }
    return {
      region: {
        id: region.id, kind: region.kind, text: region.text, paragraph: first.paragraph, runs, paragraphs,
        table: {
          dimensions: { ...this.wasm.getTableDimensions(address.section, address.paragraph, address.control) },
          cell: { ...this.wasm.getCellInfo(address.section, address.paragraph, address.control, address.cell) },
          signature,
        },
      },
      missing: [],
    };
  }

  private publish(origin: string, regionId: string, text: string, ops?: readonly CollaborationFormatOpV1[]): void {
    this.sequence += 1;
    this.mutations.push({ sequence: this.sequence, origin, regionId, text, ...(ops?.length ? { ops } : {}) });
    if (this.mutations.length > 1_000) this.mutations = this.mutations.slice(-1_000);
  }
}

function parseAddress(regionId: string): Address | null {
  const body = /^b:(\d+):(\d+)$/u.exec(regionId);
  if (body?.[1] !== undefined && body[2] !== undefined) {
    return { kind: 'body', section: Number(body[1]), paragraph: Number(body[2]) };
  }
  const cell = /^c:(\d+):(\d+):(\d+):(\d+)$/u.exec(regionId);
  if (cell?.[1] === undefined || cell[2] === undefined || cell[3] === undefined || cell[4] === undefined) return null;
  return { kind: 'cell', section: Number(cell[1]), paragraph: Number(cell[2]), control: Number(cell[3]), cell: Number(cell[4]), cellParagraph: 0 };
}

function read(wasm: CollaborationLiveWasm, address: Address): string {
  const paragraphs = address.kind === 'body'
    ? [wasm.getTextRange(address.section, address.paragraph, 0, wasm.getParagraphLength(address.section, address.paragraph))]
    : Array.from({ length: wasm.getCellParagraphCount(address.section, address.paragraph, address.control, address.cell) },
      (_, index) => wasm.getTextInCell(address.section, address.paragraph, address.control, address.cell, index, 0,
        wasm.getCellParagraphLength(address.section, address.paragraph, address.control, address.cell, index)));
  return paragraphs.map((paragraph) => {
    const encoded = encodeCollaborationParagraph(paragraph);
    if (encoded === null) throw new TypeError('Unsupported native collaboration paragraph');
    return encoded;
  }).join('\n');
}

function insert(wasm: CollaborationLiveWasm, address: Address, offset: number, text: string): void {
  const nativeText = decodeCollaborationParagraph(text);
  if (address.kind === 'body') wasm.insertText(address.section, address.paragraph, offset, nativeText);
  else wasm.insertTextInCell(address.section, address.paragraph, address.control, address.cell, address.cellParagraph, offset, nativeText);
}

function remove(wasm: CollaborationLiveWasm, address: Address, offset: number, count: number): void {
  if (address.kind === 'body') wasm.deleteText(address.section, address.paragraph, offset, count);
  else wasm.deleteTextInCell(address.section, address.paragraph, address.control, address.cell, address.cellParagraph, offset, count);
}

export function groupRuns(
  text: string,
  properties: (offset: number) => CharProperties,
  runStarts?: readonly number[],
): readonly CollaborationRunV1[] {
  if (text.length === 0) return [];
  // Native boundaries include both style and script changes (language-dependent font).
  // Missing/invalid boundaries fall back to exhaustive reads, never guessed sampling.
  const utf16Offsets = [0];
  for (const character of text) utf16Offsets.push(utf16Offsets.at(-1)! + character.length);
  const scalarLength = utf16Offsets.length - 1;
  const starts = runStarts?.[0] === 0 && runStarts.every((value, index) =>
    Number.isSafeInteger(value) && value >= 0 && value < scalarLength
    && (index === 0 || value > runStarts[index - 1]!))
    ? runStarts : Array.from({ length: scalarLength }, (_, index) => index);
  const runs: CollaborationRunV1[] = [];
  let start = 0;
  let current = properties(0);
  let serialized = JSON.stringify(current);
  for (const scalar of starts) {
    if (scalar === 0) continue;
    const next = properties(scalar), nextSerialized = JSON.stringify(next);
    if (nextSerialized !== serialized) {
      const offset = utf16Offsets[scalar]!;
      runs.push({ start, end: offset, properties: current });
      start = offset;
      current = next;
      serialized = nextSerialized;
    }
  }
  runs.push({ start, end: text.length, properties: current });
  return runs;
}

function scalarOffset(text: string, utf16Offset: number): number | null {
  if (utf16Offset > 0 && utf16Offset < text.length) {
    const previous = text.charCodeAt(utf16Offset - 1);
    const next = text.charCodeAt(utf16Offset);
    if (previous >= 0xd800 && previous <= 0xdbff && next >= 0xdc00 && next <= 0xdfff) return null;
  }
  return [...text.slice(0, utf16Offset)].length;
}

/** Native object anchors and nested-cell separators never receive shared text formatting. */
export function structuredTextFormats(text: string, operations: readonly CollaborationFormatOpV1[]): readonly CollaborationFormatOpV1[] {
  return operations.flatMap(operation => {
    if (operation.scope !== 'character') return [];
    const parts: CollaborationFormatOpV1[] = [];
    const end = operation.offset + operation.count;
    let start = operation.offset;
    for (let offset = start; offset < end; offset++) {
      if (text[offset] !== '\u2029' && text[offset] !== '\ufffc') continue;
      if (offset > start) parts.push({ ...operation, offset: start, count: offset - start });
      start = offset + 1;
    }
    if (start < end) parts.push({ ...operation, offset: start, count: end - start });
    return parts;
  });
}

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

export interface CollaborationLiveWasm extends RawResourceSource, CollaborationFormatWasm {
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

  constructor(wasm: CollaborationLiveWasm, effects: Effects) {
    this.wasm = wasm;
    this.effects = effects;
  }

  async begin(): Promise<void> {
    this.knownTexts = new Map((await this.effects.regions()).map((region) => [region.id, region.text]));
    this.knownFormats.clear();
    for (const region of (await this.manifest()).regions) this.knownFormats.set(region.id, region);
    this.started = true;
  }

  async apply(request: CollaborationApplyOpsRequestV1): Promise<CollaborationApplyOpsResultV1> {
    const region = (await this.effects.regions()).find((candidate) => candidate.id === request.regionId);
    const address = parseAddress(region?.importAddress ?? request.regionId);
    if (!region || !address) return { schemaVersion: 1, ok: false, reason: 'region-not-found' };
    if (region.text !== request.expectedText) {
      return { schemaVersion: 1, ok: false, reason: 'expected-text-mismatch' };
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
        if (op.text.length > 20_000 || !(target.kind === 'cell' ? op.text.split('\n').every(isPlainText) : isPlainText(op.text))) {
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

  async captureLocal(): Promise<void> {
    if (!this.started || this.applying) return;
    for (const region of await this.effects.regions()) {
      if (this.applying) return;
      const manifest = this.manifestRegion(region).region;
      const before = this.knownFormats.get(region.id);
      const ops = before ? formatOperations(before, manifest) : [];
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
    const entries = (await this.effects.regions()).map((region) => this.manifestRegion(region));
    const { resources, missing } = inspectRawResources(this.wasm);
    return { schemaVersion: 1, regions: entries.map((entry) => entry.region), resources, missing };
  }

  private manifestRegion(region: CollaborationRegionV1): Readonly<{
    region: CollaborationManifestRegionV1;
    missing: readonly string[];
  }> {
    const address = parseAddress(region.importAddress ?? region.id);
    if (!address) throw new TypeError(`Invalid collaboration region: ${region.id}`);
    if (address.kind === 'body') {
      const paragraph = this.wasm.getParaPropertiesAt(address.section, address.paragraph);
      const runs = groupRuns(region.text, (offset) => this.wasm.getCharPropertiesAt(address.section, address.paragraph, offset));
      return { region: { id: region.id, kind: region.kind, text: region.text, paragraph, runs }, missing: [] };
    }
    const paragraphs = region.text.split('\n').map((text, index) => ({
      id: `${region.id}:p:${index}`, text,
      paragraph: this.wasm.getCellParaPropertiesAt(address.section, address.paragraph, address.control, address.cell, index),
      runs: groupRuns(text, (offset) => this.wasm.getCellCharPropertiesAt(
        address.section, address.paragraph, address.control, address.cell, index, offset)),
    }));
    const first = paragraphs[0];
    if (!first) throw new TypeError(`Missing cell paragraph: ${region.id}`);
    let start = 0;
    const runs = paragraphs.flatMap((entry) => {
      const mapped = entry.runs.map((run) => ({ ...run, start: run.start + start, end: run.end + start }));
      start += entry.text.length + 1;
      return mapped;
    });
    const signature = tableTopologySignature(this.wasm, address);
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
  return address.kind === 'body'
    ? wasm.getTextRange(address.section, address.paragraph, 0, wasm.getParagraphLength(address.section, address.paragraph))
    : Array.from({ length: wasm.getCellParagraphCount(address.section, address.paragraph, address.control, address.cell) },
      (_, index) => wasm.getTextInCell(address.section, address.paragraph, address.control, address.cell, index, 0,
        wasm.getCellParagraphLength(address.section, address.paragraph, address.control, address.cell, index))).join('\n');
}

function insert(wasm: CollaborationLiveWasm, address: Address, offset: number, text: string): void {
  if (address.kind === 'body') wasm.insertText(address.section, address.paragraph, offset, text);
  else wasm.insertTextInCell(address.section, address.paragraph, address.control, address.cell, address.cellParagraph, offset, text);
}

function remove(wasm: CollaborationLiveWasm, address: Address, offset: number, count: number): void {
  if (address.kind === 'body') wasm.deleteText(address.section, address.paragraph, offset, count);
  else wasm.deleteTextInCell(address.section, address.paragraph, address.control, address.cell, address.cellParagraph, offset, count);
}

export function groupRuns(text: string, properties: (offset: number) => CharProperties): readonly CollaborationRunV1[] {
  if (text.length === 0) return [];
  const runs: CollaborationRunV1[] = [];
  let start = 0;
  let current = properties(0);
  let offset = 0;
  let scalar = 0;
  for (const character of text) {
    const next = properties(scalar);
    if (JSON.stringify(next) !== JSON.stringify(current)) {
      runs.push({ start, end: offset, properties: current });
      start = offset;
      current = next;
    }
    offset += character.length;
    scalar += 1;
  }
  runs.push({ start, end: text.length, properties: current });
  return runs;
}

function isPlainText(value: string): boolean {
  return value.length <= 20_000 && !/[\u0000-\u001f\u007f\ufffc]/u.test(value);
}

function scalarOffset(text: string, utf16Offset: number): number | null {
  if (utf16Offset > 0 && utf16Offset < text.length) {
    const previous = text.charCodeAt(utf16Offset - 1);
    const next = text.charCodeAt(utf16Offset);
    if (previous >= 0xd800 && previous <= 0xdbff && next >= 0xdc00 && next <= 0xdfff) return null;
  }
  return [...text.slice(0, utf16Offset)].length;
}

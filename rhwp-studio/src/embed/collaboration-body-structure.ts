import type { WasmBridge } from '../core/wasm-bridge.ts';
import type { CollaborationTextAdapter } from './collaboration-text-adapter.ts';
import type { CollaborationRegionV1 } from './collaboration-text-contract.ts';

export type BodyStructureEndpoint = Readonly<{ regionId: string; offset: number }>;
export type BodyStructureIntent = Readonly<{
  start: BodyStructureEndpoint;
  end: BodyStructureEndpoint;
  text: string;
}>;
export type BodyStructureAuthority = Readonly<{
  epoch: string;
  policyVersion: number;
  topologyRevision: number;
  durableAck: number;
  revisions: readonly Readonly<{ regionId: string; revision: number }>[];
}>;
export type BodyStructurePlan = Readonly<{
  operation: BodyStructureIntent & Readonly<{
    version: 1; epoch: string; operationId: string; topologyRevision: number; durableAck: number;
    expectedRevisions: readonly Readonly<{ regionId: string; revision: number }>[];
  }>;
  policyVersion: number;
  section: number;
  startParagraph: number;
  endParagraph: number;
  startScalar: number;
  endScalar: number;
  selected: readonly CollaborationRegionV1[];
  before: readonly CollaborationRegionV1[];
  paragraphs: readonly string[];
}>;

export class BodyStructureNativeError extends Error {
  override readonly name = 'BodyStructureNativeError';
  constructor(readonly code: 'INVALID_RANGE' | 'FORBIDDEN' | 'STALE_STATE' | 'UNSUPPORTED_STRUCTURE' | 'INVALID_RECEIPT' | 'NATIVE_FAILURE' | 'COMPOSING') {
    super(`공동편집 문단 변경을 적용하지 않았습니다 (${code}). 기존 내용은 보존됩니다.`);
  }
}

function bodyAddress(region: CollaborationRegionV1): Readonly<{ section: number; paragraph: number }> {
  const match = /^b:(\d+):(\d+)$/u.exec(region.importAddress ?? region.id);
  if (region.kind !== 'body' || !match?.[1] || !match[2]) throw new BodyStructureNativeError('UNSUPPORTED_STRUCTURE');
  return { section: Number(match[1]), paragraph: Number(match[2]) };
}

function scalar(text: string, offset: number): number {
  if (!Number.isSafeInteger(offset) || offset < 0 || offset > text.length
    || (offset > 0 && /[\ud800-\udbff]/u.test(text[offset - 1] ?? '') && /[\udc00-\udfff]/u.test(text[offset] ?? '')))
    throw new BodyStructureNativeError('INVALID_RANGE');
  return [...text.slice(0, offset)].length;
}

export class CollaborationBodyStructureAdapter {
  private readonly prepared = new WeakSet<BodyStructurePlan>();
  private readonly remote = new WeakSet<BodyStructurePlan>();
  constructor(
    private readonly wasm: WasmBridge,
    private readonly catalog: CollaborationTextAdapter,
    private readonly authority: () => BodyStructureAuthority,
    private readonly composing: () => boolean = () => false,
  ) {}

  prepare(intent: BodyStructureIntent, operationId: string): BodyStructurePlan {
    return this.preparePlan(intent, operationId, false);
  }

  prepareRemote(intent: BodyStructureIntent, operationId: string): BodyStructurePlan {
    return this.preparePlan(intent, operationId, true);
  }

  private preparePlan(intent: BodyStructureIntent, operationId: string, remote: boolean): BodyStructurePlan {
    if (this.composing()) throw new BodyStructureNativeError('COMPOSING');
    const state = this.authority();
    const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
    if (!uuid.test(state.epoch) || !uuid.test(operationId)
      || ![state.policyVersion, state.topologyRevision, state.durableAck].every((value) => Number.isSafeInteger(value) && value >= 0)
      || state.policyVersion < 1 || new Set(state.revisions.map((entry) => entry.regionId)).size !== state.revisions.length)
      throw new BodyStructureNativeError('STALE_STATE');
    const before = this.catalog.getRegionsSync();
    const head = before.find((region) => region.id === intent.start.regionId);
    const tail = before.find((region) => region.id === intent.end.regionId);
    if (!head || !tail) throw new BodyStructureNativeError('STALE_STATE');
    const start = bodyAddress(head);
    const end = bodyAddress(tail);
    if (start.section !== end.section || end.paragraph < start.paragraph
      || (head.id === tail.id && intent.end.offset < intent.start.offset)) throw new BodyStructureNativeError('INVALID_RANGE');
    const selected = before.filter((region) => {
      if (region.kind !== 'body') return false;
      const address = bodyAddress(region);
      return address.section === start.section && address.paragraph >= start.paragraph && address.paragraph <= end.paragraph;
    }).sort((a, b) => bodyAddress(a).paragraph - bodyAddress(b).paragraph);
    if (selected.length !== end.paragraph - start.paragraph + 1) throw new BodyStructureNativeError('UNSUPPORTED_STRUCTURE');
    for (const region of selected) {
      if (!remote && !this.wasm.canPasteLiveRegion(region.importAddress ?? region.id, state.epoch)) throw new BodyStructureNativeError('FORBIDDEN');
      if (region.text.includes('\n')) throw new BodyStructureNativeError('UNSUPPORTED_STRUCTURE');
    }
    if (intent.text.length > 200_000 || /[\u0000-\u0009\u000b-\u001f\u007f\ufffc\ud800-\udfff]/u.test(intent.text))
      throw new BodyStructureNativeError('INVALID_RANGE');
    const startScalar = scalar(head.text, intent.start.offset);
    const endScalar = scalar(tail.text, intent.end.offset);
    const paragraphs = (head.text.slice(0, intent.start.offset) + intent.text + tail.text.slice(intent.end.offset)).split('\n');
    if (before.length - selected.length + paragraphs.length > 500 || paragraphs.some((text) => text.length > 20_000))
      throw new BodyStructureNativeError('INVALID_RANGE');
    const expectedRevisions = selected.map((region) => {
      const revision = state.revisions.find((entry) => entry.regionId === region.id);
      if (!revision || !Number.isSafeInteger(revision.revision) || revision.revision < 0) throw new BodyStructureNativeError('STALE_STATE');
      return { ...revision };
    });
    const plan: BodyStructurePlan = Object.freeze({ operation: Object.freeze({ version: 1, epoch: state.epoch, operationId,
      topologyRevision: state.topologyRevision, durableAck: state.durableAck,
      start: Object.freeze({ ...intent.start }), end: Object.freeze({ ...intent.end }), text: intent.text,
      expectedRevisions: Object.freeze(expectedRevisions.map((entry) => Object.freeze(entry))) }),
      policyVersion: state.policyVersion, section: start.section, startParagraph: start.paragraph, endParagraph: end.paragraph,
      startScalar, endScalar, selected: Object.freeze(selected.map((region) => Object.freeze({ ...region }))),
      before: Object.freeze(before.map((region) => Object.freeze({ ...region }))), paragraphs: Object.freeze(paragraphs) });
    this.prepared.add(plan);
    if (remote) this.remote.add(plan);
    return plan;
  }

  cancel(plan: BodyStructurePlan): void { this.prepared.delete(plan); }

  apply(plan: BodyStructurePlan, replacementRegionIds: readonly string[]): Readonly<{
    regions: readonly CollaborationRegionV1[]; removedRegionIds: readonly string[];
    cursor: Readonly<{ sectionIndex: number; paragraphIndex: number; charOffset: number }>;
  }> {
    if (!this.prepared.has(plan)) throw new BodyStructureNativeError('STALE_STATE');
    const fresh = this.preparePlan(plan.operation, plan.operation.operationId, this.remote.has(plan));
    this.cancel(fresh);
    if (JSON.stringify(fresh) !== JSON.stringify(plan)) throw new BodyStructureNativeError('STALE_STATE');
    const first = plan.selected[0];
    if (!first || replacementRegionIds.length !== plan.paragraphs.length || replacementRegionIds[0] !== first.id
      || new Set(replacementRegionIds).size !== replacementRegionIds.length
      || replacementRegionIds.slice(1).some((id) => !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(id)
        || plan.before.some((region) => region.id === id))) throw new BodyStructureNativeError('INVALID_RECEIPT');
    const selectedIds = new Set(plan.selected.map((region) => region.id));
    const delta = plan.paragraphs.length - plan.selected.length;
    const mapping = plan.before.filter((region) => !selectedIds.has(region.id)).map((region) => {
      const parts = (region.importAddress ?? region.id).split(':');
      if (Number(parts[1]) === plan.section && Number(parts[2]) > plan.endParagraph) parts[2] = String(Number(parts[2]) + delta);
      return { id: region.id, importAddress: parts.join(':') };
    });
    for (const [index, id] of replacementRegionIds.entries()) mapping.push({ id, importAddress: `b:${plan.section}:${plan.startParagraph + index}` });
    const restoreCatalog = this.catalog.checkpoint();
    const snapshot = this.wasm.saveSnapshot();
    try {
      this.wasm.replaceLiveBodyRange(plan.section, plan.startParagraph, plan.startScalar,
        plan.endParagraph, plan.endScalar, plan.operation.text, plan.selected.map((region) => region.text), this.remote.has(plan) ? 'remote' : 'local');
      this.catalog.remapStructure(mapping);
      const regions = this.catalog.getRegionsSync();
      if (regions.length !== mapping.length || replacementRegionIds.some((id, index) => regions.find((region) => region.id === id)?.text !== plan.paragraphs[index])
        || plan.before.some((region) => !selectedIds.has(region.id) && regions.find((entry) => entry.id === region.id)?.text !== region.text))
        throw new BodyStructureNativeError('NATIVE_FAILURE');
      this.cancel(plan);
      const inserted = plan.operation.text.split('\n');
      return { regions, removedRegionIds: plan.selected.slice(1).map((region) => region.id),
        cursor: { sectionIndex: plan.section, paragraphIndex: plan.startParagraph + inserted.length - 1,
          charOffset: (inserted.length === 1 ? plan.startScalar : 0) + [...(inserted.at(-1) ?? '')].length } };
    } catch (error) {
      this.wasm.restoreSnapshot(snapshot);
      restoreCatalog();
      throw error;
    } finally { this.wasm.discardSnapshot(snapshot); }
  }
}

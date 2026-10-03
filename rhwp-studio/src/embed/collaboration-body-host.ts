import type { DocumentPosition } from '../core/types.ts';
import type { WasmBridge } from '../core/wasm-bridge.ts';
import type { CollaborationTextAdapter } from './collaboration-text-adapter.ts';
import { bodyStructurePositionTransform } from './collaboration-body-position.ts';
import { BodyStructureNativeError, CollaborationBodyStructureAdapter, type BodyStructureAuthority, type BodyStructurePlan } from './collaboration-body-structure.ts';

export type BodyStructureConfiguration = Readonly<{
  epoch: string; policyVersion: number; topologyRevision: number; durableAck: number;
  regions: readonly Readonly<{ id: string; importAddress: string; text: string; revision: number }>[];
  writableRegionIds: readonly string[];
}>;
export type BodyStructureRequest = Readonly<{ planId: string; operation: BodyStructurePlan['operation'] }>;
export type BodyStructureReceipt = Readonly<{
  operation: BodyStructurePlan['operation']; actorKey: string; durableAck: number; topologyRevision: number;
  regionIds: readonly string[]; removedRegionIds: readonly string[];
}>;
export type BodyStructureResolution = Readonly<{ planId: string; receipt: BodyStructureReceipt | null; reason?: string }>;
export type BodyStructureResult = ReturnType<CollaborationBodyStructureAdapter['apply']> & Readonly<{ applied: boolean; tombstones: readonly string[] }>;
export type BodyStructureRemoteRequest = Readonly<{ before: BodyStructureConfiguration; receipt: BodyStructureReceipt }>;
export type BodyStructureRemoteResult = Readonly<{ status: 'applied' | 'duplicate'; result: BodyStructureResult }>
  | Readonly<{ status: 'deferred'; reason: 'pending' | 'composing' | 'dirty' | 'stale'; recovery: 'reconcile' }>;
export type BodyStructureAction = 'enter' | 'backspace' | 'delete' | 'paste';
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const integer = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
const record = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);
const ids = (value: unknown): value is string[] => Array.isArray(value) && value.length <= 500 && value.every((id) => typeof id === 'string' && uuid.test(id));
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (record(value)) return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`;
  return JSON.stringify(value) ?? 'undefined';
}

export function parseBodyStructureConfiguration(value: unknown): BodyStructureConfiguration {
  if (!record(value) || typeof value.epoch !== 'string' || !uuid.test(value.epoch)
    || !integer(value.policyVersion) || value.policyVersion < 1 || !integer(value.topologyRevision) || !integer(value.durableAck)
    || !ids(value.writableRegionIds) || !Array.isArray(value.regions) || value.regions.length > 500)
    throw new BodyStructureNativeError('STALE_STATE');
  const regions = value.regions.map((region: unknown) => {
    if (!record(region) || typeof region.id !== 'string' || !uuid.test(region.id)
      || typeof region.importAddress !== 'string' || !/^(b:\d+:\d+|c:\d+:\d+:\d+:\d+)$/u.test(region.importAddress)
      || typeof region.text !== 'string' || !integer(region.revision)) throw new BodyStructureNativeError('STALE_STATE');
    return { id: region.id, importAddress: region.importAddress, text: region.text, revision: region.revision };
  });
  if (new Set(regions.map((region) => region.id)).size !== regions.length
    || new Set(regions.map((region) => region.importAddress)).size !== regions.length
    || value.writableRegionIds.some((id) => !regions.some((region) => region.id === id))) throw new BodyStructureNativeError('STALE_STATE');
  return { epoch: value.epoch, policyVersion: value.policyVersion, topologyRevision: value.topologyRevision,
    durableAck: value.durableAck, regions, writableRegionIds: [...value.writableRegionIds] };
}

export class CollaborationBodyHost {
  private configuration: BodyStructureConfiguration | null = null;
  private lastAuthority: Readonly<{ epoch: string; policyVersion: number; topologyRevision: number; durableAck: number }> | null = null;
  private pending: BodyStructurePlan | null = null;
  private configuredRevision = 0;
  private positionTransform: (point: DocumentPosition) => DocumentPosition = point => point;
  private readonly completed = new Map<string, Readonly<{ receipt: string; result: BodyStructureResult }>>();
  private readonly tombstones = new Set<string>();
  private readonly adapter: CollaborationBodyStructureAdapter;
  constructor(private readonly wasm: WasmBridge, private readonly catalog: CollaborationTextAdapter, private readonly composing: () => boolean,
    private readonly revision: () => number = () => 0) {
    this.adapter = new CollaborationBodyStructureAdapter(wasm, catalog, () => this.authority(), composing);
  }
  get awaitingReceipt(): boolean { return this.pending !== null; }
  get enabled(): boolean { return this.configuration !== null; }
  remapAppliedPosition(point: DocumentPosition): DocumentPosition { return this.positionTransform(point); }
  reset(): void {
    if (this.pending) this.adapter.cancel(this.pending);
    this.pending = null; this.configuration = null; this.lastAuthority = null; this.completed.clear();
    this.tombstones.clear();
    this.positionTransform = point => point;
  }
  private authority(): BodyStructureAuthority {
    const config = this.configuration;
    if (!config) throw new BodyStructureNativeError('STALE_STATE');
    return { ...config, revisions: config.regions.map((region) => ({ regionId: region.id, revision: region.revision })) };
  }
  configure(value: unknown): void {
    if (this.pending) throw new BodyStructureNativeError('STALE_STATE');
    const config = parseBodyStructureConfiguration(value);
    if (this.lastAuthority && (config.epoch !== this.lastAuthority.epoch || config.policyVersion < this.lastAuthority.policyVersion
      || config.topologyRevision !== this.lastAuthority.topologyRevision || config.durableAck < this.lastAuthority.durableAck))
      throw new BodyStructureNativeError('STALE_STATE');
    if (!this.lastAuthority && config.topologyRevision !== 0) throw new BodyStructureNativeError('STALE_STATE');
    const native = this.catalog.getRegionsSync();
    // An older server catalog may omit regions newly supported by this engine.
    // Initial hydration maps only its validated subset; remapStructure excludes
    // every extra native region from both the catalog and write permissions.
    // Once authority is installed, catalog membership must remain exact.
    if ((this.lastAuthority && native.length !== config.regions.length) || config.regions.some((region) =>
      native.find((entry) => (entry.importAddress ?? entry.id) === region.importAddress)?.text !== region.text
      || (this.lastAuthority && native.find(entry => entry.id === region.id)?.importAddress !== region.importAddress)))
      throw new BodyStructureNativeError('STALE_STATE');
    this.catalog.remapStructure(config.regions);
    this.configuration = config;
    this.configuredRevision = this.revision();
    this.lastAuthority = config;
    this.wasm.setLivePastePolicy({ epoch: config.epoch, writableRegionIds: config.regions
      .filter((region) => config.writableRegionIds.includes(region.id)).map((region) => region.importAddress) });
  }
  requests(): readonly BodyStructureRequest[] {
    return this.pending ? [{ planId: this.pending.operation.operationId, operation: this.pending.operation }] : [];
  }
  stage(action: BodyStructureAction, position: DocumentPosition,
    selection: Readonly<{ start: DocumentPosition; end: DocumentPosition }> | null, text = ''): BodyStructureRequest | null {
    const start = selection?.start ?? position;
    const end = selection?.end ?? position;
    if (start.parentParaIndex !== undefined || end.parentParaIndex !== undefined || start.isTextBox || end.isTextBox) return null;
    let first = { ...start }; let last = { ...end };
    const cross = first.sectionIndex !== last.sectionIndex || first.paragraphIndex !== last.paragraphIndex;
    switch (action) {
      case 'enter': text = '\n'; break;
      case 'paste': if (!cross && !/[\r\n]/u.test(text)) return null; break;
      case 'backspace':
        if (!cross) {
          if (first.charOffset !== last.charOffset || position.charOffset !== 0 || position.paragraphIndex === 0) return null;
          first = { ...position, paragraphIndex: position.paragraphIndex - 1,
            charOffset: this.wasm.getParagraphLength(position.sectionIndex, position.paragraphIndex - 1) };
        }
        break;
      case 'delete':
        if (!cross) {
          if (first.charOffset !== last.charOffset || position.charOffset !== this.wasm.getParagraphLength(position.sectionIndex, position.paragraphIndex)) return null;
          last = { ...position, paragraphIndex: position.paragraphIndex + 1, charOffset: 0 };
        }
        break;
    }
    const config = this.configuration;
    if (!config || this.pending || this.revision() !== this.configuredRevision) throw new BodyStructureNativeError('STALE_STATE');
    const regions = this.catalog.getRegionsSync();
    if (regions.length !== config.regions.length || regions.some((region) => config.regions.find((entry) => entry.id === region.id)?.text !== region.text))
      throw new BodyStructureNativeError('STALE_STATE');
    const endpoint = (point: DocumentPosition) => {
      const region = regions.find((entry) => (entry.importAddress ?? entry.id) === `b:${point.sectionIndex}:${point.paragraphIndex}`);
      if (!region) throw new BodyStructureNativeError('UNSUPPORTED_STRUCTURE');
      if (!integer(point.charOffset) || point.charOffset > [...region.text].length) throw new BodyStructureNativeError('INVALID_RANGE');
      return { regionId: region.id, offset: [...region.text].slice(0, point.charOffset).join('').length };
    };
    this.pending = this.adapter.prepare({ start: endpoint(first), end: endpoint(last), text }, crypto.randomUUID());
    return { planId: this.pending.operation.operationId, operation: this.pending.operation };
  }
  resolve(value: unknown): BodyStructureResult | null {
    if (!record(value) || typeof value.planId !== 'string') throw new BodyStructureNativeError('INVALID_RECEIPT');
    const signature = canonical(value.receipt);
    const completed = this.completed.get(value.planId);
    if (completed?.receipt === signature) return { ...completed.result, applied: false };
    const plan = this.pending;
    if (!plan || plan.operation.operationId !== value.planId) throw new BodyStructureNativeError('STALE_STATE');
    if (value.receipt === null) { this.adapter.cancel(plan); this.pending = null; return null; }
    if (this.revision() !== this.configuredRevision) throw new BodyStructureNativeError('STALE_STATE');
    const receipt = value.receipt;
    if (!record(receipt) || typeof receipt.actorKey !== 'string' || !receipt.actorKey
      || canonical(receipt.operation) !== canonical(plan.operation)
      || receipt.topologyRevision !== plan.operation.topologyRevision + 1 || receipt.durableAck !== plan.operation.durableAck + 1
      || !ids(receipt.regionIds) || !ids(receipt.removedRegionIds)
      || receipt.regionIds.some(id => this.tombstones.has(id))
      || JSON.stringify(receipt.removedRegionIds) !== JSON.stringify(plan.selected.slice(1).map((region) => region.id)))
      throw new BodyStructureNativeError('INVALID_RECEIPT');
    const result = { ...this.adapter.apply(plan, receipt.regionIds), applied: true,
      tombstones: [...this.tombstones, ...receipt.removedRegionIds] };
    for (const id of receipt.removedRegionIds) this.tombstones.add(id);
    this.lastAuthority = { epoch: plan.operation.epoch, policyVersion: plan.policyVersion,
      topologyRevision: receipt.topologyRevision, durableAck: receipt.durableAck };
    this.wasm.setLivePastePolicy({ epoch: plan.operation.epoch, writableRegionIds: [] });
    this.pending = null;
    this.configuration = null;
    this.completed.set(value.planId, { receipt: signature, result });
    this.positionTransform = bodyStructurePositionTransform(plan, result.cursor);
    return result;
  }

  observeAppliedRevision(): void { this.configuredRevision = this.revision(); }

  applyRemote(value: unknown): BodyStructureRemoteResult {
    if (!record(value) || !record(value.receipt) || !record(value.receipt.operation)) throw new BodyStructureNativeError('INVALID_RECEIPT');
    const receipt = value.receipt;
    const operation = value.receipt.operation;
    if (Object.keys(receipt).sort().join(',') !== 'actorKey,durableAck,operation,regionIds,removedRegionIds,topologyRevision'
      || typeof operation.operationId !== 'string' || !uuid.test(operation.operationId)
      || !record(operation.start) || !record(operation.end) || typeof operation.start.regionId !== 'string'
      || typeof operation.end.regionId !== 'string' || !integer(operation.start.offset) || !integer(operation.end.offset)
      || typeof operation.text !== 'string' || typeof receipt.actorKey !== 'string' || !receipt.actorKey
      || !integer(receipt.durableAck) || !integer(receipt.topologyRevision)
      || !ids(receipt.regionIds) || !ids(receipt.removedRegionIds)) throw new BodyStructureNativeError('INVALID_RECEIPT');
    const signature = canonical(receipt);
    const completed = this.completed.get(operation.operationId);
    if (completed) {
      if (completed.receipt !== signature) throw new BodyStructureNativeError('INVALID_RECEIPT');
      return { status: 'duplicate', result: { ...completed.result, applied: false } };
    }
    const deferred = (reason: 'pending' | 'composing' | 'dirty' | 'stale'): BodyStructureRemoteResult => ({ status: 'deferred', reason, recovery: 'reconcile' });
    if (this.pending) return deferred('pending');
    if (this.composing()) return deferred('composing');
    if (this.revision() !== this.configuredRevision) return deferred('dirty');
    const before = parseBodyStructureConfiguration(value.before);
    const config = this.configuration;
    if (!config || canonical({ ...before, writableRegionIds: [] }) !== canonical({ ...config, writableRegionIds: [] })) return deferred('stale');
    if (operation.epoch !== before.epoch || operation.topologyRevision !== before.topologyRevision
      || operation.durableAck !== before.durableAck) return deferred('stale');
    const native = this.catalog.getRegionsSync();
    if (native.length !== before.regions.length || before.regions.some(region => {
      const entry = native.find(item => item.id === region.id);
      return !entry || entry.text !== region.text || entry.importAddress !== region.importAddress;
    })) return deferred('dirty');
    const plan = this.adapter.prepareRemote({ start: { regionId: operation.start.regionId, offset: operation.start.offset },
      end: { regionId: operation.end.regionId, offset: operation.end.offset }, text: operation.text }, operation.operationId);
    try {
      if (canonical(operation) !== canonical(plan.operation) || receipt.topologyRevision !== before.topologyRevision + 1
        || receipt.durableAck !== before.durableAck + 1
        || receipt.regionIds.some(id => this.tombstones.has(id))
        || canonical(receipt.removedRegionIds) !== canonical(plan.selected.slice(1).map(region => region.id)))
        throw new BodyStructureNativeError('INVALID_RECEIPT');
      const result = { ...this.adapter.apply(plan, receipt.regionIds), applied: true,
        tombstones: [...this.tombstones, ...receipt.removedRegionIds] };
      for (const id of receipt.removedRegionIds) this.tombstones.add(id);
      const replacementIds = receipt.regionIds;
      const configNext = { ...before, topologyRevision: receipt.topologyRevision, durableAck: receipt.durableAck,
        writableRegionIds: [], regions: result.regions.map(region => ({ id: region.id,
          importAddress: region.importAddress ?? region.id, text: region.text,
          revision: replacementIds.includes(region.id) ? (before.regions.find(entry => entry.id === region.id)?.revision ?? -1) + 1
            : before.regions.find(entry => entry.id === region.id)?.revision ?? 0 })) };
      this.configuration = configNext; this.lastAuthority = configNext;
      this.wasm.setLivePastePolicy({ epoch: before.epoch, writableRegionIds: [] });
      this.completed.set(operation.operationId, { receipt: signature, result });
      this.positionTransform = bodyStructurePositionTransform(plan, result.cursor);
      return { status: 'applied', result };
    } finally { this.adapter.cancel(plan); }
  }
}

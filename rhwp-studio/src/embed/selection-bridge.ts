import type {
  EmbedReplaceSelectionResultV1,
  EmbedSelectionSnapshotV1,
} from './rpc-router.ts';

export type HostSelection = {
  readonly text: string;
  readonly signature: string;
  readonly scope: 'body' | 'cell';
};

export interface SelectionEditingPort {
  readSelectionForHost(): HostSelection | null;
  replaceSelectionFromHost(text: string): boolean;
}

type ActiveSelectionSnapshot = {
  readonly snapshot: EmbedSelectionSnapshotV1;
  readonly signature: string;
};

export class SelectionBridge {
  private revision = 0;
  private sequence = 0;
  private active: ActiveSelectionSnapshot | null = null;

  capture(port: SelectionEditingPort): EmbedSelectionSnapshotV1 | null {
    const selection = port.readSelectionForHost();
    if (!selection) {
      this.active = null;
      return null;
    }
    this.sequence += 1;
    const snapshot: EmbedSelectionSnapshotV1 = {
      schemaVersion: 1,
      snapshotId: `selection-${this.revision}-${this.sequence}`,
      revision: this.revision,
      text: selection.text,
      scope: selection.scope,
    };
    this.active = { snapshot, signature: selection.signature };
    return snapshot;
  }

  replace(
    port: SelectionEditingPort,
    snapshotId: string,
    text: string,
  ): EmbedReplaceSelectionResultV1 {
    const active = this.active;
    if (!active || active.snapshot.snapshotId !== snapshotId) {
      return { ok: false, reason: 'snapshot-not-found' };
    }
    if (active.snapshot.revision !== this.revision) {
      return { ok: false, reason: 'stale-document' };
    }
    const current = port.readSelectionForHost();
    if (!current || current.signature !== active.signature) {
      return { ok: false, reason: 'selection-changed' };
    }
    if (!port.replaceSelectionFromHost(text)) {
      return { ok: false, reason: 'unsupported-selection' };
    }
    this.active = null;
    return { ok: true, snapshotId, revision: this.revision };
  }

  noteDocumentMutation(): void {
    this.revision += 1;
  }
}

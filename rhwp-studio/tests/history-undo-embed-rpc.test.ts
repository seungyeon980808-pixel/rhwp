import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { mkdtempSync, rmSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { EMBED_CAPABILITIES } from '../src/embed/protocol.ts';
import { routeEmbedRequest, type EmbedRpcHandlers } from '../src/embed/rpc-router.ts';

const studioRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const runtimeRoot = mkdtempSync(path.join(tmpdir(), 'rhwp-history-undo-'));
const compiler = process.env.RHWP_STUDIO_TSC ?? process.execPath;
const compilerArgs = process.env.RHWP_STUDIO_TSC
  ? []
  : [path.join(studioRoot, 'node_modules', 'typescript', 'bin', 'tsc')];
const compilation = spawnSync(compiler, [
  ...compilerArgs,
  '--ignoreConfig',
  'src/engine/command.ts',
  'src/engine/history.ts',
  'src/engine/input-edit-invalidation.ts',
  '--target', 'ES2022',
  '--module', 'commonjs',
  '--rootDir', 'src',
  '--outDir', runtimeRoot,
  '--skipLibCheck',
  '--noCheck',
], { cwd: studioRoot, encoding: 'utf8' });

assert.equal(
  compilation.status,
  0,
  `history undo runtime compile failed:\n${compilation.stdout}${compilation.stderr}`,
);

const require = createRequire(import.meta.url);
const { SnapshotCommand } = require(path.join(runtimeRoot, 'engine', 'command.js'));
const { CommandHistory } = require(path.join(runtimeRoot, 'engine', 'history.js'));
const inputHandlerSource = readFileSync(path.join(studioRoot, 'src', 'engine', 'input-handler.ts'), 'utf8');

const confirmDialogStub = path.join(runtimeRoot, 'confirm-dialog-stub.mjs');
writeFileSync(confirmDialogStub, 'export function showConfirm() { return Promise.resolve(false); }\n');
const wasmModuleStub = path.join(runtimeRoot, 'wasm-module-stub.mjs');
writeFileSync(
  wasmModuleStub,
  'export default async function init() {}\nexport class HwpDocument {}\nexport function version() { return "test"; }\n',
);
const wrapperDriver = path.join(runtimeRoot, 'approved-apply-undo-driver.mjs');
writeFileSync(wrapperDriver, `
import { registerHooks } from 'node:module';

const srcRoot = ${JSON.stringify(pathToFileURL(path.join(studioRoot, 'src') + path.sep).href)};
const confirmDialogStub = ${JSON.stringify(pathToFileURL(confirmDialogStub).href)};
const wasmModuleStub = ${JSON.stringify(pathToFileURL(wasmModuleStub).href)};
registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === '@/ui/confirm-dialog') {
      return { url: confirmDialogStub, shortCircuit: true };
    }
    if (specifier === '@wasm/rhwp.js') {
      return { url: wasmModuleStub, shortCircuit: true };
    }
    if (specifier.startsWith('@/')) {
      return nextResolve(srcRoot + specifier.slice(2) + '.ts', context);
    }
    if (/^\\.{1,2}\\//.test(specifier) && !/\\.[a-z]+$/.test(specifier)) {
      return nextResolve(specifier + '.ts', context);
    }
    return nextResolve(specifier, context);
  },
});

const [{ InputHandler }, { CommandHistory }, { routeEmbedRequest }] = await Promise.all([
  import(srcRoot + 'engine/input-handler.ts'),
  import(srcRoot + 'engine/history.ts'),
  import(srcRoot + 'embed/rpc-router.ts'),
]);

let documentText = 'original';
let nextSnapshotId = 0;
const snapshots = new Map();
const wasm = {
  saveSnapshot() {
    const id = ++nextSnapshotId;
    snapshots.set(id, documentText);
    return id;
  },
  restoreSnapshot(id) {
    if (!snapshots.has(id)) throw new Error('unknown snapshot');
    documentText = snapshots.get(id);
  },
  discardSnapshot(id) { snapshots.delete(id); },
  applyApprovedTemplateEdits() {
    documentText = 'approved';
    return {
      schemaVersion: 1,
      ok: true,
      updated: 1,
      changedPages: [0],
      warnings: [],
      overflowTargets: [],
      rejectedTargets: [],
    };
  },
};
const position = { sectionIndex: 0, paragraphIndex: 0, charOffset: 0 };
const lifecycle = { applyRefresh: 0, historyJump: 0, afterEdit: 0, cursorMoves: 0 };
const host = Object.create(InputHandler.prototype);
Object.assign(host, {
  history: new CommandHistory(),
  wasm,
  editMode: 'edit',
  pastedFieldEndOutsidePending: false,
  cursor: {
    getPosition: () => ({ ...position }),
    moveTo: () => { lifecycle.cursorMoves += 1; },
    resetPreferredX() {},
  },
  refreshAfterOperation: () => { lifecycle.applyRefresh += 1; },
  flushDeferredPaginationIfNeeded() {},
  prepareTextMutationBeforeCursor: () => false,
  clearTableResizeRuntimeCache() {},
  resetDerivedStateAfterHistoryJump: () => { lifecycle.historyJump += 1; },
  restoreEditContextAfterHistory() {},
  afterEdit: () => { lifecycle.afterEdit += 1; },
});

const request = {
  schemaVersion: 1,
  targets: [{
    targetId: 'approved-cell',
    kind: 'table-cell',
    value: 'approved',
    address: { tableIndex: 0, row: 0, column: 0 },
    expectedTextHash: 'sha256:' + '0'.repeat(64),
    expectedAdjacentLabelDigest: 'sha256:' + '1'.repeat(64),
    maxChars: 20,
    maxLines: 1,
    keepStyle: true,
  }],
};
const handlers = {
  applyApprovedTemplateEdits: async (nextRequest, token) =>
    host.applyApprovedTemplateEditsFromHost(nextRequest, token),
  undo: async () => host.undoFromHost(),
};
const token = 'sha256:' + 'a'.repeat(64);
const applied = await routeEmbedRequest(
  'applyApprovedTemplateEdits',
  { request, preflightToken: token },
  handlers,
);
const afterApply = documentText;
const firstUndo = await routeEmbedRequest('undo', {}, handlers);
const afterFirstUndo = documentText;
const secondUndo = await routeEmbedRequest('undo', {}, handlers);
const afterSecondUndo = documentText;

process.stdout.write('###' + JSON.stringify({
  applied,
  afterApply,
  firstUndo,
  afterFirstUndo,
  secondUndo,
  afterSecondUndo,
  lifecycle,
}) + '###');
`);

const wrapperRun = spawnSync(
  process.execPath,
  ['--experimental-transform-types', '--no-warnings', wrapperDriver],
  { cwd: studioRoot, encoding: 'utf8' },
);
assert.equal(
  wrapperRun.status,
  0,
  `approved-template apply/undo wrapper driver failed:\n${wrapperRun.stdout}\n${wrapperRun.stderr}`,
);
const wrapperCapture = /###([\s\S]*)###/.exec(wrapperRun.stdout);
assert.ok(wrapperCapture, `approved-template apply/undo driver produced no result:\n${wrapperRun.stdout}`);
const wrapperObserved = JSON.parse(wrapperCapture[1]) as {
  applied: { ok: boolean; updated: number };
  afterApply: string;
  firstUndo: { ok: boolean; reason?: string };
  afterFirstUndo: string;
  secondUndo: { ok: boolean; reason?: string };
  afterSecondUndo: string;
  lifecycle: { applyRefresh: number; historyJump: number; afterEdit: number; cursorMoves: number };
};

after(() => {
  rmSync(runtimeRoot, { recursive: true, force: true });
});

test('history undo RPC advertises one narrow capability and forwards no parameters', async () => {
  let calls = 0;
  const handlers = {
    undo: async () => {
      calls += 1;
      return { ok: false, reason: 'empty-history' };
    },
  } as EmbedRpcHandlers;

  assert.equal(EMBED_CAPABILITIES.includes('history-undo-v1'), true);
  assert.deepEqual(
    await routeEmbedRequest('undo', {}, handlers),
    { ok: false, reason: 'empty-history' },
  );
  assert.equal(calls, 1);
  await assert.rejects(
    routeEmbedRequest('undo', { ignored: true }, handlers),
    /does not accept parameters/,
  );
});

test('host and keyboard undo share the normal selection, render, and dirty refresh path', () => {
  assert.match(inputHandlerSource, /undoFromHost\(\)[\s\S]*?this\.handleUndo\(\)/);

  const start = inputHandlerSource.indexOf('private handleUndo(): void');
  const end = inputHandlerSource.indexOf('\n  /** Redo 처리 */', start);
  const block = inputHandlerSource.slice(start, end);
  assert.match(block, /this\.history\.undo\(this\.wasm\)/);
  assert.match(block, /this\.resetDerivedStateAfterHistoryJump\(\)/);
  assert.match(block, /this\.restoreEditContextAfterHistory\(/);
  assert.match(block, /this\.afterEdit\(\)/);
});

test('one approved-template SnapshotCommand is restored by one undo and a second undo is non-destructive', () => {
  let documentText = '원래 값';
  let nextId = 0;
  const snapshots = new Map();
  const wasm = {
    saveSnapshot() {
      const id = ++nextId;
      snapshots.set(id, documentText);
      return id;
    },
    restoreSnapshot(id) {
      documentText = snapshots.get(id);
    },
    discardSnapshot(id) {
      snapshots.delete(id);
    },
  };
  const position = { sectionIndex: 0, paragraphIndex: 0, charOffset: 0 };
  const history = new CommandHistory();
  const command = new SnapshotCommand(
    'applyApprovedTemplateEditsFromHost',
    position,
    position,
    () => {
      documentText = '승인 값';
      return position;
    },
  );

  history.execute(command, wasm);
  assert.equal(documentText, '승인 값');
  assert.deepEqual(history.undo(wasm), position);
  assert.equal(documentText, '원래 값');
  assert.equal(history.undo(wasm), null);
  assert.equal(documentText, '원래 값');
});

test('actual approved-template host wrapper applies once and public RPC undo restores exactly that command', () => {
  assert.equal(wrapperObserved.applied.ok, true);
  assert.equal(wrapperObserved.applied.updated, 1);
  assert.equal(wrapperObserved.afterApply, 'approved');
  assert.deepEqual(wrapperObserved.firstUndo, { ok: true });
  assert.equal(wrapperObserved.afterFirstUndo, 'original');
  assert.deepEqual(wrapperObserved.secondUndo, { ok: false, reason: 'empty-history' });
  assert.equal(wrapperObserved.afterSecondUndo, 'original');
  assert.deepEqual(wrapperObserved.lifecycle, {
    applyRefresh: 1,
    historyJump: 1,
    afterEdit: 1,
    cursorMoves: 1,
  });
});

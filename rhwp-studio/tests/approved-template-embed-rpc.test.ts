import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { EMBED_CAPABILITIES } from '../src/embed/protocol.ts';
import { routeEmbedRequest, type EmbedRpcHandlers } from '../src/embed/rpc-router.ts';

const request = {
  schemaVersion: 1,
  templateId: 'school-form-1',
  expectedStructureDigest: `sha256:${'1'.repeat(64)}`,
  targets: [{
    kind: 'body-placeholder',
    targetId: 'student-name',
    sectionIndex: 0,
    paragraphIndex: 1,
    expectedTextHash: `sha256:${'2'.repeat(64)}`,
    value: '김하늘',
    maxChars: 20,
  }],
};

test('approved template RPC forwards strict request and sha256 preflight token', async () => {
  const calls: unknown[] = [];
  const handlers = {
    inspectApprovedTemplate: async () => ({ schemaVersion: 1 }),
    preflightApprovedTemplateEdits: async (value: Record<string, unknown>) => {
      calls.push(['preflight', value]);
      return { ok: true };
    },
    applyApprovedTemplateEdits: async (value: Record<string, unknown>, token: string) => {
      calls.push(['apply', value, token]);
      return { ok: true };
    },
  } as EmbedRpcHandlers;
  const token = `sha256:${'a'.repeat(64)}`;

  await routeEmbedRequest('inspectApprovedTemplate', {}, handlers);
  await routeEmbedRequest('preflightApprovedTemplateEdits', { request }, handlers);
  await routeEmbedRequest('applyApprovedTemplateEdits', { request, preflightToken: token }, handlers);

  assert.equal(EMBED_CAPABILITIES.includes('approved-template-edit-v1'), true);
  assert.deepEqual(calls, [
    ['preflight', request],
    ['apply', request, token],
  ]);
  await assert.rejects(
    routeEmbedRequest('applyApprovedTemplateEdits', { request, preflightToken: 'stale' }, handlers),
    /sha256 digest/,
  );
});

test('approved template RPC caps target count before reaching WASM', async () => {
  const handlers = {
    preflightApprovedTemplateEdits: async () => ({ ok: true }),
  } as EmbedRpcHandlers;
  await assert.rejects(
    routeEmbedRequest('preflightApprovedTemplateEdits', {
      request: { ...request, targets: Array.from({ length: 101 }, () => request.targets[0]) },
    }, handlers),
    /1\.\.100 targets/,
  );
});

test('reference extraction validates basename, size and options before isolated handler', async () => {
  const calls: unknown[] = [];
  const handlers = {
    extractReferenceText: async (data: Uint8Array, fileName: string, options: unknown) => {
      calls.push([Array.from(data), fileName, options]);
      return { schemaVersion: 1, isolatedPreview: true };
    },
  } as EmbedRpcHandlers;

  await routeEmbedRequest('extractReferenceText', {
    data: new Uint8Array([1, 2]),
    fileName: 'reference.hwpx',
    options: { maxChars: 4000, maxPages: 3 },
  }, handlers);
  assert.equal(EMBED_CAPABILITIES.includes('reference-text-extract-v1'), true);
  assert.deepEqual(calls, [[[1, 2], 'reference.hwpx', { maxChars: 4000, maxPages: 3 }]]);

  await assert.rejects(
    routeEmbedRequest('extractReferenceText', {
      data: new Uint8Array([1]), fileName: '../private.hwp', options: {},
    }, handlers),
    /basename/,
  );
  await assert.rejects(
    routeEmbedRequest('extractReferenceText', {
      data: new Uint8Array([1]), fileName: 'a.hwp', options: { command: 'run' },
    }, handlers),
    /unknown keys/,
  );
});

test('reference extraction uses a temporary document and approved apply uses one snapshot undo', () => {
  const bridge = readFileSync(new URL('../src/core/wasm-bridge.ts', import.meta.url), 'utf8');
  const inputHandler = readFileSync(new URL('../src/engine/input-handler.ts', import.meta.url), 'utf8');
  assert.match(
    bridge,
    /extractReferenceText[\s\S]*?referenceDocument = new HwpDocument\(data\)[\s\S]*?finally[\s\S]*?referenceDocument\?\.free\(\)/,
  );
  assert.doesNotMatch(
    bridge.match(/extractReferenceText[\s\S]*?\n  \}/u)?.[0] ?? '',
    /this\.loadDocument|this\.doc\s*=/,
  );
  assert.match(
    inputHandler,
    /applyApprovedTemplateEditsFromHost[\s\S]*?executeOperation\(\{[\s\S]*?kind: 'snapshot'[\s\S]*?applyApprovedTemplateEdits/,
  );
});

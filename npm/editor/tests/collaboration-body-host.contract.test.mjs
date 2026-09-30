import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { RhwpEditor } from '../index.js';

test('a pending structural request invokes its host callback once across repeated polls', async () => {
  const regionId = randomUUID(); const planId = randomUUID();
  const request = { planId, operation: { version: 1, epoch: randomUUID(), operationId: planId,
    topologyRevision: 0, durableAck: 0, start: { regionId, offset: 1 }, end: { regionId, offset: 1 },
    expectedRevisions: [{ regionId, revision: 0 }], text: '\n' } };
  const editor = new RhwpEditor({ remove() {} }, { supports: () => true,
    request: async (method) => method === 'getBodyStructureRequests' ? [request] : [], destroy() {} });
  const received = [];
  try {
    editor.onBodyStructureRequest((entry) => received.push(entry));
    await editor.flushCollaborationMutations(); await editor.flushCollaborationMutations();
    assert.deepEqual(received, [request]);
  } finally { editor.destroy(); }
});

test('public structural APIs reject misleading success responses and malformed requests from Studio', async () => {
  const editor = new RhwpEditor({ remove() {} }, { supports: () => true,
    request: async () => ({ ok: true }), destroy() {} });
  try {
    await assert.rejects(editor.getBodyStructureRequests(), TypeError);
    await assert.rejects(editor.resolveBodyStructure({ planId: randomUUID(), receipt: {} }), TypeError);
    await assert.rejects(editor.applyRemoteBodyStructure({ before: {}, receipt: {} }), TypeError);
  } finally { editor.destroy(); }
});

test('remote structural deferral preserves its recovery reason across the public transport', async () => {
  const outcome = { status: 'deferred', reason: 'dirty', recovery: 'reconcile' };
  const calls = [];
  const editor = new RhwpEditor({ remove() {} }, { supports: () => true,
    request: async (method, params) => { calls.push({ method, params }); return outcome; }, destroy() {} });
  try {
    const request = { before: { epoch: randomUUID() }, receipt: { operation: { operationId: randomUUID() } } };
    assert.deepEqual(await editor.applyRemoteBodyStructure(request), outcome);
    assert.deepEqual(calls, [{ method: 'applyRemoteBodyStructure', params: request }]);
  } finally { editor.destroy(); }
});

import test from 'node:test';
import assert from 'node:assert/strict';

import { CollaborationTextAdapter } from '../src/embed/collaboration-text-adapter.ts';
import { routeEmbedRequest, type EmbedRpcHandlers } from '../src/embed/rpc-router.ts';

function inspection(paragraphIndex = 2, withNeighbor = false) {
  const value = {
    schemaVersion: 1,
    structureDigest: `sha256:${'1'.repeat(64)}`,
    protection: { status: 'standard' },
    bodyCandidates: [{
      sectionIndex: 0,
      paragraphIndex,
      textHash: `sha256:${'2'.repeat(64)}`,
      adjacentLabelDigest: `sha256:${'3'.repeat(64)}`,
    }],
    tableCells: [{
      tableIndex: 0,
      row: 0,
      col: 1,
      mergedAnchor: { row: 0, col: 1 },
      textHash: `sha256:${'4'.repeat(64)}`,
      adjacentLabelDigest: `sha256:${'5'.repeat(64)}`,
      safe: true,
      resolvedAddress: {
        sectionIndex: 0,
        paragraphIndex: 4,
        controlIndex: 0,
        cellIndex: 1,
      },
    }],
  };
  if (withNeighbor) {
    value.bodyCandidates.push({
      ...value.bodyCandidates[0],
      paragraphIndex: paragraphIndex + 1,
    });
    value.tableCells.push({
      ...value.tableCells[0],
      col: 2,
      mergedAnchor: { row: 0, col: 2 },
      resolvedAddress: { ...value.tableCells[0].resolvedAddress, cellIndex: 2 },
    });
  }
  return value;
}

function createHarness(withNeighbor = false) {
  const bodyTexts = ['alpha', 'delta'];
  const cellTexts = ['beta', 'gamma'];
  let revision = 3;
  let bodyParagraphIndex = 2;
  let structureChanged = false;
  const applied = [];
  const currentInspection = () => {
    const current = inspection(bodyParagraphIndex, withNeighbor);
    if (structureChanged) current.structureDigest = `sha256:${'9'.repeat(64)}`;
    if (withNeighbor) {
      current.bodyCandidates[0].adjacentLabelDigest = `sha256:${bodyTexts[1].padEnd(64, '3').slice(0, 64)}`;
      current.bodyCandidates[1].adjacentLabelDigest = `sha256:${bodyTexts[0].padEnd(64, '3').slice(0, 64)}`;
      current.tableCells[0].adjacentLabelDigest = `sha256:${cellTexts[1].padEnd(64, '5').slice(0, 64)}`;
      current.tableCells[1].adjacentLabelDigest = `sha256:${cellTexts[0].padEnd(64, '5').slice(0, 64)}`;
    }
    if (bodyTexts[0].length === 0) current.bodyCandidates.shift();
    return current;
  };
  const wasm = {
    inspectApprovedTemplate: () => {
      return currentInspection();
    },
    getParagraphLength: (_section, paragraphIndex) =>
      bodyTexts[paragraphIndex === bodyParagraphIndex + 1 ? 1 : 0].length,
    getTextRange: (_section, paragraphIndex) =>
      bodyTexts[paragraphIndex === bodyParagraphIndex + 1 ? 1 : 0],
    getCellParagraphCount: () => 1,
    getCellParagraphLength: (_section, _paragraph, _control, cellIndex) =>
      cellTexts[cellIndex === 2 ? 1 : 0].length,
    getTextInCell: (_section, _paragraph, _control, cellIndex) =>
      cellTexts[cellIndex === 2 ? 1 : 0],
    preflightApprovedTemplateEdits(request) {
      const target = request.targets[0];
      const current = currentInspection();
      const adjacentLabelDigest = target.kind === 'body-placeholder'
        ? current.bodyCandidates.find((body) =>
          body.paragraphIndex === target.paragraphIndex)?.adjacentLabelDigest
        : current.tableCells.find((cell) => cell.col === target.col)?.adjacentLabelDigest;
      if (target.adjacentLabelDigest !== adjacentLabelDigest) return { ok: false };
      if (target.kind === 'table-cell' && target.maxLines < 2) {
        return { ok: false, rejectedTargets: [{ reason: 'confirmed-overflow' }] };
      }
      return { ok: true, preflightToken: `sha256:${'a'.repeat(64)}`, request };
    },
    applyApprovedTemplateEdits(request) {
      applied.push(request);
      const target = request.targets[0];
      if (target.kind === 'body-placeholder') {
        bodyTexts[target.paragraphIndex === bodyParagraphIndex + 1 ? 1 : 0] = target.value;
      }
      else cellTexts[target.col === 2 ? 1 : 0] = target.value;
      return { ok: true, updated: 1 };
    },
  };
  const adapter = new CollaborationTextAdapter(wasm, {
    currentRevision: () => revision,
    afterApply: async () => { revision += 1; },
  });
  return {
    adapter,
    applied,
    setCellText: (text: string) => { cellTexts[0] = text; },
    changeStructure: () => { structureChanged = true; },
    setBodyParagraphIndex: (paragraphIndex: number) => { bodyParagraphIndex = paragraphIndex; },
  };
}

test('geometry retains the whole cell when a local line break excludes its plain text', async () => {
  const { adapter, setCellText } = createHarness();
  await adapter.getRegions();
  setCellText('beta\u000bgamma');
  assert.equal((await adapter.getRegions()).some(region => region.id === 'c:0:4:0:1'), false);
  assert.deepEqual(adapter.getGeometryRegions().find(region => region.id === 'c:0:4:0:1'),
    { id: 'c:0:4:0:1', kind: 'cell', label: 'Cell 1.5.1.2', text: '' });
  assert.equal((await adapter.getRegions()).some(region => region.id === 'c:0:4:0:1'), false);
});

test('geometry does not retain addresses after an unmapped structural change', async () => {
  const { adapter, changeStructure } = createHarness();
  await adapter.getRegions();
  changeStructure();
  assert.deepEqual(adapter.getGeometryRegions(), []);
});

test('collaboration adapter inspects only frozen safe plain body and single-paragraph cell regions', async () => {
  // Given: approved-template inspection with one safe body and one safe cell.
  const { adapter } = createHarness();

  // When: regions are inspected twice.
  const first = await adapter.getRegions();
  const second = await adapter.getRegions();

  // Then: structural IDs and labels are deterministic across inspections.
  assert.deepEqual(first, [
    { id: 'b:0:2', kind: 'body', label: 'Body 1.3', text: 'alpha' },
    { id: 'c:0:4:0:1', kind: 'cell', label: 'Cell 1.5.1.2', text: 'beta' },
  ]);
  assert.deepEqual(second, first);
});

test('collaboration adapter rejects stale expected text without mutating WASM', async () => {
  // Given: a frozen body region whose current text is alpha.
  const { adapter, applied } = createHarness();
  await adapter.getRegions();

  // When: a stale replacement is requested.
  const result = await adapter.applyText({
    regionId: 'b:0:2', expectedText: 'stale', text: 'changed',
  });

  // Then: mismatch is explicit and no engine apply occurs.
  assert.deepEqual(result, {
    schemaVersion: 1, ok: false, reason: 'expected-text-mismatch',
  });
  assert.equal(applied.length, 0);
});

test('collaboration adapter rejects explicit line breaks without mutating WASM', async () => {
  // Given: a frozen cell region whose current text is beta.
  const { adapter, applied } = createHarness();
  await adapter.getRegions();

  // When: a replacement contains an explicit paragraph break.
  const result = await adapter.applyText({
    regionId: 'c:0:4:0:1', expectedText: 'beta', text: 'first\nsecond',
  });

  // Then: the single-paragraph contract rejects it before preflight or mutation.
  assert.deepEqual(result, {
    schemaVersion: 1, ok: false, reason: 'unsupported-text',
  });
  assert.equal(applied.length, 0);
});

test('collaboration adapter performs real approved-template WASM apply and returns refreshed text', async () => {
  // Given: a current body region.
  const { adapter, applied } = createHarness();
  await adapter.getRegions();

  // When: matching expected text is replaced.
  const result = await adapter.applyText({
    regionId: 'b:0:2', expectedText: 'alpha', text: 'changed',
  });

  // Then: the engine request uses the frozen address and the result reflects refreshed text.
  assert.equal(applied.length, 1);
  assert.equal(applied[0].targets[0].sectionIndex, 0);
  assert.equal(applied[0].targets[0].paragraphIndex, 2);
  assert.deepEqual(result, {
    schemaVersion: 1,
    ok: true,
    region: { id: 'b:0:2', kind: 'body', label: 'Body 1.3', text: 'changed' },
    revision: 4,
  });
});

test('collaboration adapter permits visual cell wrapping across body and cell edits in either order', async () => {
  // Given: two replicas with the same frozen body and cell regions.
  const bodyFirst = createHarness();
  const cellFirst = createHarness();
  await bodyFirst.adapter.getRegions();
  await cellFirst.adapter.getRegions();

  // When: each replica applies the same edits in a different supported-region order.
  const bodyThenCell = [
    await bodyFirst.adapter.applyText({
      regionId: 'b:0:2', expectedText: 'alpha', text: 'body changed',
    }),
    await bodyFirst.adapter.applyText({
      regionId: 'c:0:4:0:1', expectedText: 'beta', text: 'cell changed',
    }),
  ];
  const cellThenBody = [
    await cellFirst.adapter.applyText({
      regionId: 'c:0:4:0:1', expectedText: 'beta', text: 'cell changed',
    }),
    await cellFirst.adapter.applyText({
      regionId: 'b:0:2', expectedText: 'alpha', text: 'body changed',
    }),
  ];

  // Then: both orderings remain supported and converge to the same region text.
  assert.equal(bodyThenCell.every((result) => result.ok), true);
  assert.equal(cellThenBody.every((result) => result.ok), true);
  assert.deepEqual(await bodyFirst.adapter.getRegions(), await cellFirst.adapter.getRegions());
});

test('collaboration adapter permits visual wrapping for repeated edits to the same cell', async () => {
  // Given: a frozen safe cell region.
  const { adapter } = createHarness();
  await adapter.getRegions();

  // When: the same cell is changed twice using each returned text as the next expectation.
  const first = await adapter.applyText({
    regionId: 'c:0:4:0:1', expectedText: 'beta', text: 'first cell change',
  });
  const second = await adapter.applyText({
    regionId: 'c:0:4:0:1', expectedText: 'first cell change', text: 'second cell change',
  });

  // Then: both operations succeed without weakening stale expected-text rejection.
  assert.equal(first.ok, true);
  assert.deepEqual(second, {
    schemaVersion: 1,
    ok: true,
    region: {
      id: 'c:0:4:0:1', kind: 'cell', label: 'Cell 1.5.1.2', text: 'second cell change',
    },
    revision: 5,
  });
});

test('collaboration adapter refreshes a neighboring frozen cell digest after mutation', async () => {
  // Given: two adjacent frozen cells whose native preflight digests include each other's text.
  const { adapter } = createHarness(true);
  const regions = await adapter.getRegions();
  const first = regions.find((region) => region.id === 'c:0:4:0:1');
  const neighbor = regions.find((region) => region.id === 'c:0:4:0:2');
  assert.ok(first);
  assert.ok(neighbor);

  // When: the first cell changes before its neighbor.
  const changedFirst = await adapter.applyText({
    regionId: first.id, expectedText: first.text, text: 'first changed',
  });
  const changedNeighbor = await adapter.applyText({
    regionId: neighbor.id, expectedText: neighbor.text, text: 'neighbor changed',
  });

  // Then: both frozen addresses remain supported without weakening text expectations.
  assert.equal(changedFirst.ok, true);
  assert.equal(changedNeighbor.ok, true);
});

test('collaboration adapter refreshes adjacent body digests deterministically on both replicas', async () => {
  // Given: two replicas with the same pair of adjacent frozen body paragraphs.
  const firstReplica = createHarness(true);
  const secondReplica = createHarness(true);
  const firstRegions = await firstReplica.adapter.getRegions();
  const secondRegions = await secondReplica.adapter.getRegions();
  const bodyA = firstRegions.find((region) => region.id === 'b:0:2');
  const bodyB = firstRegions.find((region) => region.id === 'b:0:3');
  assert.ok(bodyA);
  assert.ok(bodyB);

  // When: each replica applies the same neighboring edits in the opposite order.
  const forward = [
    await firstReplica.adapter.applyText({
      regionId: bodyA.id, expectedText: bodyA.text, text: 'body A changed',
    }),
    await firstReplica.adapter.applyText({
      regionId: bodyB.id, expectedText: bodyB.text, text: 'body B changed',
    }),
  ];
  const secondBodyA = secondRegions.find((region) => region.id === bodyA.id);
  const secondBodyB = secondRegions.find((region) => region.id === bodyB.id);
  assert.ok(secondBodyA);
  assert.ok(secondBodyB);
  const reverse = [
    await secondReplica.adapter.applyText({
      regionId: secondBodyB.id, expectedText: secondBodyB.text, text: 'body B changed',
    }),
    await secondReplica.adapter.applyText({
      regionId: secondBodyA.id, expectedText: secondBodyA.text, text: 'body A changed',
    }),
  ];

  // Then: both operation orders succeed and expose the same frozen regions and text.
  assert.equal([...forward, ...reverse].every((result) => result.ok), true);
  assert.deepEqual(
    await firstReplica.adapter.getRegions(),
    await secondReplica.adapter.getRegions(),
  );
});

test('collaboration adapter keeps an emptied body paragraph address frozen', async () => {
  // Given: a frozen non-empty body region from the original inspection.
  const { adapter } = createHarness();
  await adapter.getRegions();

  // When: the body text is replaced with an empty string.
  const applied = await adapter.applyText({
    regionId: 'b:0:2', expectedText: 'alpha', text: '',
  });
  const regions = await adapter.getRegions();

  // Then: the same structural region remains available with empty text.
  assert.equal(applied.ok, true);
  assert.deepEqual(regions.find((region) => region.id === 'b:0:2'), {
    id: 'b:0:2', kind: 'body', label: 'Body 1.3', text: '',
  });
});

test('collaboration adapter resets its frozen catalog for a newly hydrated document', async () => {
  // Given: the first hydrated document froze body paragraph two.
  const { adapter, setBodyParagraphIndex } = createHarness();
  const first = await adapter.getRegions();

  // When: hydration changes the structure and resets the collaboration catalog.
  setBodyParagraphIndex(9);
  adapter.resetCatalog();
  const second = await adapter.getRegions();

  // Then: inspection exposes only the new frozen structural address.
  assert.equal(first.some((region) => region.id === 'b:0:2'), true);
  assert.equal(second.some((region) => region.id === 'b:0:9'), true);
  assert.equal(second.some((region) => region.id === 'b:0:2'), false);
});

function rpcHandlers(): EmbedRpcHandlers {
  let active = false;
  return {
    ready: async () => true,
    loadFile: async () => ({ pageCount: 1 }),
    pageCount: async () => 1,
    getRendererDiagnostics: async (page) => ({
      schemaVersion: 1,
      request: null,
      initialized: true,
      initializationError: null,
      effectiveBackend: 'canvas2d',
      backendFallbackReason: null,
      selection: null,
      page: { index: page, canvaskit: null },
    }),
    getPageSvg: async () => '<svg/>',
    exportHwp: async () => new Uint8Array(),
    exportHwpx: async () => new Uint8Array(),
    exportHml: async () => new Uint8Array(),
    getHmlSaveState: async () => ({ sourceFormat: 'hwp', hmlSavable: false, blockers: [] }),
    exportHwpVerify: async () => ({ recovered: true }),
    notifySaved: async () => ({ ok: true, wasDirty: false }),
    collaborationActive: () => active,
    beginCollaboration: async () => {
      active = true;
      return { schemaVersion: 1, readOnly: true };
    },
    getCollaborationRegions: async () => [],
    applyCollaborationText: async () => ({
      schemaVersion: 1, ok: false, reason: 'region-not-found',
    }),
    undo: async () => ({ ok: true }),
    replaceSelection: async () => ({ ok: false, reason: 'snapshot-not-found' }),
    fillFields: async () => ({ ok: true, updated: 0 }),
    applyApprovedTemplateEdits: async () => ({}),
  };
}

test('collaboration RPC permanently denies every pre-existing host mutation but permits hydration', async () => {
  // Given: collaboration mode has begun for the iframe session.
  const handlers = rpcHandlers();
  await routeEmbedRequest('beginCollaboration', {}, handlers);

  // When: hydration succeeds and existing mutation RPCs are requested afterward.
  const hydrated = await routeEmbedRequest(
    'loadFile',
    { data: new Uint8Array([1]), fileName: 'document.hwp' },
    handlers,
  );
  const mutations = [
    routeEmbedRequest('undo', {}, handlers),
    routeEmbedRequest('replaceSelection', { snapshotId: 's', text: 'x' }, handlers),
    routeEmbedRequest('fillFields', { entries: [] }, handlers),
    routeEmbedRequest('applyApprovedTemplateEdits', { request: {} }, handlers),
    routeEmbedRequest('notifySaved', {}, handlers),
  ];

  // Then: all mutations reject at the router while document hydration succeeds.
  for (const mutation of mutations) {
    await assert.rejects(mutation, /disabled in collaboration mode/i);
  }
  assert.deepEqual(hydrated, { pageCount: 1 });
});

test('ordinary embed mutation remains available when collaboration mode is off', async () => {
  // Given: a normal desktop embed session that never began collaboration.
  const handlers = rpcHandlers();

  // When: the existing undo RPC is called.
  const result = await routeEmbedRequest('undo', {}, handlers);

  // Then: the existing mutation handler runs unchanged.
  assert.deepEqual(result, { ok: true });
});


test('single-region text reads reuse the approved catalog and return current text only', async () => {
  const harness = createHarness(true);
  const regions = harness.adapter.getRegionsSync();
  const cell = regions.find(region => region.kind === 'cell')!;
  harness.setCellText('current local draft');
  assert.equal(harness.adapter.getRegionText(cell.id)?.text, 'current local draft');
  assert.equal(harness.adapter.getRegionText('c:99:99:99:99'), null);
  assert.equal(harness.applied.length, 0);
});

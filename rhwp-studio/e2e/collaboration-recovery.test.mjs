import { resolve } from 'path';

import { assert, runTest, setTestCase } from './helpers.mjs';

const EDITOR_MODULE_PATH = resolve(import.meta.dirname, '../../npm/editor/index.js').replace(/\\/g, '/');
const EDITOR_MODULE_URL = EDITOR_MODULE_PATH.startsWith('/')
  ? `/@fs${EDITOR_MODULE_PATH}`
  : `/@fs/${EDITOR_MODULE_PATH}`;
const VITE_URL = process.env.VITE_URL || 'http://127.0.0.1:7713';
const DRAFT_ID = 'collaboration-recovery-persisted-candidate';

runTest('collaboration lifetime isolates persisted autosave recovery', async ({ page }) => {
  setTestCase('standalone recovery remains available');
  await page.goto(`${VITE_URL}/@vite/client`, { waitUntil: 'domcontentloaded' });
  await seedRecoveryDraft(page);
  await page.goto(`${VITE_URL}/`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('.recovery-dialog', { timeout: 15_000 });
  const standaloneTitle = await page.$eval('.recovery-dialog .dialog-title', (element) => element.textContent);
  assert(standaloneTitle?.includes('문서 복구'), 'standalone editor still offers persisted recovery');
  await page.evaluate(() => {
    const later = [...document.querySelectorAll('.recovery-dialog .dialog-btn')]
      .find((button) => button.textContent?.trim() === '나중에');
    if (!(later instanceof HTMLButtonElement)) throw new Error('Later button not found');
    later.click();
  });
  assert(await recoveryDraftExists(page), 'choosing Later preserves the stored recovery candidate');

  setTestCase('collaboration dismisses recovery without deleting it');
  await page.goto(`${VITE_URL}/@vite/client`, { waitUntil: 'domcontentloaded' });
  const result = await page.evaluate(async ({ draftId, editorModuleUrl }) => {
    const { createEditor } = await import(editorModuleUrl);
    const host = document.createElement('div');
    host.style.cssText = 'width: 1024px; height: 900px';
    document.body.appendChild(host);
    const editor = await createEditor(host, {
      studioUrl: `${location.origin}/`,
      renderer: 'canvas2d',
      requestTimeoutMs: 120_000,
    });
    const iframeWindow = editor.element.contentWindow;
    iframeWindow.__autosaveManager.updateSchedule({ idleDelayMs: 10, recoveryIntervalMs: 10 });

    const began = await editor.beginCollaboration();
    const source = await fetch('/samples/biz_plan.hwp').then((response) => response.arrayBuffer());
    const loaded = await editor.loadFile(source, 'server-original.hwp', {
      skipUnsavedGuard: true,
      suppressDialogs: true,
    });
    const regions = await editor.getCollaborationRegions();
    const body = regions.find((region) => region.kind === 'body' && region.text.length > 0);
    if (!body) throw new Error('No supported body region');
    const applied = await editor.applyCollaborationText({
      regionId: body.id,
      expectedText: body.text,
      text: `${body.text} R`,
    });
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 100));

    const draftIds = await new Promise((resolveIds, reject) => {
      const request = indexedDB.open('rhwpStudioAutosave', 1);
      request.onerror = () => reject(request.error);
      request.onsuccess = () => {
        const db = request.result;
        const transaction = db.transaction('drafts', 'readonly');
        const getAllKeys = transaction.objectStore('drafts').getAllKeys();
        getAllKeys.onerror = () => reject(getAllKeys.error);
        getAllKeys.onsuccess = () => {
          resolveIds(getAllKeys.result.map(String));
          db.close();
        };
      };
    });
    const observable = {
      began,
      pageCount: loaded.pageCount,
      regionCount: regions.length,
      applied,
      collaborationReadOnly: iframeWindow.document.body.dataset.collaborationReadOnly,
      recoveryDialogCount: iframeWindow.document.querySelectorAll('.recovery-dialog').length,
      draftIds,
      persistedDraftId: draftId,
      canvasCount: iframeWindow.document.querySelectorAll('#scroll-container canvas').length,
    };
    editor.destroy();
    host.remove();
    return observable;
  }, { draftId: DRAFT_ID, editorModuleUrl: EDITOR_MODULE_URL });

  console.log(`  result: ${JSON.stringify(result)}`);
  assert(result.began.readOnly === true, 'collaboration entered permanent read-only mode');
  assert(result.pageCount > 0 && result.regionCount > 0 && result.canvasCount > 0,
    'the server-provided original rendered with inspectable regions');
  assert(result.applied.ok === true, 'the authoritative collaboration apply succeeded');
  assert(result.collaborationReadOnly === 'true', 'native collaboration read-only marker remains active');
  assert(result.recoveryDialogCount === 0, 'no persisted recovery modal covers the replica canvas');
  assert(result.draftIds.length === 1 && result.draftIds[0] === result.persistedDraftId,
    'collaboration neither deletes the stored recovery nor creates a competing local draft');
}, { skipLoadApp: true });

async function seedRecoveryDraft(page) {
  await page.evaluate(async (draftId) => {
    const bytes = new Uint8Array(await fetch('/samples/biz_plan.hwp').then((response) => response.arrayBuffer()));
    const deletion = indexedDB.deleteDatabase('rhwpStudioAutosave');
    await new Promise((resolveDelete) => {
      deletion.onsuccess = deletion.onerror = deletion.onblocked = () => resolveDelete();
    });
    const request = indexedDB.open('rhwpStudioAutosave', 1);
    const db = await new Promise((resolveDb, reject) => {
      request.onupgradeneeded = () => {
        if (!request.result.objectStoreNames.contains('drafts')) {
          request.result.createObjectStore('drafts', { keyPath: 'id' });
        }
      };
      request.onerror = () => reject(request.error);
      request.onsuccess = () => resolveDb(request.result);
    });
    await new Promise((resolveWrite, reject) => {
      const transaction = db.transaction('drafts', 'readwrite');
      transaction.objectStore('drafts').put({
        id: draftId,
        fileName: 'hwp_table_test.hwp',
        sourceFormat: 'hwp',
        savedAt: Date.now(),
        byteLength: bytes.byteLength,
        data: bytes.buffer,
        dirtyReason: 'persisted-before-collaboration',
      });
      transaction.oncomplete = () => resolveWrite();
      transaction.onerror = () => reject(transaction.error);
    });
    db.close();
  }, DRAFT_ID);
}

async function recoveryDraftExists(page) {
  return page.evaluate(async (draftId) => {
    const request = indexedDB.open('rhwpStudioAutosave', 1);
    const db = await new Promise((resolveDb, reject) => {
      request.onerror = () => reject(request.error);
      request.onsuccess = () => resolveDb(request.result);
    });
    const found = await new Promise((resolveFound, reject) => {
      const transaction = db.transaction('drafts', 'readonly');
      const get = transaction.objectStore('drafts').get(draftId);
      get.onsuccess = () => resolveFound(Boolean(get.result));
      get.onerror = () => reject(get.error);
    });
    db.close();
    return found;
  }, DRAFT_ID);
}

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { loadConfigFromFile } from 'vite';

import { AutosaveManager, type AutosaveStoreLike } from '../src/recovery/autosave-manager.ts';

const STUDIO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

function createLogCapture() {
  const argumentsList: unknown[][] = [];
  return {
    logger: {
      debug(...args: unknown[]) {
        argumentsList.push(args);
      },
      warn(...args: unknown[]) {
        argumentsList.push(args);
      },
    },
    render() {
      return argumentsList
        .flat()
        .map((value) => (value instanceof Error ? value.message : String(value)))
        .join('\n');
    },
  };
}

test('Studio document and field payloads are not passed to console logging', () => {
  // Given: the source modules that previously logged document and field payloads.
  const historySource = readFileSync(resolve(STUDIO_ROOT, 'src/ui/history-dialog.ts'), 'utf8');
  const editSource = readFileSync(resolve(STUDIO_ROOT, 'src/command/commands/edit.ts'), 'utf8');
  const mainSource = readFileSync(resolve(STUDIO_ROOT, 'src/main.ts'), 'utf8');

  // When/Then: no console level can serialize the sensitive objects.
  assert.doesNotMatch(
    historySource,
    /console\.(?:log|debug|info|warn|error)\([^;]*(?:diffItems|leftPreview|rightPreview)/s,
  );
  assert.doesNotMatch(
    editSource,
    /console\.(?:log|debug|info|warn|error)\([^;]*(?:\bfi\b|\bprops\b|\bnewProps\b|\berr(?:or)?\b)/s,
  );
  assert.doesNotMatch(
    mainSource,
    /console\.warn\(\s*['"]\[autosave\] 복구 후보 확인 실패:[^)]*,\s*error\s*\)/,
  );
});

test('AutosaveManager does not expose a filename after a successful save', async () => {
  // Given: a private filename and an observable logger.
  const privateFileName = 'student-private-record.hwp';
  const capture = createLogCapture();
  const store: AutosaveStoreLike = {
    async saveDraft() {},
    async deleteDraft() {},
  };
  const manager = new AutosaveManager({
    exportBytes: () => new Uint8Array([1]),
    schedule: { recoveryEnabled: false, idleEnabled: false },
    store,
    logger: capture.logger,
  });
  await manager.beginDocument({ fileName: privateFileName, sourceFormat: 'hwp' });

  // When: the draft is saved successfully.
  await manager.flushNow('manual');

  // Then: the filename does not enter the logger arguments.
  assert.doesNotMatch(capture.render(), /student-private-record/);
});

test('AutosaveManager does not expose a filename from a storage error', async () => {
  // Given: a private filename and a store error that repeats it.
  const privateFileName = 'student-private-record.hwp';
  const capture = createLogCapture();
  const store: AutosaveStoreLike = {
    async saveDraft() {
      throw new Error(`failed to save ${privateFileName}`);
    },
    async deleteDraft() {},
  };
  const manager = new AutosaveManager({
    exportBytes: () => new Uint8Array([1]),
    schedule: { recoveryEnabled: false, idleEnabled: false },
    store,
    logger: capture.logger,
  });

  // When: autosave reaches the failing persistence boundary.
  await manager.beginDocument({ fileName: privateFileName, sourceFormat: 'hwp' });
  await manager.flushNow('manual');

  // Then: neither the filename nor the raw error enters the logger arguments.
  assert.doesNotMatch(capture.render(), /student-private-record/);
});

test('Studio production minifier drops console calls and debugger statements', async () => {
  // Given: Vite loads the real Studio production configuration.
  const loaded = await loadConfigFromFile(
    { command: 'build', mode: 'production' },
    resolve(STUDIO_ROOT, 'vite.config.ts'),
    STUDIO_ROOT,
  );

  // When: the Rolldown/Oxc output minifier policy is read.
  assert.ok(loaded);
  const output = loaded.config.build?.rolldownOptions?.output;

  // Then: production output is configured to remove both diagnostic surfaces.
  assert.ok(output);
  assert.ok(!Array.isArray(output));
  const minify = output.minify;
  assert.equal(typeof minify, 'object');
  assert.ok(minify !== null);
  assert.equal(typeof minify.compress, 'object');
  assert.ok(minify.compress !== null);
  assert.equal(minify.compress.dropConsole, true);
  assert.equal(minify.compress.dropDebugger, true);
});

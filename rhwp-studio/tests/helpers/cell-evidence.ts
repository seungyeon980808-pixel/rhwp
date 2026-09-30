import { after } from 'node:test';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';

export async function cellEvidenceDirectory(name: string): Promise<URL> {
  const retainedRoot = process.env.OURDOCS_CELL_EVIDENCE_DIR;
  const directory = retainedRoot ? resolve(retainedRoot, name) : await mkdtemp(join(tmpdir(), `rhwp-${name}-`));
  if (retainedRoot) await mkdir(directory, { recursive: true });
  else after(() => rm(directory, { recursive: true, force: true }));
  return pathToFileURL(`${directory}${sep}`);
}

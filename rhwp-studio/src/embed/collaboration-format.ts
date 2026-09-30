import type { CollaborationFormatOpV1, CollaborationManifestRegionV1 } from './collaboration-live-contract.ts';

export function parseFormatOperation(value: Record<string, unknown>): CollaborationFormatOpV1 | null {
  if (value.type !== 'format' || value.version !== 1 || typeof value.offset !== 'number'
    || !Number.isSafeInteger(value.offset) || value.offset < 0 || typeof value.count !== 'number'
    || !Number.isSafeInteger(value.count) || value.count < 0
    || Object.keys(value).some((key) => !['type', 'version', 'offset', 'count', 'scope', 'marks'].includes(key))) return null;
  const marks = value.marks;
  if (typeof marks !== 'object' || marks === null || Array.isArray(marks)) return null;
  const base = { type: 'format', version: 1, offset: value.offset, count: value.count } as const;
  if (value.scope === 'paragraph' && 'alignment' in marks && typeof marks.alignment === 'string'
    && Object.keys(marks).length === 1 && ['justify', 'left', 'right', 'center', 'distribute', 'split'].includes(marks.alignment))
    return { ...base, scope: 'paragraph', marks: { alignment: marks.alignment } };
  if (value.scope !== 'character' || value.count === 0 || Object.keys(marks).length === 0
    || Object.keys(marks).some((key) => !['bold', 'italic', 'textColor'].includes(key))) return null;
  if ('bold' in marks && typeof marks.bold !== 'boolean') return null;
  if ('italic' in marks && typeof marks.italic !== 'boolean') return null;
  if ('textColor' in marks && (typeof marks.textColor !== 'string' || !/^#[0-9a-f]{6}$/iu.test(marks.textColor))) return null;
  return { ...base, scope: 'character', marks: {
    ...('bold' in marks && typeof marks.bold === 'boolean' ? { bold: marks.bold } : {}),
    ...('italic' in marks && typeof marks.italic === 'boolean' ? { italic: marks.italic } : {}),
    ...('textColor' in marks && typeof marks.textColor === 'string' ? { textColor: marks.textColor } : {}),
  } };
}

export function formatOperations(before: CollaborationManifestRegionV1, after: CollaborationManifestRegionV1): readonly CollaborationFormatOpV1[] {
  const operations: CollaborationFormatOpV1[] = [];
  let prefix = 0;
  while (prefix < before.text.length && prefix < after.text.length && before.text[prefix] === after.text[prefix]) prefix += 1;
  if (prefix > 0 && /[\udc00-\udfff]/u.test(before.text[prefix] ?? '')) prefix -= 1;
  let suffix = 0;
  while (suffix < before.text.length - prefix && suffix < after.text.length - prefix
    && before.text[before.text.length - suffix - 1] === after.text[after.text.length - suffix - 1]) suffix += 1;
  if (suffix > 0 && /[\udc00-\udfff]/u.test(before.text[before.text.length - suffix] ?? '')) suffix -= 1;
  const delta = after.text.length - before.text.length;
  const oldRuns = before.text === after.text ? before.runs : before.runs.flatMap((run) => [
    ...(run.start < prefix ? [{ ...run, end: Math.min(run.end, prefix) }] : []),
    ...(run.end > before.text.length - suffix ? [{ ...run,
      start: Math.max(run.start, before.text.length - suffix) + delta, end: run.end + delta }] : []),
  ]);
  for (const run of after.runs) {
    const boundaries = new Set([run.start, run.end]);
    for (const old of oldRuns) {
      if (old.start > run.start && old.start < run.end) boundaries.add(old.start);
      if (old.end > run.start && old.end < run.end) boundaries.add(old.end);
    }
    const points = [...boundaries].sort((a, b) => a - b);
    for (const [index, start] of points.entries()) {
      const end = points[index + 1];
      if (end === undefined) continue;
      const old = oldRuns.find((entry) => entry.start <= start && entry.end > start)?.properties;
      const marks = {
        ...(old?.bold !== run.properties.bold ? { bold: run.properties.bold ?? false } : {}),
        ...(old?.italic !== run.properties.italic ? { italic: run.properties.italic ?? false } : {}),
        ...(old?.textColor !== run.properties.textColor ? { textColor: run.properties.textColor ?? '#000000' } : {}),
      };
      if (Object.keys(marks).length > 0) operations.push({ type: 'format', version: 1, scope: 'character', offset: start, count: end - start, marks });
    }
  }
  const oldParagraphs = before.paragraphs ?? [before];
  let offset = 0;
  for (const [index, paragraph] of (after.paragraphs ?? [after]).entries()) {
    if (oldParagraphs[index]?.paragraph.alignment !== paragraph.paragraph.alignment)
      operations.push({ type: 'format', version: 1, scope: 'paragraph', offset, count: paragraph.text.length,
        marks: { alignment: paragraph.paragraph.alignment ?? 'left' } });
    offset += paragraph.text.length + 1;
  }
  const compact: CollaborationFormatOpV1[] = [];
  for (const operation of operations) {
    const previous = compact.at(-1);
    if (operation.scope === 'character' && previous?.scope === 'character'
      && previous.offset + previous.count === operation.offset
      && JSON.stringify(previous.marks) === JSON.stringify(operation.marks)) {
      compact[compact.length - 1] = { ...previous, count: previous.count + operation.count };
    } else compact.push(operation);
  }
  return compact;
}

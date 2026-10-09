import type { CollaborationFormatOpV1, CollaborationManifestRegionV1 } from './collaboration-live-contract.ts';

const integer = (min: number, max: number) => (value: unknown): boolean => typeof value === 'number' && Number.isSafeInteger(value) && value >= min && value <= max;
const color = (value: unknown): boolean => typeof value === 'string' && /^#[0-9a-f]{6}$/iu.test(value);
const oneOf = (values: string[]) => (value: unknown): boolean => typeof value === 'string' && values.includes(value);
const sevenIntegers = (min: number, max: number) => (value: unknown): boolean => Array.isArray(value) && value.length === 7 && value.every(integer(min, max));

export function parseFormatOperation(value: Record<string, unknown>): CollaborationFormatOpV1 | null {
  if (value.type !== 'format' || value.version !== 1 || typeof value.offset !== 'number'
    || !Number.isSafeInteger(value.offset) || value.offset < 0 || typeof value.count !== 'number'
    || !Number.isSafeInteger(value.count) || value.count < 0
    || Object.keys(value).some((key) => !['type', 'version', 'offset', 'count', 'scope', 'marks'].includes(key))) return null;
  const marks = value.marks;
  if (typeof marks !== 'object' || marks === null || Array.isArray(marks)) return null;
  const base = { type: 'format', version: 1, offset: value.offset, count: value.count } as const;
  const characterRules: Record<string, (value: unknown) => boolean> = {
    ...Object.fromEntries(['bold', 'italic', 'underline', 'superscript', 'subscript', 'strikethrough', 'emboss', 'engrave'].map(key => [key, (v: unknown) => typeof v === 'boolean'])),
    textColor: color, shadeColor: color,
    outlineType: integer(0, 6), shadowType: integer(0, 2),
    underlineType: oneOf(['None', 'Bottom', 'Top']),
    fontSize: integer(100, 100_000), ratios: sevenIntegers(1, 255), spacings: sevenIntegers(-128, 127),
  };
  const paragraphRules: Record<string, (value: unknown) => boolean> = {
    alignment: oneOf(['justify', 'left', 'right', 'center', 'distribute', 'split']),
    lineSpacing: integer(0, 100_000), lineSpacingType: oneOf(['Percent', 'Fixed', 'SpaceOnly', 'Minimum']),
    indent: integer(-2_000_000, 2_000_000),
  };
  if (value.scope !== 'character' && value.scope !== 'paragraph') return null;
  if (value.scope === 'character' && value.count === 0) return null;
  const rules = value.scope === 'character' ? characterRules : paragraphRules;
  const entries = Object.entries(marks);
  if (entries.length === 0 || entries.some(([key, val]) => !rules[key]?.(val))) return null;
  return { ...base, scope: value.scope, marks: Object.fromEntries(entries.map(([key, val]) => [key, Array.isArray(val) ? [...val] : val])) } as CollaborationFormatOpV1;

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
      // Native insertion inherits its boundary style; missing runs are not changes
      // to false/zero defaults. Avoid allocating new shape IDs for plain typing.
      const inheritedOffset = Math.max(0, prefix - 1);
      const baseline = old ?? before.runs.find(entry => entry.start <= inheritedOffset && entry.end > inheritedOffset)?.properties;
      const marks = {
        ...(old?.bold !== run.properties.bold ? { bold: run.properties.bold ?? false } : {}),
        ...(old?.italic !== run.properties.italic ? { italic: run.properties.italic ?? false } : {}),
        ...(old?.underline !== run.properties.underline ? { underline: run.properties.underline ?? false } : {}),
        ...((baseline?.superscript ?? false) !== (run.properties.superscript ?? false) ? { superscript: run.properties.superscript ?? false } : {}),
        ...((baseline?.subscript ?? false) !== (run.properties.subscript ?? false) ? { subscript: run.properties.subscript ?? false } : {}),
        ...((baseline?.strikethrough ?? false) !== (run.properties.strikethrough ?? false) ? { strikethrough: run.properties.strikethrough ?? false } : {}),
        ...((baseline?.emboss ?? false) !== (run.properties.emboss ?? false) ? { emboss: run.properties.emboss ?? false } : {}),
        ...((baseline?.engrave ?? false) !== (run.properties.engrave ?? false) ? { engrave: run.properties.engrave ?? false } : {}),
        ...((baseline?.outlineType ?? 0) !== (run.properties.outlineType ?? 0) ? { outlineType: run.properties.outlineType ?? 0 } : {}),
        ...((baseline?.shadowType ?? 0) !== (run.properties.shadowType ?? 0) ? { shadowType: run.properties.shadowType ?? 0 } : {}),
        ...((baseline?.underlineType ?? 'None') !== (run.properties.underlineType ?? 'None') ? { underlineType: run.properties.underlineType ?? 'None' } : {}),
        ...((baseline?.shadeColor ?? '#ffffff') !== (run.properties.shadeColor ?? '#ffffff') ? { shadeColor: run.properties.shadeColor ?? '#ffffff' } : {}),
        ...(old?.textColor !== run.properties.textColor ? { textColor: run.properties.textColor ?? '#000000' } : {}),
        ...(old?.fontSize !== run.properties.fontSize ? { fontSize: run.properties.fontSize ?? 1000 } : {}),
        ...(JSON.stringify(old?.ratios) !== JSON.stringify(run.properties.ratios) ? { ratios: run.properties.ratios ?? Array(7).fill(100) } : {}),
        ...(JSON.stringify(old?.spacings) !== JSON.stringify(run.properties.spacings) ? { spacings: run.properties.spacings ?? Array(7).fill(0) } : {}),
      };
      if (Object.keys(marks).length > 0) operations.push({ type: 'format', version: 1, scope: 'character', offset: start, count: end - start, marks });
    }
  }
  const oldParagraphs = before.paragraphs ?? [before];
  let offset = 0;
  for (const [index, paragraph] of (after.paragraphs ?? [after]).entries()) {
    const old = oldParagraphs[index]?.paragraph;
    const current = paragraph.paragraph;
    const marks = {
      ...(old?.alignment !== current.alignment ? { alignment: current.alignment ?? 'left' } : {}),
      ...((old?.lineSpacing ?? 160) !== (current.lineSpacing ?? 160) ? { lineSpacing: current.lineSpacing ?? 160 } : {}),
      ...((old?.lineSpacingType ?? 'Percent') !== (current.lineSpacingType ?? 'Percent') ? { lineSpacingType: current.lineSpacingType ?? 'Percent' } : {}),
      ...((old?.indent ?? 0) !== (current.indent ?? 0) ? { indent: Math.round((current.indent ?? 0) * 150) } : {}),
    };
    if (Object.keys(marks).length > 0)
      operations.push({ type: 'format', version: 1, scope: 'paragraph', offset, count: paragraph.text.length, marks });
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

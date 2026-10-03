import { encodeCollaborationParagraph } from './collaboration-text-validation.ts';
import type { DocumentPosition } from '../core/types.ts';
import type { WasmBridge } from '../core/wasm-bridge.ts';
import type { CollaborationManifestRegionV1 } from './collaboration-live-contract.ts';
import { groupRuns } from './collaboration-live-adapter.ts';
import { formatOperations } from './collaboration-format.ts';

export type LivePastePolicy = Readonly<{ epoch: string; writableRegionIds: readonly string[]; promptPolicy?: Readonly<{ memberId: string | null; spaces: readonly Readonly<{ id: string; regionId: string; start: number; end: number; memberId: string | null }>[]; texts: readonly Readonly<{ regionId: string; text: string }>[] }> }>;
type Marks = Readonly<{ bold: boolean; italic: boolean; textColor?: string }>;
type Run = Readonly<{ text: string; marks?: Marks }>;
export type LivePastePlan = Readonly<{ start: DocumentPosition; end: DocumentPosition; epoch: string; offset: number; count: number; runs: readonly Run[]; expectedText: string }>;

export class LivePasteError extends Error {
  readonly name = 'LivePasteError';
  constructor(readonly reason: string) {
    super(`공동편집 붙여넣기: ${reason}. 기존 내용은 보존됩니다.`);
  }
}

function regionId(position: DocumentPosition): string {
  if (position.isTextBox || (position.cellPath?.length ?? 0) > 1) throw new LivePasteError('지원하지 않는 개체 또는 중첩 셀');
  if (position.parentParaIndex === undefined) return `b:${position.sectionIndex}:${position.paragraphIndex}`;
  if (position.controlIndex === undefined || position.cellIndex === undefined) throw new LivePasteError('셀 주소가 불완전합니다');
  return `c:${position.sectionIndex}:${position.parentParaIndex}:${position.controlIndex}:${position.cellIndex}`;
}

export function planLivePaste(wasm: WasmBridge, input: Readonly<{
  start: DocumentPosition; end: DocumentPosition; html: string; text: string;
}>): LivePastePlan {
  const id = regionId(input.start);
  if (id !== regionId(input.end))
    throw new LivePasteError('한 문단 또는 한 셀 문단 안의 범위를 선택하세요');
  const epoch = wasm.getLivePasteEpoch();
  if (!epoch || !wasm.canPasteLiveRegion(id, epoch)) throw new LivePasteError('현재 영역의 편집 권한 또는 문서 버전을 확인할 수 없습니다');
  if (wasm.canEditPromptSelection?.(input.start, input.end) === false) throw new LivePasteError('담당 작성 구간 밖의 선택');
  const start = input.start;
  const expectedText = pasteManifest(wasm, start).text;
  const offset = selectionOffset(expectedText, start);
  const endOffset = selectionOffset(expectedText, input.end);
  const count = endOffset - offset;
  if (count < 0) throw new LivePasteError('선택 범위가 변경되었습니다');
  const cell = start.parentParaIndex !== undefined;
  const runs = input.html ? parseLivePasteHtml(input.html, cell) : [{ text: input.text.replace(/\r\n?/gu, '\n') }];
  const text = runs.map((run) => run.text).join('');
  if (text.length > 20_000) throw new LivePasteError('영역의 최대 길이를 초과합니다');
  if ((cell ? /[\u0000-\u0009\u000b-\u001f\u007f\ufffc]/u : /[\u0000-\u001f\u007f\ufffc]/u).test(text)
    || /[\uD800-\uDFFF]/u.test(text)) throw new LivePasteError('지원하지 않는 개체 또는 텍스트');
  const removedText = [...expectedText].slice(offset, endOffset).join('');
  if (expectedText.length - removedText.length + text.length > 20_000) throw new LivePasteError('영역의 최대 길이를 초과합니다');
  return { start: { ...start }, end: { ...input.end }, epoch, offset, count, runs, expectedText };
}

function selectionOffset(text: string, position: DocumentPosition): number {
  const paragraphs = text.split('\n');
  const index = position.parentParaIndex === undefined ? 0 : position.cellParaIndex ?? 0;
  const paragraph = paragraphs[index];
  if (!Number.isSafeInteger(index) || index < 0 || paragraph === undefined || !Number.isSafeInteger(position.charOffset)
    || position.charOffset < 0 || position.charOffset > [...paragraph].length) throw new LivePasteError('선택 범위가 변경되었습니다');
  return paragraphs.slice(0, index).reduce((sum, part) => sum + [...part].length + 1, 0) + position.charOffset;
}

function paragraphText(wasm: WasmBridge, start: DocumentPosition): string {
  const nativeText = start.parentParaIndex === undefined
    ? wasm.getTextRange(start.sectionIndex, start.paragraphIndex, 0, wasm.getParagraphLength(start.sectionIndex, start.paragraphIndex))
    : wasm.getTextInCell(start.sectionIndex, start.parentParaIndex, start.controlIndex ?? 0, start.cellIndex ?? 0, start.cellParaIndex ?? 0, 0,
      wasm.getCellParagraphLength(start.sectionIndex, start.parentParaIndex, start.controlIndex ?? 0, start.cellIndex ?? 0, start.cellParaIndex ?? 0));
  const encoded = encodeCollaborationParagraph(nativeText);
  if (encoded === null) throw new LivePasteError('지원하지 않는 개체 또는 텍스트');
  return encoded;
}

export function parseLivePasteHtml(html: string, multiline = false): readonly Run[] {
  if (html.length > 100_000) throw new LivePasteError('HTML의 최대 길이를 초과합니다');
  const document = new DOMParser().parseFromString(html, 'text/html');
  if (document.head.children.length > 0) throw new LivePasteError('지원하지 않는 HTML 메타데이터 또는 개체');
  const runs: Run[] = [];
  let blocks = 0;
  const walk = (node: Node, marks: Marks): void => {
    if (node.nodeType === 3) { runs.push({ text: node.textContent ?? '', marks }); return; }
    if (node.nodeType === 8) return;
    if (!(node instanceof Element)) throw new LivePasteError('지원하지 않는 HTML');
    const element = node;
    const tag = element.tagName.toLowerCase();
    if (!['p', 'div', 'span', 'b', 'strong', 'i', 'em', ...(multiline ? ['br'] : [])].includes(tag)) throw new LivePasteError('지원하지 않는 HTML 서식 또는 개체');
    if (element.attributes.length > 0) throw new LivePasteError('지원하지 않는 HTML 속성');
    if (multiline && (tag === 'p' || tag === 'div') && element.querySelector('p,div')) {
      for (const child of element.childNodes) {
        if (child.nodeType === 8 || (child.nodeType === 3 && !child.textContent?.trim())) continue;
        if (!(child instanceof Element) || !['p', 'div'].includes(child.tagName.toLowerCase()))
          throw new LivePasteError('지원하지 않는 혼합 HTML 문단');
        walk(child, marks);
      }
      return;
    }
    if (tag === 'p' || tag === 'div') {
      blocks += 1;
      if (blocks > 1) {
        if (!multiline) throw new LivePasteError('여러 문단 붙여넣기는 지원하지 않습니다');
        runs.push({ text: '\n' });
      }
    }
    if (tag === 'br') { runs.push({ text: '\n' }); return; }
    const next = { ...marks, ...(['b', 'strong'].includes(tag) ? { bold: true } : {}), ...(['i', 'em'].includes(tag) ? { italic: true } : {}) };
    for (const child of element.childNodes) walk(child, next);
  };
  for (const child of [...document.body.childNodes]) {
    if (child.nodeType === 8) document.body.removeChild(child);
  }
  document.body.normalize();
  for (const child of document.body.childNodes) {
    if (multiline && child.nodeType === 3 && !child.textContent?.trim()
      && [child.previousSibling, child.nextSibling].some(sibling => sibling instanceof Element && ['p', 'div'].includes(sibling.tagName.toLowerCase()))) continue;
    walk(child, { bold: false, italic: false });
  }
  return runs;
}

export function applyLivePaste(wasm: WasmBridge, plan: LivePastePlan): DocumentPosition {
  const before = pasteManifest(wasm, plan.start);
  const snapshot = wasm.saveSnapshot();
  try {
    const position = mutateLivePaste(wasm, plan);
    const after = pasteManifest(wasm, plan.start);
    if (after.text.length > 20_000) throw new LivePasteError('영역의 최대 길이를 초과합니다');
    let prefix = 0;
    while (prefix < before.text.length && prefix < after.text.length && before.text[prefix] === after.text[prefix]) prefix += 1;
    let suffix = 0;
    while (suffix < before.text.length - prefix && suffix < after.text.length - prefix
      && before.text[before.text.length - suffix - 1] === after.text[after.text.length - suffix - 1]) suffix += 1;
    const textOperations = Number(before.text.length > prefix + suffix) + Number(after.text.length > prefix + suffix);
    if (formatOperations(before, after).length + textOperations > 1_000)
      throw new LivePasteError('한 번의 공동편집 전송에서 지원하는 서식 범위 수를 초과합니다');
    return position;
  } catch (error) {
    wasm.restoreSnapshot(snapshot);
    throw error;
  } finally { wasm.discardSnapshot(snapshot); }
}

function pasteManifest(wasm: WasmBridge, start: DocumentPosition): CollaborationManifestRegionV1 {
  const id = regionId(start);
  if (start.parentParaIndex === undefined) {
    const text = paragraphText(wasm, start);
    return { id, kind: 'body', text, paragraph: wasm.getParaPropertiesAt(start.sectionIndex, start.paragraphIndex),
      runs: groupRuns(text, (offset) => wasm.getCharPropertiesAt(start.sectionIndex, start.paragraphIndex, offset)) };
  }
  const parent = start.parentParaIndex;
  const paragraphs = Array.from({ length: wasm.getCellParagraphCount(start.sectionIndex, parent, start.controlIndex ?? 0, start.cellIndex ?? 0) }, (_, index) => {
    const text = paragraphText(wasm, { ...start, cellParaIndex: index });
    return { id: `${id}:p:${index}`, text,
      paragraph: wasm.getCellParaPropertiesAt(start.sectionIndex, parent, start.controlIndex ?? 0, start.cellIndex ?? 0, index),
      runs: groupRuns(text, (offset) => wasm.getCellCharPropertiesAt(start.sectionIndex, parent, start.controlIndex ?? 0, start.cellIndex ?? 0, index, offset)) };
  });
  const first = paragraphs[0];
  if (!first) throw new LivePasteError('셀 문단을 찾을 수 없습니다');
  let offset = 0;
  const runs = paragraphs.flatMap((paragraph) => {
    const mapped = paragraph.runs.map((run) => ({ ...run, start: offset + run.start, end: offset + run.end }));
    offset += paragraph.text.length + 1;
    return mapped;
  });
  return { id, kind: 'cell', text: paragraphs.map((paragraph) => paragraph.text).join('\n'), paragraph: first.paragraph, runs, paragraphs };
}

function mutateLivePaste(wasm: WasmBridge, plan: LivePastePlan): DocumentPosition {
  const { start, count, runs } = plan;
  if (!wasm.canPasteLiveRegion(regionId(start), plan.epoch)) throw new LivePasteError('편집 권한이 변경되었습니다');
  if (pasteManifest(wasm, start).text !== plan.expectedText) throw new LivePasteError('선택한 내용이 변경되었습니다');
  const text = runs.map((run) => run.text).join('');
  if (start.parentParaIndex === undefined) {
    if (count) wasm.deleteText(start.sectionIndex, start.paragraphIndex, start.charOffset, count);
    if (text) wasm.insertText(start.sectionIndex, start.paragraphIndex, start.charOffset, text);
  } else {
    if (count) wasm.deleteRangeInCell(start.sectionIndex, start.parentParaIndex, start.controlIndex ?? 0, start.cellIndex ?? 0,
      start.cellParaIndex ?? 0, start.charOffset, plan.end.cellParaIndex ?? 0, plan.end.charOffset);
    const parts = text.split('\n');
    for (const [index, part] of parts.entries()) {
      const paragraph = (start.cellParaIndex ?? 0) + index;
      const offset = index === 0 ? start.charOffset : 0;
      if (index > 0) {
        const previous = parts[index - 1] ?? '';
        wasm.splitParagraphInCell(start.sectionIndex, start.parentParaIndex, start.controlIndex ?? 0, start.cellIndex ?? 0,
          paragraph - 1, (index === 1 ? start.charOffset : 0) + [...previous].length);
      }
      if (part) wasm.insertTextInCell(start.sectionIndex, start.parentParaIndex, start.controlIndex ?? 0, start.cellIndex ?? 0, paragraph, offset, part);
    }
  }
  let offset = start.charOffset;
  let paragraph = start.cellParaIndex ?? 0;
  for (const run of runs) {
    for (const [index, part] of run.text.split('\n').entries()) {
      if (index > 0) { paragraph += 1; offset = 0; }
      const end = offset + [...part].length;
      if (end > offset && run.marks) {
        if (start.parentParaIndex === undefined) wasm.applyCharFormat(start.sectionIndex, start.paragraphIndex, offset, end, JSON.stringify(run.marks));
        else wasm.applyCharFormatInCell(start.sectionIndex, start.parentParaIndex, start.controlIndex ?? 0, start.cellIndex ?? 0, paragraph, offset, end, JSON.stringify(run.marks));
      }
      offset = end;
    }
  }
  const original = [...plan.expectedText];
  const expected = original.slice(0, plan.offset).join('') + text + original.slice(plan.offset + count).join('');
  if (pasteManifest(wasm, start).text !== expected) throw new LivePasteError('편집 엔진이 붙여넣기를 적용하지 못했습니다');
  return { ...start, charOffset: offset, ...(start.parentParaIndex === undefined ? {} : { cellParaIndex: paragraph,
    ...(start.cellPath ? { cellPath: start.cellPath.map((entry) => ({ ...entry, cellParaIndex: paragraph })) } : {}) }) };
}

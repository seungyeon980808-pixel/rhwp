import { structuredPosition } from './collaboration-structured-cell.ts';
import type { DocumentPosition } from '../core/types';
import type { WasmBridge } from '../core/wasm-bridge';
import type { LivePastePolicy } from './collaboration-range-paste';
import { encodeCollaborationParagraph } from './collaboration-text-validation.ts';

type Policy = NonNullable<LivePastePolicy['promptPolicy']>;
export class PromptSpacePolicy {
  private spaces: Policy['spaces'];
  private texts: Map<string, string>;
  private policy: Policy;
  constructor(policy: Policy) { this.policy = policy; this.spaces = policy.spaces.map(s => ({ ...s })); this.texts = new Map(policy.texts.map(t => [t.regionId, t.text])); }
  get active(): boolean { return this.spaces.length > 0; }
  get restricted(): boolean { return this.active && this.policy.memberId !== null; }
  private reconcile(regionId: string, text: string): void {
    const before = this.texts.get(regionId);
    if (before === undefined || before === text) return;
    let start = 0, suffix = 0;
    while (start < before.length && start < text.length && before[start] === text[start]) start++;
    while (suffix < before.length - start && suffix < text.length - start && before[before.length - 1 - suffix] === text[text.length - 1 - suffix]) suffix++;
    let beforeEnd = before.length - suffix, afterEnd = text.length - suffix;
    const contained = () => this.spaces.some(s => s.regionId === regionId && s.memberId === this.policy.memberId && start >= s.start && beforeEnd <= s.end);
    if (!contained()) while (start > 0 && before[start - 1] === before[beforeEnd - 1] && text[start - 1] === text[afterEnd - 1]) {
      start--; beforeEnd--; afterEnd--; if (contained()) break;
    }
    const count = beforeEnd - start;
    const inserted = afterEnd - start;
    const containing = this.spaces.find(s => s.regionId === regionId && s.start <= start && start <= s.end);
    const move = (x: number) => x <= start ? x : x >= start + count ? x - count : start;
    this.spaces = this.spaces.map(s => {
      if (s.regionId !== regionId) return s;
      const next = { ...s, start: move(s.start), end: move(s.end) };
      if (s.id === containing?.id) next.end += inserted;
      else if (next.start >= start) { next.start += inserted; next.end += inserted; }
      return next;
    });
    this.texts.set(regionId, text);
  }
  private point(wasm: WasmBridge, pos: DocumentPosition) {
    if (pos.isTextBox) return null;
    const structured = structuredPosition(wasm,pos);
    if (structured) { this.reconcile(structured.id,structured.text); return structured; }
    if ((pos.cellPath?.length ?? 0) > 1) return null;
    const cell = pos.parentParaIndex !== undefined;
    const id = cell ? `c:${pos.sectionIndex}:${pos.parentParaIndex}:${pos.controlIndex}:${pos.cellIndex}` : `b:${pos.sectionIndex}:${pos.paragraphIndex}`;
    const paragraphs = cell ? Array.from({ length: wasm.getCellParagraphCount(pos.sectionIndex, pos.parentParaIndex!, pos.controlIndex!, pos.cellIndex!) }, (_, i) =>
      encodeCollaborationParagraph(wasm.getTextInCell(pos.sectionIndex, pos.parentParaIndex!, pos.controlIndex!, pos.cellIndex!, i, 0,
        wasm.getCellParagraphLength(pos.sectionIndex, pos.parentParaIndex!, pos.controlIndex!, pos.cellIndex!, i))))
      : [encodeCollaborationParagraph(wasm.getTextRange(pos.sectionIndex, pos.paragraphIndex, 0, wasm.getParagraphLength(pos.sectionIndex, pos.paragraphIndex)))];
    if (paragraphs.some(p => p === null)) return null;
    const index = cell ? pos.cellParaIndex ?? 0 : 0;
    const paragraph = paragraphs[index];
    if (paragraph === undefined || paragraph === null || pos.charOffset > [...paragraph].length) return null;
    const text = paragraphs.join('\n');
    this.reconcile(id, text);
    return { id, offset: paragraphs.slice(0, index).reduce((n, p) => n + p!.length + 1, 0) + [...paragraph].slice(0, pos.charOffset).join('').length, text };
  }
  allows(wasm: WasmBridge, start: DocumentPosition, end: DocumentPosition, deleteDirection = 0): boolean {
    const structuredA=structuredPosition(wasm,start),structuredB=structuredPosition(wasm,end);
    if(structuredA||structuredB) {
      if(!structuredA||!structuredB||structuredA.id!==structuredB.id) return false;
      let lo=Math.min(structuredA.offset,structuredB.offset), hi=Math.max(structuredA.offset,structuredB.offset);
      if(lo===hi&&deleteDirection) { if(deleteDirection<0) lo--;else hi++; }
      if(/[\u2029\ufffc]/u.test(structuredA.text.slice(Math.max(0,lo),hi))) return false;
    }
    if (!this.restricted) return true;
    const a = this.point(wasm, start), b = this.point(wasm, end);
    if (!a || !b || a.id !== b.id) return false;
    let lo = Math.min(a.offset, b.offset), hi = Math.max(a.offset, b.offset);
    if (lo === hi && deleteDirection) {
      if (deleteDirection < 0) lo -= [...a.text.slice(0, lo)].at(-1)?.length ?? 1;
      else hi += [...a.text.slice(hi)][0]?.length ?? 1;
    }
    return this.spaces.some(s => s.regionId === a.id && s.memberId === this.policy.memberId && lo >= s.start && hi <= s.end);
  }
}

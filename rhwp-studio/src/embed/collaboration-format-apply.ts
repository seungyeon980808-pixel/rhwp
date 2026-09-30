import type { CollaborationFormatOpV1 } from './collaboration-live-contract.ts';

export interface CollaborationFormatWasm {
  applyCharFormat(section: number, paragraph: number, start: number, end: number, properties: string): string;
  applyCharFormatInCell(section: number, paragraph: number, control: number, cell: number, cellParagraph: number, start: number, end: number, properties: string): string;
  applyParaFormat(section: number, paragraph: number, properties: string): string;
  applyParaFormatInCell(section: number, paragraph: number, control: number, cell: number, cellParagraph: number, properties: string): string;
}

export function planFormatting(text: string, operation: CollaborationFormatOpV1): readonly Readonly<{ paragraph: number; start: number; end: number }>[] | null {
  const end = operation.offset + operation.count;
  if (end > text.length) return null;
  for (const offset of [operation.offset, end]) {
    if (offset > 0 && offset < text.length && /[\ud800-\udbff]/u.test(text[offset - 1] ?? '')
      && /[\udc00-\udfff]/u.test(text[offset] ?? '')) return null;
  }
  let start = 0;
  return text.split('\n').flatMap((paragraph, index) => {
    const paragraphStart = start;
    start += paragraph.length + 1;
    const from = Math.max(operation.offset, paragraphStart);
    const to = Math.min(end, paragraphStart + paragraph.length);
    const intersects = operation.scope === 'paragraph'
      ? operation.offset <= paragraphStart + paragraph.length && end >= paragraphStart
      : to > from;
    return intersects ? [{ paragraph: index, start: [...paragraph.slice(0, from - paragraphStart)].length,
      end: [...paragraph.slice(0, to - paragraphStart)].length }] : [];
  });
}

type Address = Readonly<{ section: number; paragraph: number }> & (
  | Readonly<{ kind: 'body' }>
  | Readonly<{ kind: 'cell'; control: number; cell: number; cellParagraph: number }>
);

export function applyFormatting(wasm: CollaborationFormatWasm, target: Readonly<{
  address: Address; operation: CollaborationFormatOpV1; ranges: NonNullable<ReturnType<typeof planFormatting>>;
}>): void {
  const { address, operation } = target;
  const properties = JSON.stringify(operation.marks);
  for (const range of target.ranges) {
    switch (operation.scope) {
      case 'character':
        if (address.kind === 'body') wasm.applyCharFormat(address.section, address.paragraph, range.start, range.end, properties);
        else wasm.applyCharFormatInCell(address.section, address.paragraph, address.control, address.cell, range.paragraph, range.start, range.end, properties);
        break;
      case 'paragraph':
        if (address.kind === 'body') wasm.applyParaFormat(address.section, address.paragraph, properties);
        else wasm.applyParaFormatInCell(address.section, address.paragraph, address.control, address.cell, range.paragraph, properties);
        break;
      default: { const exhaustive: never = operation; throw new TypeError(`Unsupported format: ${exhaustive}`); }
    }
  }
}

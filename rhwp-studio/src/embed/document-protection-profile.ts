export type DocumentProtectionReason =
  | 'many-pages'
  | 'many-tables'
  | 'many-images'
  | 'nested-tables'
  | 'mixed-drawing-objects';

export interface DocumentProtectionProfileV1 {
  readonly schemaVersion: 1;
  readonly status: 'standard' | 'protected';
  readonly pageCount: number;
  readonly renderedTableCount: number;
  readonly imageCount: number;
  readonly shapeCount: number;
  readonly nestedTableCount: number;
  readonly reasons: readonly DocumentProtectionReason[];
  readonly safeEditScopes: readonly [
    'single-body-paragraph',
    'single-table-cell-paragraph',
  ];
}

export function buildDocumentProtectionProfile(
  pageTrees: readonly unknown[],
): DocumentProtectionProfileV1 {
  let renderedTableCount = 0;
  let imageCount = 0;
  let shapeCount = 0;
  let nestedTableCount = 0;

  const visit = (value: unknown, insideTableCell: boolean): void => {
    if (Array.isArray(value)) {
      for (const child of value) visit(child, insideTableCell);
      return;
    }
    if (!isRecord(value)) return;
    const type = stringProperty(value, 'type');
    const groupKind = isRecord(value.groupKind) ? stringProperty(value.groupKind, 'kind') : '';
    const nodeKind = stringProperty(value, 'kind');
    const clipKind = stringProperty(value, 'clipKind');
    if (type === 'table' || groupKind === 'table') {
      renderedTableCount += 1;
      if (insideTableCell) nestedTableCount += 1;
    } else if (type === 'image') {
      imageCount += 1;
    } else if (type === 'textBox' || type === 'rectangle' || type === 'path') {
      shapeCount += 1;
    }
    const childInsideTableCell = insideTableCell || type === 'tableCell' || clipKind === 'tableCell';
    if ('root' in value) visit(value.root, insideTableCell);
    if ('children' in value) visit(value.children, childInsideTableCell);
    if ('child' in value) visit(value.child, childInsideTableCell);
    if (nodeKind === 'leaf' && 'ops' in value) visit(value.ops, childInsideTableCell);
  };
  for (const tree of pageTrees) visit(tree, false);

  const reasons: DocumentProtectionReason[] = [];
  if (pageTrees.length >= 4) reasons.push('many-pages');
  if (renderedTableCount >= 12) reasons.push('many-tables');
  if (imageCount >= 5) reasons.push('many-images');
  if (nestedTableCount > 0) reasons.push('nested-tables');
  if (shapeCount >= 5) reasons.push('mixed-drawing-objects');
  const protectedDocument = nestedTableCount > 0
    || renderedTableCount >= 20
    || reasons.length >= 2;

  return {
    schemaVersion: 1,
    status: protectedDocument ? 'protected' : 'standard',
    pageCount: pageTrees.length,
    renderedTableCount,
    imageCount,
    shapeCount,
    nestedTableCount,
    reasons,
    safeEditScopes: ['single-body-paragraph', 'single-table-cell-paragraph'],
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function stringProperty(value: Record<string, unknown>, key: string): string {
  return typeof value[key] === 'string' ? value[key] : '';
}

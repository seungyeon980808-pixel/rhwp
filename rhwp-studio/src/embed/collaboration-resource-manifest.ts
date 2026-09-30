import type { CellInfo, TableDimensions } from '../core/types.ts';


export interface RawResourceSource {
  getBinaryResourceManifest?: () => string | null;
}

export function inspectRawResources(source: RawResourceSource) {
  const raw = source.getBinaryResourceManifest?.();
  if (raw == null) return { resources: [], missing: ['raw-resource-inventory'] };
  const value: unknown = JSON.parse(raw);
  if (typeof value !== 'object' || value === null || !('resources' in value) || !Array.isArray(value.resources)
    || !('missing' in value) || !Array.isArray(value.missing) || !value.missing.every((item: unknown) => typeof item === 'string'))
    throw new ManifestInspectionError('invalid-resource-inventory');
  const resources: { id: string; sha256: string }[] = [];
  const ids = new Set<string>();
  for (const resource of value.resources) {
    if (typeof resource !== 'object' || resource === null || typeof resource.id !== 'string'
      || !/^bin:\d+$/u.test(resource.id) || typeof resource.sha256 !== 'string'
      || !/^[a-f0-9]{64}$/u.test(resource.sha256) || ids.has(resource.id))
      throw new ManifestInspectionError('invalid-resource-inventory');
    ids.add(resource.id);
    resources.push({ id: resource.id, sha256: resource.sha256 });
  }
  return { resources, missing: value.missing.filter((item: unknown): item is string => typeof item === 'string') };
}

interface TableTopologySource {
  getTableDimensions(section: number, paragraph: number, control: number): TableDimensions;
  getCellInfo(section: number, paragraph: number, control: number, cell: number): CellInfo;
}

class ManifestInspectionError extends Error {
  override readonly name = 'ManifestInspectionError';
  readonly code: 'invalid-table-topology' | 'invalid-resource-inventory';
  constructor(code: 'invalid-table-topology' | 'invalid-resource-inventory') { super(code); this.code = code; }
}


export function tableTopologySignature(source: TableTopologySource, address: Readonly<{ section: number; paragraph: number; control: number }>): string {
  const { rowCount, colCount, cellCount } = source.getTableDimensions(address.section, address.paragraph, address.control);
  if (![rowCount, colCount, cellCount].every((value) => Number.isSafeInteger(value) && value > 0)
    || rowCount * colCount > 1_000_000 || cellCount > rowCount * colCount)
    throw new ManifestInspectionError('invalid-table-topology');
  const occupied = new Set<number>();
  const cells: CellInfo[] = [];
  for (let index = 0; index < cellCount; index += 1) {
    const { row, col, rowSpan, colSpan } = source.getCellInfo(address.section, address.paragraph, address.control, index);
    if (![row, col, rowSpan, colSpan].every(Number.isSafeInteger) || row < 0 || col < 0
      || rowSpan < 1 || colSpan < 1 || row + rowSpan > rowCount || col + colSpan > colCount)
      throw new ManifestInspectionError('invalid-table-topology');
    for (let y = row; y < row + rowSpan; y += 1) {
      for (let x = col; x < col + colSpan; x += 1) {
        const key = y * colCount + x;
        if (occupied.has(key)) throw new ManifestInspectionError('invalid-table-topology');
        occupied.add(key);
      }
    }
    cells.push({ row, col, rowSpan, colSpan });
  }
  if (occupied.size !== rowCount * colCount) throw new ManifestInspectionError('invalid-table-topology');
  cells.sort((first, second) => first.row - second.row || first.col - second.col);
  return JSON.stringify({ rowCount, colCount, cells });
}

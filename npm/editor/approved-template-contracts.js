const DIGEST = /^sha256:[a-f0-9]{64}$/u;
const FORMATS = new Set(['hwp', 'hwpx', 'hwp3', 'hml', 'drm-protected', 'empty', 'unknown']);

function record(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function count(value) {
  return Number.isSafeInteger(value) && value >= 0;
}

function digest(value) {
  return typeof value === 'string' && DIGEST.test(value);
}

function stringArray(value) {
  return Array.isArray(value) && value.every((item) => typeof item === 'string');
}

function protection(value) {
  return record(value)
    && value.schemaVersion === 1
    && (value.status === 'standard' || value.status === 'protected')
    && ['pageCount', 'tableCount', 'nestedTableCount', 'pictureCount', 'shapeCount']
      .every((key) => count(value[key]))
    && stringArray(value.reasons);
}

function nativeField(value) {
  return record(value) && count(value.fieldId) && typeof value.editable === 'boolean'
    && digest(value.valueHash);
}

function bodyCandidate(value) {
  return record(value) && count(value.sectionIndex) && count(value.paragraphIndex)
    && digest(value.textHash) && digest(value.adjacentLabelDigest);
}

function tableCell(value) {
  return record(value)
    && ['tableIndex', 'row', 'col', 'rowSpan', 'colSpan'].every((key) => count(value[key]))
    && record(value.mergedAnchor) && count(value.mergedAnchor.row) && count(value.mergedAnchor.col)
    && digest(value.textHash) && digest(value.adjacentLabelDigest)
    && typeof value.safe === 'boolean' && stringArray(value.blockedReasons)
    && record(value.resolvedAddress)
    && ['sectionIndex', 'paragraphIndex', 'controlIndex', 'cellIndex']
      .every((key) => count(value.resolvedAddress[key]));
}

export function validateApprovedTemplateInspection(value) {
  const valid = record(value)
    && value.schemaVersion === 1
    && FORMATS.has(value.format)
    && digest(value.structureDigest)
    && [
      'pageCount', 'sectionCount', 'paragraphCount', 'topLevelTableCount',
      'nestedTableCount', 'pictureCount', 'shapeCount', 'binDataCount',
    ].every((key) => count(value[key]))
    && protection(value.protection)
    && Array.isArray(value.nativeFields) && value.nativeFields.every(nativeField)
    && Array.isArray(value.bodyCandidates) && value.bodyCandidates.every(bodyCandidate)
    && Array.isArray(value.tableCells) && value.tableCells.every(tableCell)
    && typeof value.truncated === 'boolean';
  if (!valid) throw new Error('Invalid approved template inspection from Studio');
  return value;
}

function warning(value) {
  return record(value) && (value.targetId === null || typeof value.targetId === 'string')
    && typeof value.code === 'string';
}

function overflow(value) {
  return record(value) && typeof value.targetId === 'string'
    && ['cellWidthPx', 'textWidthPx'].every((key) => Number.isFinite(value[key]))
    && count(value.lines) && count(value.maxLines);
}

function rejected(value) {
  return record(value) && typeof value.targetId === 'string' && typeof value.reason === 'string';
}

function target(value) {
  return record(value) && typeof value.targetId === 'string'
    && typeof value.originalValue === 'string' && typeof value.proposedValue === 'string'
    && typeof value.changed === 'boolean';
}

export function validateApprovedTemplateEditResult(value) {
  const valid = record(value)
    && value.schemaVersion === 1
    && typeof value.ok === 'boolean'
    && count(value.updated)
    && (value.changedPages === null
      || (Array.isArray(value.changedPages) && value.changedPages.every(count)))
    && Array.isArray(value.warnings) && value.warnings.every(warning)
    && Array.isArray(value.overflowTargets) && value.overflowTargets.every(overflow)
    && Array.isArray(value.rejectedTargets) && value.rejectedTargets.every(rejected)
    && (value.reason === null || typeof value.reason === 'string')
    && (value.preflightToken === undefined || value.preflightToken === null
      || typeof value.preflightToken === 'string')
    && (value.targets === undefined || (Array.isArray(value.targets) && value.targets.every(target)));
  if (!valid) throw new Error('Invalid approved template edit result from Studio');
  return value;
}

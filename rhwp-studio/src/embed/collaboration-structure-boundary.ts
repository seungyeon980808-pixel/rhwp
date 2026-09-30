export const unsupportedLiveStructureReason = '공동편집 중에는 본문 문단·표·줄·칸의 추가, 삭제, 합치기와 나누기 및 서식·개체·여러 영역 붙여넣기를 사용할 수 없습니다. 기존 내용은 보존됩니다. 선택을 해제한 뒤 한 줄의 일반 텍스트를 붙여넣거나 기존 내용을 계속 편집하고 저장할 수 있습니다.';

const structuralCommands = new Set([
  'table:create', 'table:insert-row-col', 'table:delete-row-col',
  'table:insert-row-above', 'table:insert-row-below', 'table:insert-col-left', 'table:insert-col-right',
  'table:delete-row', 'table:delete-col', 'table:cell-split', 'table:cell-merge',
  'table:transpose-paste', 'table:split', 'table:attach', 'table:delete', 'table:caption-toggle',
]);

export function isUnsupportedLiveStructure(command: string, live: boolean): boolean {
  return live && structuralCommands.has(command);
}

export function installLiveStructureBoundary(document: Document): void {
  const menu = document.querySelector('[data-menu="table"] .menu-dropdown');
  if (menu && !menu.querySelector('[data-live-structure-reason]')) {
    const note = document.createElement('div');
    note.dataset.liveStructureReason = '';
    note.setAttribute('role', 'note');
    note.textContent = unsupportedLiveStructureReason;
    note.style.cssText = 'padding:8px 12px;max-width:240px;white-space:normal;line-height:1.5;font-size:12px';
    menu.prepend(note);
  }
  for (const element of document.querySelectorAll('[data-cmd]')) {
    if (!isUnsupportedLiveStructure(element.getAttribute('data-cmd') ?? '', true)) continue;
    if (element instanceof HTMLButtonElement) element.disabled = true;
    element.setAttribute('aria-disabled', 'true');
    element.setAttribute('title', unsupportedLiveStructureReason);
    element.setAttribute('aria-description', unsupportedLiveStructureReason);
  }
}

export class UnsupportedLiveStructureError extends Error {
  readonly code = 'LIVE_STRUCTURE_UNSUPPORTED';
  constructor() {
    super(unsupportedLiveStructureReason);
    this.name = 'UnsupportedLiveStructureError';
  }
}

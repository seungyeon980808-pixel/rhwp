const supportedCommands = new Set(['format:bold', 'format:italic', 'format:align-left',
  'format:align-center', 'format:align-right', 'format:align-justify', 'format:align-distribute', 'format:align-split']);
export const unsupportedLiveFormatReason = '공동편집에서 아직 동기화되지 않는 서식입니다. 굵게, 기울임, 글자 색, 문단 정렬만 사용할 수 있습니다.';
const unsupportedCommands = new Set(['edit:format-paste', 'table:cell-props', 'table:border-each', 'table:border-one']);

export function isUnsupportedLiveFormat(command: string, live: boolean): boolean {
  return live && (unsupportedCommands.has(command) || (command.startsWith('format:') && !supportedCommands.has(command)));
}

export function installLiveFormatBoundary(document: Document): void {
  const selectors = ['#style-name', '#font-name', '#font-size', '#font-lang', '#btn-underline', '#btn-strike',
    '#btn-highlight', '#btn-size-up', '#btn-size-down', '#btn-charfx', '#linespacing-select', '#btn-ls-up', '#btn-ls-down'];
  const selector = selectors.join(',');
  const controls = [...document.querySelectorAll(selector), ...[...document.querySelectorAll('[data-cmd]')]
    .filter((element) => isUnsupportedLiveFormat(element.getAttribute('data-cmd') ?? '', true))];
  for (const element of controls) {
    if (element instanceof HTMLButtonElement || element instanceof HTMLInputElement || element instanceof HTMLSelectElement) element.disabled = true;
    element.setAttribute('aria-disabled', 'true');
    element.setAttribute('title', unsupportedLiveFormatReason);
  }
  const block = (event: Event): void => {
    if (event.target instanceof Element && event.target.closest(selector)) {
      event.preventDefault(); event.stopImmediatePropagation();
    }
  };
  for (const name of ['mousedown', 'click', 'change', 'input']) document.addEventListener(name, block, true);
}

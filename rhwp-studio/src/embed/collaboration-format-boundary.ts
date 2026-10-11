const supportedCommands = new Set(['format:superscript', 'format:subscript', 'format:normal', 'format:strikethrough',
  'format:indent', 'format:outdent', 'format:line-spacing', 'format:line-spacing-increase', 'format:line-spacing-decrease', 'format:bold', 'format:italic', 'format:underline',
  'format:font-size-increase', 'format:font-size-decrease', 'format:char-spacing-increase', 'format:char-spacing-decrease',
  'format:char-ratio-increase', 'format:char-ratio-decrease', 'format:align-left',
  'format:align-center', 'format:align-right', 'format:align-justify', 'format:align-distribute', 'format:align-split']);
export const unsupportedLiveFormatReason = '이 서식은 아직 공동 작성에 지원되지 않습니다. 기본 글자 서식·첨자·색·크기·자간·장평·정렬·줄 간격·들여쓰기를 사용할 수 있습니다.';
const unsupportedCommands = new Set(['edit:format-paste', 'table:cell-props', 'table:border-each', 'table:border-one']);

export function isUnsupportedLiveFormat(command: string, live: boolean): boolean {
  return live && (unsupportedCommands.has(command) || (command.startsWith('format:') && !supportedCommands.has(command)));
}

export function installLiveFormatBoundary(document: Document): (mode: { canRequest: boolean; frozen?: boolean }) => void {
  const selectors = ['#style-name', '#font-name', '#font-lang', '#btn-charfx'];
  const selector = selectors.join(',');
  const controls = [...document.querySelectorAll(selector), ...[...document.querySelectorAll('[data-cmd]')]
    .filter((element) => isUnsupportedLiveFormat(element.getAttribute('data-cmd') ?? '', true))];
  const originals = controls.map(element => ({ element,
    disabled: 'disabled' in element ? (element as HTMLButtonElement).disabled : undefined,
    title: element.getAttribute('title'), ariaDisabled: element.getAttribute('aria-disabled') }));
  let blocked = true;
  const update = (mode: { canRequest: boolean; frozen?: boolean }): void => {
    blocked = !mode.canRequest || mode.frozen === true;
    for (const { element, disabled, title, ariaDisabled } of originals) {
      if (disabled !== undefined) (element as HTMLButtonElement).disabled = blocked || disabled;
      for (const [name, value] of [['title', blocked ? unsupportedLiveFormatReason : title],
        ['aria-disabled', blocked ? 'true' : ariaDisabled]] as const) {
        if (value === null) element.removeAttribute(name); else element.setAttribute(name, value);
      }
    }
  };
  update({ canRequest: false });
  const block = (event: Event): void => {
    if (blocked && event.target instanceof Element && event.target.closest(selector)) {
      event.preventDefault(); event.stopImmediatePropagation();
    }
  };
  for (const name of ['pointerdown', 'mousedown', 'click', 'change', 'input']) document.addEventListener(name, block, true);
  return update;
}

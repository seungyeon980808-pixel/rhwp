import type { EditorContext } from './types';

type FormatPasteContext = Pick<
  EditorContext,
  'hasDocument' | 'hasCopiedFormat' | 'isFormMode' | 'hasSelection' | 'inCellSelectionMode'
>;

/** 모양 붙여넣기는 복사 상태와 명확한 적용 대상이 있을 때만 활성화한다. */
export function canExecuteFormatPaste(ctx: FormatPasteContext): boolean {
  return ctx.hasDocument
    && ctx.hasCopiedFormat
    && !ctx.isFormMode
    && (ctx.hasSelection || ctx.inCellSelectionMode);
}

/** Alt+C copies at a caret, but applies the copied style to an existing target. */
export function resolveFormatCopyCommand(command: string, ctx: Pick<EditorContext, 'hasCopiedFormat' | 'hasSelection' | 'inCellSelectionMode'>): string {
  return command === 'edit:format-copy' && ctx.hasCopiedFormat && (ctx.hasSelection || ctx.inCellSelectionMode)
    ? 'edit:format-paste' : command;
}

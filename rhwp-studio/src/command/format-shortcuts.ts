import type { CommandServices } from './types';

/** Reset attributes only: keep the chosen font, size, spacing, ratio and color. */
export function applyNormalCharacterStyle(services: CommandServices): void {
  services.eventBus.emit('format-char', {
    bold: false, italic: false, underline: false, underlineType: 'None',
    strikethrough: false, emboss: false, engrave: false, outlineType: 0,
    shadowType: 0, superscript: false, subscript: false,
  });
}

/** Reader returns CSS px; paragraph mutations use twice-HWPUNIT for indent. */
export function adjustFirstLineIndent(services: CommandServices, direction: 1 | -1): void {
  const handler = services.getInputHandler();
  if (!handler) return;
  const currentPx = handler.getParaProperties()?.indent ?? 0;
  if (!Number.isFinite(currentPx)) return;
  const raw = Math.round(currentPx * 7200 / 96 * 2);
  handler.applyParaPropsAtCursor({ indent: raw + direction * 2000 }); // 10 pt
  handler.focus();
}

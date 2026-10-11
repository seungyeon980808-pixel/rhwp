import type { CommandServices } from './types';

/** Resolve document-specific font IDs only after the dispatcher grants editing. */
export function applyFontFamily(services: CommandServices, params?: Record<string, unknown>): void {
  const validName = (value: unknown): value is string => typeof value === 'string' && value.trim().length > 0 && value.length <= 500;
  const familySet = params?.fontFamilies;
  if (familySet !== undefined) {
    if (!Array.isArray(familySet) || familySet.length !== 7 || !familySet.every(validName)) throw new TypeError('Invalid font families');
    const fontIds = familySet.map((name, index) => services.wasm.findOrCreateFontIdForLang(index, name));
    if (fontIds.some(id => id < 0)) throw new Error('글꼴을 적용하지 못했습니다.');
    services.eventBus.emit('format-char', { fontIds }); return;
  }
  const name = params?.fontName, language = params?.language ?? 'all';
  if (!validName(name)) throw new TypeError('Invalid font family');
  if (language === 'all') {
    const fontId = services.wasm.findOrCreateFontId(name);
    if (fontId < 0) throw new Error('글꼴을 적용하지 못했습니다.');
    services.eventBus.emit('format-char', { fontId }); return;
  }
  const current = params?.currentFontFamilies;
  if (!Number.isInteger(language) || typeof language !== 'number' || language < 0 || language > 6
    || !Array.isArray(current) || current.length !== 7 || !current.every(validName)) throw new TypeError('Invalid font language');
  const fontIds = current.map((family, index) => services.wasm.findOrCreateFontIdForLang(index, index === language ? name : family));
  if (fontIds.some(id => id < 0)) throw new Error('글꼴을 적용하지 못했습니다.');
  services.eventBus.emit('format-char', { fontIds });
}

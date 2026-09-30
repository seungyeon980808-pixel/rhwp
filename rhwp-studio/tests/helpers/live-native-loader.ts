import { readFile } from 'node:fs/promises';
import { registerHooks, stripTypeScriptTypes } from 'node:module';

const srcRoot = new URL('../../src/', import.meta.url);
registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === '@wasm/rhwp.js') return nextResolve(new URL('../../../pkg/rhwp.js', import.meta.url).href, context);
    if (specifier.startsWith('@/')) return nextResolve(new URL(`${specifier.slice(2)}.ts`, srcRoot).href, context);
    if (context.parentURL?.startsWith(srcRoot.href) && /^\.{1,2}\//.test(specifier) && !/\.[a-z]+$/.test(specifier)) return nextResolve(`${specifier}.ts`, context);
    return nextResolve(specifier, context);
  },
  load(url, context, nextLoad) {
    const result = nextLoad(url, context);
    if (!url.endsWith('.ts') || result.source === undefined || result.source === null) return result;
    return { ...result, format: 'module', source: stripTypeScriptTypes(String(result.source).replaceAll('import.meta.env', '({ DEV: false })'), { mode: 'transform' }) };
  },
});
const { default: init } = await import('../../../pkg/rhwp.js');
await init({ module_or_path: await readFile(new URL('../../../pkg/rhwp_bg.wasm', import.meta.url)) });

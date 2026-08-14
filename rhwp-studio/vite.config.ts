import { defineConfig } from 'vite';
import { resolve, extname, join } from 'path';
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readFile,
  readdirSync,
  rmSync,
  statSync,
} from 'fs';
import type { ResolvedConfig } from 'vite';
import { VitePWA } from 'vite-plugin-pwa';

const pkg = JSON.parse(readFileSync(resolve(__dirname, 'package.json'), 'utf-8'));
const subsecondWasmDir = resolve(
  __dirname,
  '..',
  'target',
  'rhwp-subsecond-vite',
);
const useSubsecondWasm = process.env.RHWP_SUBSECOND === '1';
const publicFontsDir = resolve(__dirname, 'public', 'fonts');
const bundledFontsDir = resolve(__dirname, '..', 'assets', 'fonts');

function isBrokenWindowsFontSymlinkCheckout(): boolean {
  try {
    return statSync(publicFontsDir).isFile() && statSync(bundledFontsDir).isDirectory();
  } catch {
    return false;
  }
}

function windowsFontSymlinkFallbackPlugin() {
  let resolvedConfig: ResolvedConfig | null = null;
  return {
    name: 'windows-font-symlink-fallback',
    configResolved(config: ResolvedConfig) {
      resolvedConfig = config;
    },
    configureServer(server: { middlewares: { use: Function } }) {
      if (!isBrokenWindowsFontSymlinkCheckout()) return;
      server.middlewares.use('/fonts', (req: { url?: string }, res: any, next: Function) => {
        if (!req.url) return next();
        const fileName = decodeURIComponent(req.url.split('?')[0]).replace(/^\/+/, '');
        if (!/^[A-Za-z0-9._-]+$/.test(fileName)) {
          res.statusCode = 403;
          return res.end();
        }
        const fullPath = join(bundledFontsDir, fileName);
        readFile(fullPath, (error: NodeJS.ErrnoException | null, data: Buffer) => {
          if (error) {
            res.statusCode = 404;
            return res.end();
          }
          const extension = extname(fullPath).toLowerCase();
          const mimeTypes: Record<string, string> = {
            '.woff': 'font/woff',
            '.woff2': 'font/woff2',
            '.ttf': 'font/ttf',
            '.otf': 'font/otf',
          };
          res.setHeader('Content-Type', mimeTypes[extension] ?? 'application/octet-stream');
          return res.end(data);
        });
      });
    },
    writeBundle() {
      if (!resolvedConfig || !isBrokenWindowsFontSymlinkCheckout()) return;
      const outputDir = resolve(resolvedConfig.root, resolvedConfig.build.outDir);
      const outputFontsDir = join(outputDir, 'fonts');
      if (existsSync(outputFontsDir)) rmSync(outputFontsDir, { recursive: true, force: true });
      mkdirSync(outputFontsDir, { recursive: true });
      for (const entry of readdirSync(bundledFontsDir, { withFileTypes: true })) {
        if (entry.isFile()) {
          copyFileSync(join(bundledFontsDir, entry.name), join(outputFontsDir, entry.name));
        }
      }
    },
  };
}

export default defineConfig({
  define: {
    __APP_VERSION__: JSON.stringify(pkg.version),
    // 셀프 호스팅 빌드에서 외부(CDN) 웹폰트 로드를 빌드 시점에 끈다.
    // 확장 storage 설정(disableExternalWebFonts)이 있으면 그 값이 우선한다.
    __RHWP_DISABLE_EXTERNAL_WEBFONTS__: JSON.stringify(
      process.env.RHWP_DISABLE_EXTERNAL_WEBFONTS === '1',
    ),
  },
  resolve: {
    alias: {
      '@': resolve(__dirname, 'src'),
      '@wasm/rhwp.js': useSubsecondWasm
        ? resolve(subsecondWasmDir, 'rhwp-subsecond.js')
        : resolve(__dirname, '..', 'pkg', 'rhwp.js'),
      '@wasm': resolve(__dirname, '..', 'pkg'),
    },
  },
  server: {
    host: '127.0.0.1',
    port: 7700,
    proxy: useSubsecondWasm ? {
      '/_dioxus': {
        target: 'http://127.0.0.1:7711',
        ws: true,
      },
      '/wasm': {
        target: 'http://127.0.0.1:7711',
      },
    } : undefined,
    fs: {
      // [Task #741 후속] 외부 file path 그림 영역 영역 samples/ dir 영역 영역 fetch 가능 영역.
      allow: [
        __dirname,
        resolve(__dirname, '..', 'pkg'),
        subsecondWasmDir,
        resolve(__dirname, '..', 'samples'),
        resolve(__dirname, '..', 'npm', 'editor'),
      ],
    },
    watch: {
      ignored: ['**/librhwp-subsecond-patch-*.wasm'],
    },
  },
  plugins: [
    windowsFontSymlinkFallbackPlugin(),
    {
      name: 'ignore-subsecond-patch-artifacts',
      handleHotUpdate(context) {
        if (/librhwp-subsecond-patch-\d+\.wasm$/.test(context.file)) {
          return [];
        }
      },
    },
    // [Task #741 후속] dev 서버 영역 영역 /samples/* 경로 영역 영역 parent samples/ dir 영역
    // 영역 정적 serve 영역 — wasm-bridge.ts 영역 영역 외부 image fetch 영역 영역 영역.
    {
      name: 'serve-samples-dir',
      configureServer(server) {
        const samplesDir = resolve(__dirname, '..', 'samples');
        server.middlewares.use('/samples', (req, res, next) => {
          if (!req.url) return next();
          // URL decode + sanitize (path traversal 차단)
          const reqPath = decodeURIComponent(req.url.split('?')[0]);
          const relPath = reqPath.replace(/^\/+/, '');
          if (relPath.includes('..')) { res.statusCode = 403; return res.end(); }
          const full = join(samplesDir, relPath);
          if (!full.startsWith(samplesDir)) { res.statusCode = 403; return res.end(); }
          readFile(full, (err: NodeJS.ErrnoException | null, data: Buffer) => {
            if (err) { res.statusCode = 404; return res.end(); }
            const ext = extname(full).toLowerCase();
            const mime: Record<string, string> = {
              '.gif': 'image/gif', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
              '.png': 'image/png', '.bmp': 'image/bmp', '.webp': 'image/webp',
            };
            res.setHeader('Content-Type', mime[ext] ?? 'application/octet-stream');
            // [Task #741 후속] OS 영역 절대 경로 영역 영역 response header 영역 노출 — JS
            // 영역 영역 dialog 영역 영역 한컴 viewer 정합 (D:\\... 영역 영역 영역 의 영역 영역) 영역.
            res.setHeader('X-File-Path', encodeURI(full));
            res.setHeader('Access-Control-Expose-Headers', 'X-File-Path');
            res.end(data);
          });
        });
      },
    },
    ...(process.env.RHWP_DISABLE_PWA === '1' ? [] : [VitePWA({
      registerType: 'autoUpdate',
      includeAssets: ['favicon.ico', 'icons/*.png'],
      manifest: {
        name: 'rhwp-studio',
        short_name: 'rhwp',
        description: 'HWP/HWPX/HML 뷰어·에디터 — 알(R), 모두의 한글',
        lang: 'ko',
        theme_color: '#2b6cb0',
        background_color: '#ffffff',
        display: 'standalone',
        start_url: '/rhwp/',
        scope: '/rhwp/',
        file_handlers: [
          {
            action: '/rhwp/',
            accept: {
              'application/x-hwp': ['.hwp'],
              'application/hwp+zip': ['.hwpx'],
              'application/xml': ['.hml'],
              'text/xml': ['.hml'],
            },
          },
        ],
        icons: [
          { src: 'icons/icon-128.png', sizes: '128x128', type: 'image/png' },
          { src: 'icons/icon-192.png', sizes: '192x192', type: 'image/png' },
          { src: 'icons/icon-256.png', sizes: '256x256', type: 'image/png' },
          { src: 'icons/icon-512.png', sizes: '512x512', type: 'image/png' },
          { src: 'icons/icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'any maskable' },
        ],
      },
      workbox: {
        // WASM (~12 MB) is kept out of precache to avoid blocking SW installation;
        // CacheFirst at runtime still gives offline access after the first load.
        globPatterns: ['**/*.{js,css,html,png,svg,ico,woff,woff2,ttf,otf}'],
        maximumFileSizeToCacheInBytes: 20 * 1024 * 1024,
        runtimeCaching: [
          {
            urlPattern: /\.wasm$/,
            handler: 'CacheFirst',
            options: {
              cacheName: 'wasm-cache',
              expiration: { maxEntries: 5, maxAgeSeconds: 30 * 24 * 60 * 60 },
            },
          },
        ],
      },
      devOptions: {
        enabled: false,
      },
    })]),
  ],
});

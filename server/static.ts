// Serves the built client from memory. The whole of dist/web is a few hundred
// KB, so it is read once at startup rather than from disk on every request.

import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { extname, join, relative } from 'node:path';
import type { Config } from './config.ts';
import { send, type Context } from './http.ts';

const TYPES: Record<string, string> = {
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.webmanifest': 'application/manifest+json',
  '.txt': 'text/plain; charset=utf-8',
};

/**
 * Scripts only from this origin. Styles and fonts also from Google Fonts, so a
 * list's custom CSS can @import a typeface; images from anywhere over https,
 * because image columns hold links to pictures on other sites.
 */
const CSP = [
  "default-src 'none'",
  "script-src 'self'",
  "style-src 'self' https://fonts.googleapis.com",
  "font-src 'self' https://fonts.gstatic.com data:",
  "img-src 'self' https: data:",
  "connect-src 'self'",
  "manifest-src 'self'",
  "base-uri 'self'",
  "form-action 'self'",
  "frame-ancestors 'none'",
].join('; ');

const LIST_PATH = /^[a-z0-9][a-z0-9-]{0,63}$/;

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    return statSync(path).isDirectory() ? walk(path) : [path];
  });
}

export function createStatic(config: Config) {
  const files = new Map<string, Buffer>();
  let shell: string | undefined;

  if (existsSync(join(config.webDir, 'index.html'))) {
    for (const path of walk(config.webDir)) files.set(relative(config.webDir, path).split('\\').join('/'), readFileSync(path));
    // Asset URLs in the build are relative, and list pages sit one level below
    // the base, so a <base> pins them to it wherever the app is mounted.
    shell = files
      .get('index.html')!
      .toString('utf8')
      .replace(/<head>/i, `<head>\n    <base href="${config.basePath}">`);
    files.delete('index.html');
  } else {
    console.warn(`No client build in ${config.webDir}; run "npm run build". The API still works.`);
  }

  function page(ctx: Context, indexable: boolean): void {
    if (!shell) {
      send(ctx.res, 503, 'The web client has not been built. Run "npm run build".', { 'Content-Type': 'text/plain' });
      return;
    }
    send(ctx.res, 200, shell, {
      'Content-Type': 'text/html; charset=utf-8',
      'Cache-Control': 'no-cache',
      'Content-Security-Policy': CSP,
      'X-Content-Type-Options': 'nosniff',
      'X-Frame-Options': 'DENY',
      // Links out of a list (shops, photos) learn nothing about which list.
      'Referrer-Policy': 'strict-origin-when-cross-origin',
      ...(indexable ? {} : { 'X-Robots-Tag': 'noindex, nofollow' }),
    });
  }

  return function handleStatic(ctx: Context): boolean {
    if (ctx.req.method !== 'GET' && ctx.req.method !== 'HEAD') return false;

    const file = files.get(ctx.path);
    if (file) {
      send(ctx.res, 200, file, {
        'Content-Type': TYPES[extname(ctx.path)] ?? 'application/octet-stream',
        'X-Content-Type-Options': 'nosniff',
        // Vite fingerprints everything under assets/, so those never change meaning.
        'Cache-Control': ctx.path.startsWith('assets/') ? 'public, max-age=31536000, immutable' : 'public, max-age=3600',
      });
      return true;
    }

    if (ctx.path === '') {
      page(ctx, true);
      return true;
    }
    if (ctx.path === 'admin' || LIST_PATH.test(ctx.path)) {
      page(ctx, false);
      return true;
    }
    // "abc/" is the same list as "abc".
    const trimmed = ctx.path.replace(/\/+$/, '');
    if (trimmed !== ctx.path && (trimmed === 'admin' || LIST_PATH.test(trimmed))) {
      ctx.res.writeHead(301, { Location: `${config.basePath}${trimmed}` });
      ctx.res.end();
      return true;
    }
    return false;
  };
}

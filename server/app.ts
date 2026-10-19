import { createServer, type IncomingMessage, type Server } from 'node:http';
import type { TLSSocket } from 'node:tls';
import { join } from 'node:path';
import type { Config } from './config.ts';
import { createApi } from './api.ts';
import { startBackups } from './backup.ts';
import { AppError } from './errors.ts';
import { send, sendError, type Context } from './http.ts';
import { Lookups } from './lookups.ts';
import type { Preview } from './extract.ts';
import { createMcp } from './mcp.ts';
import { ListService } from './service.ts';
import { createStatic } from './static.ts';
import { Store } from './store.ts';

function first(header: string | string[] | undefined): string | undefined {
  const value = Array.isArray(header) ? header[0] : header;
  return value?.split(',')[0].trim() || undefined;
}

export interface App {
  server: Server;
  store: Store;
  service: ListService;
  close(): Promise<void>;
}

export interface AppOptions {
  /** Stands in for fetching real pages, in tests. */
  fetchPreview?: (url: string) => Promise<Preview>;
}

export function createApp(config: Config, options: AppOptions = {}): App {
  const store = new Store(join(config.dataDir, 'shared-list.db'));
  const lookups = new Lookups(store, config.limits, options.fetchPreview);
  const service = new ListService(store, config.limits, config.basePath, lookups);
  lookups.resume();
  const api = createApi({ config, service });
  const mcp = createMcp({ config, service });
  const web = createStatic(config);
  startBackups(store, join(config.dataDir, 'backups'), config.backupKeep);

  function context(req: IncomingMessage, res: Context['res']): Context | undefined {
    const proto = config.trustProxy
      ? first(req.headers['x-forwarded-proto']) ?? 'http'
      : (req.socket as TLSSocket).encrypted ? 'https' : 'http';
    const host = first(req.headers['x-forwarded-host']) && config.trustProxy
      ? first(req.headers['x-forwarded-host'])!
      : req.headers.host ?? 'localhost';
    const ip = (config.trustProxy ? first(req.headers['x-real-ip']) ?? first(req.headers['x-forwarded-for']) : undefined)
      ?? req.socket.remoteAddress
      ?? 'unknown';

    let url: URL;
    try {
      url = new URL(req.url ?? '/', `${proto}://${host}`);
    } catch {
      return undefined;
    }
    if (!url.pathname.startsWith(config.basePath)) return undefined;
    return {
      req,
      res,
      url,
      path: url.pathname.slice(config.basePath.length),
      ip,
      origin: `${proto}://${host}`,
      secure: proto === 'https',
    };
  }

  const server = createServer(async (req, res) => {
    const ctx = context(req, res);
    if (!ctx) {
      // "/shared-list" is the app too; anything else outside the base is not ours.
      if (req.url?.split('?')[0] + '/' === config.basePath) {
        res.writeHead(301, { Location: config.basePath });
        res.end();
      } else {
        send(res, 404, 'Not found', { 'Content-Type': 'text/plain; charset=utf-8' });
      }
      return;
    }
    try {
      if (ctx.path === 'healthz') {
        send(res, 200, 'ok', { 'Content-Type': 'text/plain', 'Cache-Control': 'no-store' });
        return;
      }
      if (await mcp(ctx)) return;
      if (await api(ctx)) return;
      if (web(ctx)) return;
      throw new AppError('not_found', 'Not found');
    } catch (error) {
      if (res.headersSent) res.destroy();
      else sendError(res, error);
    }
  });

  return {
    server,
    store,
    service,
    close: () =>
      new Promise((resolve) => {
        server.close(() => {
          store.close();
          resolve();
        });
        server.closeAllConnections();
      }),
  };
}

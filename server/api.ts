// The JSON API the web client uses. A list is opened with its password, which
// sets a cookie for that list alone; the admin token, sent as a bearer token,
// opens every list and is the only way to create, delete or re-key one.

import type { Config } from './config.ts';
import {
  FailureLimiter,
  SESSION_DAYS,
  cookieName,
  parseCookies,
  readSession,
  safeEqual,
  sessionCookie,
  signSession,
} from './auth.ts';
import { AppError } from './errors.ts';
import { bearer, json, readJson, send, type Context } from './http.ts';
import type { ListService } from './service.ts';
import type { ListRow } from './store.ts';
import type { Role } from '../shared/types.ts';

type Handler = (ctx: Context, params: string[]) => Promise<void>;

export interface ApiDeps {
  config: Config;
  service: ListService;
}

const ID = '([a-z0-9-]{1,64})';
const SEGMENT = '([^/]{1,80})';

export function createApi({ config, service }: ApiDeps) {
  // Ten wrong passwords per list per address every 15 minutes, and forty across
  // all lists, which is plenty for a typo and useless for guessing.
  const listFailures = new FailureLimiter(10, 15 * 60_000);
  const addressFailures = new FailureLimiter(40, 15 * 60_000);
  const adminFailures = new FailureLimiter(10, 15 * 60_000);

  const linkOrigin = (ctx: Context) => config.publicUrl || ctx.origin;

  function rateLimited(seconds: number): AppError {
    const error = new AppError('rate_limited', `Too many wrong attempts. Try again in ${Math.ceil(seconds / 60)} minute${seconds > 60 ? 's' : ''}.`);
    error.retryAfter = seconds;
    return error;
  }

  /** True for a valid admin token, false for none; a wrong token is an error rather than a quiet downgrade. */
  function isAdmin(ctx: Context): boolean {
    const token = bearer(ctx.req);
    if (!token) return false;
    const key = ctx.ip;
    const wait = adminFailures.blockedFor(key);
    if (wait) throw rateLimited(wait);
    if (safeEqual(token, config.adminToken)) return true;
    adminFailures.fail(key);
    throw new AppError('unauthorized', 'That admin token is not valid.');
  }

  function requireAdmin(ctx: Context): void {
    if (!isAdmin(ctx)) throw new AppError('unauthorized', 'This needs the admin token.');
  }

  function access(ctx: Context, id: string): { row: ListRow; role: Role } {
    const admin = isAdmin(ctx);
    const row = service.get(id);
    if (admin) return { row, role: 'admin' };
    const session = readSession(parseCookies(ctx.req.headers.cookie).get(cookieName(id)), config.sessionSecret);
    if (session && session.list === row.id && session.epoch === row.auth_epoch) {
      return { row, role: row.editable ? 'editor' : 'viewer' };
    }
    throw new AppError('unauthorized', 'This list is locked. Enter its password to open it.');
  }

  function editor(ctx: Context, id: string): Role {
    const { row, role } = access(ctx, id);
    if (role === 'viewer') throw new AppError('forbidden', `"${row.title}" is view-only.`);
    return role;
  }

  /**
   * Cookies ride along on cross-site requests too, so a write has to prove it
   * came from this site's own pages. Scripts and agents send neither header.
   */
  function sameSite(ctx: Context): void {
    const site = ctx.req.headers['sec-fetch-site'];
    const origin = ctx.req.headers.origin;
    if ((site && site !== 'same-origin' && site !== 'none') || (origin && origin !== ctx.origin)) {
      throw new AppError('forbidden', 'Cross-site requests are not accepted.');
    }
  }

  const body = (ctx: Context) => readJson(ctx.req, config.limits.maxBodyBytes);
  const reply = (ctx: Context, row: ListRow, role: Role, extra: Record<string, unknown> = {}) =>
    json(ctx.res, 200, { list: service.payload(row, role, linkOrigin(ctx)), ...extra });

  const routes: [string, RegExp, Handler][] = [
    ['GET', /^api\/admin$/, async (ctx) => {
      requireAdmin(ctx);
      json(ctx.res, 200, { ok: true, lists: service.summaries(linkOrigin(ctx)) });
    }],

    ['POST', /^api\/lists$/, async (ctx) => {
      requireAdmin(ctx);
      const row = await service.create(await body(ctx));
      reply(ctx, row, 'admin');
    }],

    ['GET', new RegExp(`^api/lists/${ID}$`), async (ctx, [id]) => {
      const { row, role } = access(ctx, id);
      if (ctx.url.searchParams.get('since') === String(row.version)) {
        ctx.res.writeHead(204, { 'Cache-Control': 'no-store' });
        ctx.res.end();
        return;
      }
      reply(ctx, row, role);
    }],

    ['POST', new RegExp(`^api/lists/${ID}/unlock$`), async (ctx, [id]) => {
      const listKey = `${ctx.ip} ${id}`;
      const wait = Math.max(listFailures.blockedFor(listKey), addressFailures.blockedFor(ctx.ip));
      if (wait) throw rateLimited(wait);
      const { password } = await body(ctx);
      let row: ListRow;
      try {
        row = await service.checkPassword(id, password);
      } catch (error) {
        listFailures.fail(listKey);
        addressFailures.fail(ctx.ip);
        throw error;
      }
      listFailures.clear(listKey);
      const expires = Date.now() + SESSION_DAYS * 86_400_000;
      const token = signSession({ list: row.id, epoch: row.auth_epoch, expires }, config.sessionSecret);
      ctx.res.setHeader(
        'Set-Cookie',
        sessionCookie(cookieName(row.id), token, config.basePath, ctx.secure, SESSION_DAYS * 86_400),
      );
      reply(ctx, row, row.editable ? 'editor' : 'viewer');
    }],

    ['POST', new RegExp(`^api/lists/${ID}/lock$`), async (ctx, [id]) => {
      ctx.res.setHeader('Set-Cookie', sessionCookie(cookieName(id), '', config.basePath, ctx.secure, 0));
      json(ctx.res, 200, { ok: true });
    }],

    ['PATCH', new RegExp(`^api/lists/${ID}$`), async (ctx, [id]) => {
      const role = editor(ctx, id);
      const patch = await body(ctx);
      const adminFields = patch.password !== undefined || patch.editable !== undefined;
      if (adminFields && role !== 'admin') throw new AppError('forbidden', 'Changing the password or edit access needs the admin token.');
      let row = service.updateList(id, patch);
      if (adminFields) row = await service.updateAdmin(id, patch);
      reply(ctx, row, role);
    }],

    ['DELETE', new RegExp(`^api/lists/${ID}$`), async (ctx, [id]) => {
      requireAdmin(ctx);
      service.delete(id);
      json(ctx.res, 200, { ok: true });
    }],

    ['GET', new RegExp(`^api/lists/${ID}/style\\.css$`), async (ctx, [id]) => {
      const { row } = access(ctx, id);
      send(ctx.res, 200, row.css, {
        'Content-Type': 'text/css; charset=utf-8',
        // The page asks for it with ?v=<revision>, so a changed sheet is a new URL.
        'Cache-Control': 'private, max-age=31536000, immutable',
      });
    }],

    ['PUT', new RegExp(`^api/lists/${ID}/css$`), async (ctx, [id]) => {
      const role = editor(ctx, id);
      const { css } = await body(ctx);
      reply(ctx, service.setCss(id, css ?? ''), role);
    }],

    ['POST', new RegExp(`^api/lists/${ID}/columns$`), async (ctx, [id]) => {
      const role = editor(ctx, id);
      const input = await body(ctx);
      const columns = Array.isArray(input.columns) ? input.columns : [input];
      const position = typeof input.position === 'number' ? input.position : undefined;
      const { row, result } = service.addColumns(id, columns, position);
      reply(ctx, row, role, { columns: result });
    }],

    ['PATCH', new RegExp(`^api/lists/${ID}/columns/${SEGMENT}$`), async (ctx, [id, column]) => {
      const role = editor(ctx, id);
      const { row, result } = service.updateColumn(id, decodeURIComponent(column), await body(ctx));
      reply(ctx, row, role, { cleared: result.cleared });
    }],

    ['DELETE', new RegExp(`^api/lists/${ID}/columns/${SEGMENT}$`), async (ctx, [id, column]) => {
      const role = editor(ctx, id);
      reply(ctx, service.removeColumn(id, decodeURIComponent(column)).row, role);
    }],

    ['POST', new RegExp(`^api/lists/${ID}/items$`), async (ctx, [id]) => {
      const role = editor(ctx, id);
      const input = await body(ctx);
      const items = Array.isArray(input.items) ? input.items : [input.values ?? {}];
      const position = typeof input.position === 'number' ? input.position : undefined;
      const { row, result } = service.addItems(id, items, position);
      reply(ctx, row, role, { items: result });
    }],

    ['PATCH', new RegExp(`^api/lists/${ID}/items/${SEGMENT}$`), async (ctx, [id, item]) => {
      const role = editor(ctx, id);
      const { values } = await body(ctx);
      reply(ctx, service.updateItems(id, [{ item_id: item, values }]).row, role);
    }],

    ['DELETE', new RegExp(`^api/lists/${ID}/items/${SEGMENT}$`), async (ctx, [id, item]) => {
      const role = editor(ctx, id);
      reply(ctx, service.removeItems(id, [item]).row, role);
    }],

    ['POST', new RegExp(`^api/lists/${ID}/items/${SEGMENT}/move$`), async (ctx, [id, item]) => {
      const role = editor(ctx, id);
      const { index } = await body(ctx);
      reply(ctx, service.moveItem(id, item, index), role);
    }],
  ];

  return async function handleApi(ctx: Context): Promise<boolean> {
    if (!ctx.path.startsWith('api/')) return false;
    const method = ctx.req.method ?? 'GET';
    let pathMatched = false;
    for (const [routeMethod, pattern, handler] of routes) {
      const match = pattern.exec(ctx.path);
      if (!match) continue;
      pathMatched = true;
      if (routeMethod !== method) continue;
      if (method !== 'GET') sameSite(ctx);
      await handler(ctx, match.slice(1));
      return true;
    }
    if (pathMatched) {
      json(ctx.res, 405, { error: { code: 'method_not_allowed', message: `${method} is not supported here.` } });
      return true;
    }
    throw new AppError('not_found', 'No such API route.');
  };
}


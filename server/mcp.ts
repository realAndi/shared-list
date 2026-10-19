// MCP over Streamable HTTP, stateless: every POST gets a fresh server and
// transport, so there is no session to keep, expire or lose on a restart. The
// credential is an MCP token made with the CLI, sent as a bearer token or, for
// clients that can only be given a URL, as the last path segment (/mcp/<token>).
//
// A token sees the lists it created, and the lists it has opened with their
// password (open_list), so a token handed to someone shows them nobody else's.

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { z } from 'zod';
import type { Config } from './config.ts';
import { RateLimiter } from './auth.ts';
import { AppError } from './errors.ts';
import { bearer, json, readBody, type Context } from './http.ts';
import type { ListService } from './service.ts';
import type { ListRow, TokenRow } from './store.ts';
import { verifyToken } from './tokens.ts';
import { STYLE_GUIDE } from '../shared/styleguide.ts';
import { PRESETS } from '../shared/presets.ts';
import { COLUMN_TYPES, COLUMN_WIDTHS, TAG_COLORS, type Role } from '../shared/types.ts';

const INSTRUCTIONS = `Shared List hosts password-protected lists that people open from a link on a phone or computer, like a small, good-looking spreadsheet.

A list has typed columns and rows (items). Refer to a column by its name or its id; item values are keyed the same way. Each list can also carry its own CSS, which restyles the page everyone sees: call get_style_guide before writing any.

Every list needs a password. When you create one, tell the person its link and password so they can share both. Prefer one add_items call with many rows over many single calls.

Links added to a link column are looked up in the background: the row's empty price, photo and name are filled from the page, and the item's "links" field says how the lookup went. preview_link reads a page without saving anything.

This token sees the lists it created and the ones it has opened. To work on a list someone else made, ask the person for its password and call open_list.`;

const COLUMN_TYPE_HELP =
  'text, number, currency (a number shown as money), url (a link), image (a link to a picture, shown as a thumbnail), checkbox (true/false; the first one marks a row as done), select (one of a set of labeled, colored options), date (YYYY-MM-DD).';

const VALUES_HELP =
  'Object of column (name or id) → value. text: string. number/currency: number ("$1,299" also works). checkbox: true/false. url/image: http(s) link. select: an option label; a new label becomes a new option. date: YYYY-MM-DD. null empties a cell.';

const cellValue = z.union([z.string(), z.number(), z.boolean(), z.null()]);
const values = z.record(z.string(), cellValue).describe(VALUES_HELP);
const option = z.union([
  z.string(),
  z.object({
    value: z.string(),
    color: z.enum(TAG_COLORS).optional(),
    from: z.string().optional().describe('Rename: the option label this one replaces. Rows keep their choice under the new label.'),
  }),
]);
// How a column looks and behaves, shared by add_columns and update_column.
const display = {
  width: z.enum(COLUMN_WIDTHS).optional().describe('Room the column gets on a wide screen. normal is the default.'),
  hidden: z.boolean().optional().describe('true leaves the column out of the table and phone layout; it still shows when a row is opened, and keeps its values.'),
  lookup: z.boolean().optional().describe('url only. Whether a link added here is looked up to fill the row. On by default.'),
  fill: z
    .object({
      price: z.string().nullable().optional().describe('A money or number column, or null to never fill a price.'),
      image: z.string().nullable().optional().describe('An image column, or null.'),
      title: z.string().nullable().optional().describe('A text column for the product name, or null.'),
    })
    .nullable()
    .optional()
    .describe('url only. Which columns a lookup fills, by name or id. Left out, it fills the first money column, the first image column and the row name. null goes back to that.'),
};
const column = z.object({
  name: z.string().describe('Header text.'),
  type: z.enum(COLUMN_TYPES).optional().describe(`Defaults to text. ${COLUMN_TYPE_HELP}`),
  options: z.array(option).optional().describe(`select only. Labels, or { value, color } with color one of ${TAG_COLORS.join(', ')}.`),
  currency: z.string().optional().describe('currency only. ISO 4217 code; defaults to USD.'),
  ...display,
});
const sort = {
  sort_by: z.string().nullable().optional().describe('A column to order rows by for everyone who has not picked their own order, or null for the list order.'),
  sort_dir: z.enum(['asc', 'desc']).optional().describe('With sort_by. asc unless set.'),
};
const listId = z.string().describe('The list id: the last part of its link.');

function ok(data: unknown) {
  return { content: [{ type: 'text' as const, text: JSON.stringify(data, null, 2) }] };
}

async function run(fn: () => unknown | Promise<unknown>) {
  try {
    return ok(await fn());
  } catch (error) {
    if (error instanceof AppError) return { isError: true, content: [{ type: 'text' as const, text: error.message }] };
    throw error;
  }
}

interface Deps {
  service: ListService;
  token: TokenRow;
  origin: string;
  passwordFailures: RateLimiter;
}

function buildServer({ service, token, origin, passwordFailures }: Deps): McpServer {
  const server = new McpServer({ name: 'shared-list', version: '1.0.0' }, { instructions: INSTRUCTIONS });
  const brief = (row: ListRow) => ({ id: row.id, url: service.link(row.id, origin), title: row.title, version: row.version });

  /** What this token may do with a list: `own` is the token that made it. */
  function access(id: string, need: 'read' | 'edit' | 'own' = 'edit'): { row: ListRow; role: Role } {
    const row = service.get(id);
    let role: Role;
    if (row.owner_token === token.id) role = 'owner';
    else if (service.store.grantEpoch(token.id, row.id) === row.auth_epoch) role = row.editable ? 'editor' : 'viewer';
    else throw new AppError('forbidden', `This token has not opened "${id}". Ask for the list's password and call open_list.`);
    if (need === 'edit' && role === 'viewer') throw new AppError('forbidden', `"${row.title}" is view-only for this token.`);
    if (need === 'own' && role !== 'owner') throw new AppError('forbidden', `Only the token that created "${row.title}" can do that.`);
    return { row, role };
  }

  const edit = (id: string) => access(id, 'edit');
  const view = (row: ListRow, role: Role) => service.payload(row, role, origin);

  server.registerTool('list_lists', {
    title: 'List my lists',
    description: 'The lists this token created or has opened: id, title, link, item count and when each last changed, most recent first.',
    annotations: { readOnlyHint: true },
  }, () => run(() => ({ lists: service.summariesFor(token.id, origin) })));

  server.registerTool('open_list', {
    title: 'Open a list with its password',
    description: 'Give this token access to a list someone else made, using the password from its owner. Access lasts until the list\'s password changes. Returns the list.',
    inputSchema: { list_id: listId, password: z.string() },
  }, ({ list_id, password }) => run(async () => {
    const key = `${token.id} ${list_id}`;
    const wait = passwordFailures.blockedFor(key);
    if (wait) throw new AppError('rate_limited', `Too many wrong passwords for "${list_id}". Try again in ${Math.ceil(wait / 60)} minutes.`);
    let row: ListRow;
    try {
      row = await service.checkPassword(list_id, password);
    } catch (error) {
      passwordFailures.hit(key);
      throw error;
    }
    passwordFailures.clear(key);
    if (row.owner_token !== token.id) service.store.grant(token.id, row.id, row.auth_epoch);
    return view(row, row.owner_token === token.id ? 'owner' : row.editable ? 'editor' : 'viewer');
  }));

  server.registerTool('get_list', {
    title: 'Read a list',
    description: 'A list with its columns, every item (with item ids) and its view settings. Use it before editing so you know the column ids and item ids.',
    inputSchema: { list_id: listId },
    annotations: { readOnlyHint: true },
  }, ({ list_id }) => run(() => {
    const { row, role } = access(list_id, 'read');
    return view(row, role);
  }));

  server.registerTool('create_list', {
    title: 'Create a list',
    description: `Create a password-protected list and return its link. Give it columns, or a preset (${Object.entries(PRESETS)
      .map(([name, p]) => `${name}: ${p.columns.map((c) => c.name).join(', ')}`)
      .join('; ')}). Items and CSS can be included or added later.`,
    inputSchema: {
      title: z.string().describe('Shown at the top of the list.'),
      password: z.string().describe('At least 4 characters. Everyone who opens the link needs it.'),
      id: z.string().optional().describe('Custom link id, e.g. "apartment-furniture" (3–48 lowercase letters, digits, dashes). Random if left out.'),
      description: z.string().optional().describe('A line or two under the title.'),
      preset: z.enum(Object.keys(PRESETS) as [string, ...string[]]).optional().describe('Starting columns, used when columns is left out.'),
      columns: z.array(column).optional(),
      items: z.array(values).optional().describe('Rows to start with.'),
      group_by: z.string().optional().describe('A select or checkbox column to group rows under.'),
      ...sort,
      editable: z.boolean().optional().describe('Whether people with the password can edit (default true). false makes it view-only for everyone but this token.'),
      css: z.string().optional().describe('Custom CSS. Read get_style_guide first.'),
    },
  }, (args) => run(async () => {
    const row = await service.create(args, token.id);
    return { ...brief(row), password: args.password, columns: row.doc.columns, items: row.doc.items.length };
  }));

  server.registerTool('update_list', {
    title: 'Change list settings',
    description: 'Change the title, description, grouping, password or edit access of a list. Only the fields you send change. A new password signs everyone out. Only the token that created a list can change editable.',
    inputSchema: {
      list_id: listId,
      title: z.string().optional(),
      description: z.string().optional(),
      group_by: z.string().nullable().optional().describe('A select or checkbox column, or null for no grouping.'),
      ...sort,
      password: z.string().optional(),
      editable: z.boolean().optional(),
    },
  }, ({ list_id, password, editable, ...patch }) => run(async () => {
    const { row: current } = access(list_id, editable === undefined ? 'edit' : 'own');
    let row = service.updateList(list_id, patch);
    if (password !== undefined || editable !== undefined) {
      row = await service.updateAccess(list_id, { password, editable });
      // Keep this token's own way in past the new password.
      if (password !== undefined && current.owner_token !== token.id) service.store.grant(token.id, row.id, row.auth_epoch);
    }
    return { ...brief(row), editable: row.editable, description: row.doc.description, view: row.doc.view };
  }));

  server.registerTool('delete_list', {
    title: 'Delete a list',
    description: 'Permanently delete a list, its items and its CSS. Confirm with the person first.',
    inputSchema: { list_id: listId },
    annotations: { destructiveHint: true },
  }, ({ list_id }) => run(() => {
    edit(list_id);
    service.delete(list_id);
    return { deleted: list_id };
  }));

  server.registerTool('add_columns', {
    title: 'Add columns',
    description: `Add columns to a list. ${COLUMN_TYPE_HELP}`,
    inputSchema: {
      list_id: listId,
      columns: z.array(column).min(1),
      position: z.number().int().optional().describe('Index to insert at; 0 is first. Appends when left out.'),
    },
  }, ({ list_id, columns, position }) => run(() => {
    edit(list_id);
    const { row, result } = service.addColumns(list_id, columns, position);
    return { ...brief(row), added: result, columns: row.doc.columns };
  }));

  server.registerTool('update_column', {
    title: 'Change a column',
    description: 'Rename, retype, reorder, resize or hide a column, change its options, or set what a link column looks up. Only what you send changes. Retyping keeps values that still make sense (text "12" becomes the number 12) and empties the rest; the result says how many were emptied. Sending options replaces the whole set.',
    inputSchema: {
      list_id: listId,
      column: z.string().describe('Column name or id.'),
      name: z.string().optional(),
      type: z.enum(COLUMN_TYPES).optional(),
      options: z.array(option).optional(),
      currency: z.string().optional(),
      position: z.number().int().optional().describe('New index; 0 is first.'),
      ...display,
    },
  }, ({ list_id, column: key, ...patch }) => run(() => {
    edit(list_id);
    const { row, result } = service.updateColumn(list_id, key, patch);
    return { ...brief(row), column: result.column, cleared: result.cleared };
  }));

  server.registerTool('remove_column', {
    title: 'Remove a column',
    description: 'Delete a column and the value every item had in it.',
    inputSchema: { list_id: listId, column: z.string().describe('Column name or id.') },
    annotations: { destructiveHint: true },
  }, ({ list_id, column: key }) => run(() => {
    edit(list_id);
    const { row, result } = service.removeColumn(list_id, key);
    return { ...brief(row), removed: result.id, columns: row.doc.columns };
  }));

  server.registerTool('add_items', {
    title: 'Add items',
    description: 'Add one or more rows. All of them are checked before any are added, so one bad value adds nothing.',
    inputSchema: {
      list_id: listId,
      items: z.array(values).min(1),
      position: z.number().int().optional().describe('Index to insert at; 0 is the top. Appends when left out.'),
    },
  }, ({ list_id, items, position }) => run(() => {
    edit(list_id);
    const { row, result } = service.addItems(list_id, items, position);
    return { ...brief(row), added: result };
  }));

  server.registerTool('update_items', {
    title: 'Edit items',
    description: 'Change values in one or more rows. Only the columns you send change.',
    inputSchema: {
      list_id: listId,
      updates: z.array(z.object({ item_id: z.string(), values })).min(1),
    },
  }, ({ list_id, updates }) => run(() => {
    edit(list_id);
    const { row, result } = service.updateItems(list_id, updates);
    return { ...brief(row), updated: result };
  }));

  server.registerTool('remove_items', {
    title: 'Remove items',
    description: 'Delete rows by item id.',
    inputSchema: { list_id: listId, item_ids: z.array(z.string()).min(1) },
    annotations: { destructiveHint: true },
  }, ({ list_id, item_ids }) => run(() => {
    edit(list_id);
    const { row, result } = service.removeItems(list_id, item_ids);
    return { ...brief(row), removed: result, remaining: row.doc.items.length };
  }));

  server.registerTool('move_item', {
    title: 'Move an item',
    description: 'Move a row to a new position in the list order. 0 is the top.',
    inputSchema: { list_id: listId, item_id: z.string(), index: z.number().int() },
  }, ({ list_id, item_id, index }) => run(() => {
    edit(list_id);
    const row = service.moveItem(list_id, item_id, index);
    return { ...brief(row), order: row.doc.items.map((i) => i.id) };
  }));

  server.registerTool('preview_link', {
    title: 'Look up a link',
    description: 'Read a shop page and return the product name, photo and price it shows, without saving anything. Works for Temu, Amazon and most shops that publish product data; some big stores block servers outright, and then this says so.',
    inputSchema: { url: z.string().describe('Any product link, including short and share links.') },
    annotations: { readOnlyHint: true, openWorldHint: true },
  }, ({ url }) => run(() => service.preview(url)));

  server.registerTool('look_up_links', {
    title: 'Fill rows from their links',
    description: 'Look up the links in some rows again (or every row) and fill their empty price, photo and name cells. Links are already looked up when they are added; use this for rows whose lookup failed or to pick up a new photo. Waits up to 25 seconds for the answers.',
    inputSchema: {
      list_id: listId,
      item_ids: z.array(z.string()).optional().describe('Rows to look up. Every row when left out.'),
    },
    annotations: { openWorldHint: true },
  }, ({ list_id, item_ids }) => run(async () => {
    edit(list_id);
    const { done } = service.lookUp(list_id, item_ids);
    await Promise.race([done, new Promise((r) => setTimeout(r, 25_000))]);
    const row = service.get(list_id);
    const wanted = item_ids ? new Set(item_ids) : undefined;
    return {
      ...brief(row),
      items: row.doc.items
        .filter((i) => !wanted || wanted.has(i.id))
        .filter((i) => i.links)
        .map((i) => ({ id: i.id, values: i.values, links: i.links })),
    };
  }));

  server.registerTool('get_style_guide', {
    title: 'How to style a list',
    description: 'The class names, data attributes and CSS variables a list page exposes, with examples. Read this before set_css.',
    annotations: { readOnlyHint: true },
  }, () => ({ content: [{ type: 'text' as const, text: STYLE_GUIDE }] }));

  server.registerTool('get_css', {
    title: 'Read a list’s CSS',
    description: 'The custom CSS a list currently has, empty if none.',
    inputSchema: { list_id: listId },
    annotations: { readOnlyHint: true },
  }, ({ list_id }) => run(() => ({ id: list_id, css: access(list_id, 'read').row.css })));

  server.registerTool('set_css', {
    title: 'Restyle a list',
    description: 'Replace a list’s custom CSS; send an empty string to go back to the default look. It loads after the built-in styles, so overriding the --sl-* variables is usually enough. Read get_style_guide first.',
    inputSchema: { list_id: listId, css: z.string() },
  }, ({ list_id, css }) => run(() => {
    edit(list_id);
    const row = service.setCss(list_id, css);
    return { ...brief(row), bytes: Buffer.byteLength(row.css) };
  }));

  return server;
}

export function createMcp({ config, service }: { config: Config; service: ListService }) {
  const failures = new RateLimiter(10, 15 * 60_000);
  const passwordFailures = new RateLimiter(10, 15 * 60_000);

  function rpcError(ctx: Context, status: number, message: string, headers: Record<string, string> = {}): void {
    json(ctx.res, status, { jsonrpc: '2.0', error: { code: -32000, message }, id: null }, headers);
  }

  return async function handleMcp(ctx: Context): Promise<boolean> {
    const match = /^mcp(?:\/([A-Za-z0-9_-]{16,256}))?\/?$/.exec(ctx.path);
    if (!match) return false;

    const wait = failures.blockedFor(ctx.ip);
    if (wait) {
      rpcError(ctx, 429, 'Too many requests with a wrong token.', { 'Retry-After': String(wait) });
      return true;
    }
    const secret = bearer(ctx.req) ?? match[1];
    const token = secret ? verifyToken(service.store, secret) : undefined;
    if (!token) {
      if (secret) failures.hit(ctx.ip);
      rpcError(ctx, 401, 'Send an MCP token as "Authorization: Bearer <token>". Tokens are made on the server with the CLI.', {
        'WWW-Authenticate': 'Bearer realm="shared-list"',
      });
      return true;
    }

    // Stateless: there is no stream to resume (GET) and no session to end (DELETE).
    if (ctx.req.method !== 'POST') {
      rpcError(ctx, 405, 'This MCP server is stateless; use POST.', { Allow: 'POST' });
      return true;
    }

    let message: unknown;
    try {
      message = JSON.parse((await readBody(ctx.req, config.limits.maxBodyBytes)).toString('utf8'));
    } catch (error) {
      if (error instanceof AppError) throw error;
      json(ctx.res, 400, { jsonrpc: '2.0', error: { code: -32700, message: 'Parse error' }, id: null });
      return true;
    }

    const server = buildServer({ service, token, origin: config.publicUrl || ctx.origin, passwordFailures });
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    ctx.res.on('close', () => {
      void transport.close();
      void server.close();
    });
    await server.connect(transport);
    await transport.handleRequest(ctx.req, ctx.res, message);
    return true;
  };
}

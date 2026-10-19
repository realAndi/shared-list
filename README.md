# Shared List

Lists you share as a link. Each one is locked with a password, works the same on
a phone and a laptop, and can carry its own CSS. An MCP server is built in, so an
AI agent can make the list, fill it in and restyle it for you.

Think of a small spreadsheet that is pleasant to look at: typed columns (text,
numbers, money, links, pictures, checkboxes, choices, dates), rows you tick off,
totals, grouping, search. It began as a furniture list for two roommates and is
built for anything you'd otherwise drop in a shared sheet.

<p>
  <img src="docs/desktop.png" alt="A furniture list on a laptop: checkboxes, item names, room tags, prices, links and notes, with done rows crossed off in red" width="68%">
  <img src="docs/phone.png" alt="The same list on a phone, each row a ruled entry" width="28%">
</p>

Live at <https://reallyitsandi.com/shared-list/>.

## What it does

- **One link, one password.** Anyone with both can open the list. The lock
  screen shows nothing about the list, not even its title. Sessions last 30 days
  per list and per device, and changing the password signs everyone out.
- **Edit together.** Tick rows, edit cells in place (click on a computer, tap
  on a phone), add rows, add and retype columns. Open tabs pick up each other's
  changes within a few seconds. A list can also be view-only.
- **Typed columns.** Money columns total up, along with "how much is left" for
  rows that aren't ticked yet. Choice columns become colored tags and can group
  the rows. Links show their site; image links show a thumbnail.
- **Per-list CSS.** Every list has a stylesheet that restyles its page for
  everyone. The default look is built on `--sl-*` variables and stable class
  names, so most themes are a few lines. See [Styling](#styling).
- **MCP.** Fifteen tools over Streamable HTTP: create, read, edit and restyle
  lists. See [For agents](#for-agents).
- **Small.** One Node process and one SQLite file. No build step on the server,
  two runtime dependencies, about 50 MB of memory.

## For agents

The server speaks [MCP](https://modelcontextprotocol.io) at `<base>/mcp`, statelessly, with
the admin token as a bearer token.

**Claude Code**

```sh
claude mcp add --transport http shared-list https://your.host/mcp \
  --header "Authorization: Bearer <admin token>"
```

**Any other client** that takes a JSON config:

```json
{
  "mcpServers": {
    "shared-list": {
      "type": "http",
      "url": "https://your.host/mcp",
      "headers": { "Authorization": "Bearer <admin token>" }
    }
  }
}
```

A client that can only be given a URL can put the token in the path instead:
`https://your.host/mcp/<admin token>`. That URL is a credential, so keep it
private, and remember that it ends up in the proxy's access log.

| Tool | What it does |
| --- | --- |
| `list_lists` | Every list: id, title, link, item count |
| `get_list` | Columns, items (with ids) and view settings |
| `create_list` | A new list with a password, from columns or a preset, optionally with items and CSS |
| `update_list` | Title, description, grouping, password, edit access |
| `delete_list` | Delete a list |
| `add_columns` / `update_column` / `remove_column` | Change the columns; retyping keeps the values that still fit |
| `add_items` / `update_items` / `remove_items` / `move_item` | Change the rows |
| `get_style_guide` | The class names and variables a list's CSS can use |
| `get_css` / `set_css` | Read or replace a list's CSS |

Agents refer to columns by name or id and send values the way people type them:
`"$1,299"` for money, `"yes"` for a checkbox, `ikea.com/p/123` for a link. A new
label in a choice column becomes a new option. A batch with one bad value adds
nothing, and the error says which column refused what.

Try asking: *"Make a shared list for our apartment furniture with item, room,
price, link and who's buying it, password couch123. Add a sofa, a bed frame and
a dining table. Then make it look warm and cozy."*

## Styling

A list's CSS loads after the built-in stylesheet and applies only to that list.
Edit it under **Settings → Style**, which previews as you type, or with the
`set_css` tool.

```css
:root {
  --sl-paper: #fff8f0;      /* page */
  --sl-rule: #f0dcc8;       /* lines between rows */
  --sl-margin: #c2410c;     /* the heavy line under the headings */
  --sl-accent: #c2410c;     /* ticks, strike-through, progress */
}

/* A whole row, by the value of one of its columns */
.sl-row[data-col-who="Split"] .sl-cell[data-primary] { font-style: italic; }
```

<img src="docs/custom-css.png" alt="The same list restyled with warm colors, a serif title and rows grouped by room" width="68%">

The full reference is [`shared/styleguide.ts`](shared/styleguide.ts). It is the
same text agents get from `get_style_guide` and people see in the Style tab.
Fonts can be imported from Google Fonts. The page's Content-Security-Policy
blocks other font hosts and every script.

## Run your own

### Docker

```sh
git clone https://github.com/realAndi/shared-list && cd shared-list
docker build -t shared-list .
docker run -d --name shared-list -p 127.0.0.1:8787:8787 -v "$PWD/data:/data" shared-list
docker exec shared-list cat /data/admin-token
```

Open <http://localhost:8787/admin>, sign in with the token, and make a list.
[`deploy/compose.example.yml`](deploy/compose.example.yml) and
[`deploy/nginx.example.conf`](deploy/nginx.example.conf) put it behind a reverse
proxy, at a whole domain or under a sub-path.

### Without Docker

Node 24 or newer runs the TypeScript directly, so there is nothing to compile on
the server.

```sh
npm ci && npm run build   # builds the web client into dist/web
npm start                 # http://localhost:8787/
```

### Configuration

All optional.

| Variable | Default | |
| --- | --- | --- |
| `LISTEN` | `8787` | A port, or a path to listen on as a Unix socket |
| `BASE_PATH` | `/` | Where the app is mounted, e.g. `/shared-list` |
| `PUBLIC_URL` | from the request | Origin for links the server hands out, e.g. `https://example.com` |
| `DATA_DIR` | `./data` | The SQLite file, backups, and generated secrets |
| `ADMIN_TOKEN` | generated | Creates and deletes lists; the MCP credential. Written to `DATA_DIR/admin-token` if unset |
| `SESSION_SECRET` | generated | Signs session cookies. Written to `DATA_DIR/session-secret` if unset |
| `TRUST_PROXY` | on for a socket | Believe `X-Real-IP` and `X-Forwarded-Proto`. Turn on behind a proxy |
| `BACKUP_KEEP` | `7` | Daily copies of the database to keep in `DATA_DIR/backups`; `0` turns them off |
| `MAX_LISTS` | `200` | |
| `MAX_ITEMS` | `1000` | Per list |
| `MAX_COLUMNS` | `30` | Per list |
| `MAX_CELL_CHARS` | `5000` | |
| `MAX_CSS_BYTES` | `65536` | Per list |
| `MAX_DB_MB` | `100` | Creating lists and adding rows stop when the database reaches this |

Images are links, never uploads, so the database stays small. A list with a
thousand rows is a few hundred KB.

## How it is put together

```
server/
  index.ts      start, listen on a port or a socket, shut down cleanly
  app.ts        request context (base path, proxy headers) and dispatch
  api.ts        the JSON API the web client uses
  mcp.ts        the MCP tools
  service.ts    each operation as one transaction
  model.ts      the list document: columns, values, items — pure functions
  store.ts      SQLite via node:sqlite
  auth.ts       scrypt passwords, signed session cookies, rate limits
  static.ts     the built client, served from memory with a strict CSP
  backup.ts     a daily VACUUM INTO
shared/         types, presets and the style guide, used by both sides
web/            the client: plain TypeScript and DOM, built by Vite
test/           node:test, including an MCP client end to end
```

A list is one row in SQLite holding a JSON document of columns and items. Every
change reads it, edits it and writes it back inside a transaction, and bumps a
version number. Clients poll with that version and get `204 No Content` until
something changes.

### Security

- Passwords are hashed with scrypt. The session cookie is HMAC-signed,
  `HttpOnly`, `SameSite=Lax`, and scoped to the app's path. It names one list
  and the password generation it was issued under.
- Ten wrong passwords for a list from one address in 15 minutes, or forty
  across all lists, and that address waits. The admin token has its own limit.
- Writes accept only `application/json` and are refused when `Origin` or
  `Sec-Fetch-Site` says they came from another site.
- Pages are built with DOM calls rather than HTML strings, so list content can't
  turn into markup. The CSP allows scripts only from the app itself.
- Custom CSS is served as its own stylesheet, behind the same session as the
  list.
- Without the admin token there is no way to create a list. That keeps the
  server's storage in the hands of whoever runs it.

## Development

```sh
npm install
npm run dev        # API on :8787 (restarts on change), client on :5173
npm run check      # typecheck, test, build
```

## License

MIT

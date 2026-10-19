import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { revokeToken } from '../server/tokens.ts';
import { Browser, start, type Running } from './helpers.ts';

let server: Running;
const clients: Client[] = [];

before(async () => {
  server = await start();
});
after(async () => {
  for (const client of clients) await client.close();
  await server.stop();
});

/** An agent connected with its own token. */
async function agent(token: string) {
  const client = new Client({ name: 'test', version: '1.0.0' });
  await client.connect(
    new StreamableHTTPClientTransport(new URL(server.base + 'mcp'), {
      requestInit: { headers: { Authorization: `Bearer ${token}` } },
    }),
  );
  clients.push(client);
  const call = async (name: string, args: Record<string, unknown> = {}) => {
    const result = (await client.callTool({ name, arguments: args })) as { isError?: boolean; content: { text: string }[] };
    const text = result.content[0].text;
    if (result.isError) return { error: text };
    try {
      return JSON.parse(text);
    } catch {
      return text;
    }
  };
  return { client, call };
}

function rpc(path: string, headers: Record<string, string> = {}) {
  return fetch(server.base + path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', ...headers },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'ping' }),
  });
}

test('the server describes itself and its tools', async () => {
  const { client } = await agent(server.token('Describe'));
  assert.match(client.getInstructions() ?? '', /open_list/);
  const { tools } = await client.listTools();
  assert.deepEqual(
    tools.map((t) => t.name).sort(),
    [
      'add_columns', 'add_items', 'create_list', 'delete_list', 'get_css', 'get_list', 'get_style_guide',
      'list_lists', 'move_item', 'open_list', 'remove_column', 'remove_items', 'set_css', 'update_column',
      'update_items', 'update_list',
    ],
  );
});

test('an agent can build a list end to end', async () => {
  const { call } = await agent(server.token('Andi'));
  const created = await call('create_list', {
    title: 'Apartment furniture',
    password: 'couch123',
    id: 'furniture',
    columns: [
      { name: 'Got it', type: 'checkbox' },
      { name: 'Item' },
      { name: 'Room', type: 'select', options: ['Living room', 'Bedroom'] },
      { name: 'Price', type: 'currency' },
    ],
    items: [{ Item: 'Sofa', Room: 'Living room', Price: 899 }],
    group_by: 'Room',
  });
  assert.equal(created.id, 'furniture');
  assert.match(created.url, /\/shared-list\/furniture$/);

  const added = await call('add_items', {
    list_id: 'furniture',
    items: [{ Item: 'Bed frame', Room: 'Bedroom', Price: '$349' }, { Item: 'Desk', Room: 'Office', Price: 220 }],
  });
  assert.equal(added.added.length, 2);

  const list = await call('get_list', { list_id: 'furniture' });
  assert.equal(list.role, 'owner');
  assert.equal(list.items.length, 3);
  assert.equal(list.view.group_by, 'room');
  assert.deepEqual(list.columns[2].options.map((o: { value: string }) => o.value), ['Living room', 'Bedroom', 'Office']);

  const updated = await call('update_items', { list_id: 'furniture', updates: [{ item_id: list.items[0].id, values: { 'Got it': true } }] });
  assert.equal(updated.updated[0].values['got-it'], true);

  assert.ok((await call('set_css', { list_id: 'furniture', css: ':root { --sl-accent: #2b6; }' })).bytes > 0);
  assert.equal((await call('get_css', { list_id: 'furniture' })).css, ':root { --sl-accent: #2b6; }');

  // And the person it was made for can open it with the password the agent set.
  const person = new Browser(server.base);
  const opened = await person.request('POST', 'api/lists/furniture/unlock', { password: 'couch123' });
  assert.equal(opened.status, 200);
  assert.equal(opened.data.list.items.length, 3);
});

test('a token sees only its own lists until it opens another with the password', async () => {
  const andi = await agent(server.token('Andi 2'));
  const roommate = await agent(server.token('Roommate'));
  await andi.call('create_list', { title: 'Andi only', password: 'andi-pass', id: 'andi-only' });

  assert.ok(!(await roommate.call('list_lists')).lists.some((l: { id: string }) => l.id === 'andi-only'));
  assert.match((await roommate.call('get_list', { list_id: 'andi-only' })).error, /has not opened "andi-only".*open_list/);
  assert.match((await roommate.call('add_items', { list_id: 'andi-only', items: [{ Name: 'x' }] })).error, /has not opened/);

  assert.match((await roommate.call('open_list', { list_id: 'andi-only', password: 'nope' })).error, /does not open/);
  const opened = await roommate.call('open_list', { list_id: 'andi-only', password: 'andi-pass' });
  assert.equal(opened.role, 'editor');
  assert.ok((await roommate.call('list_lists')).lists.some((l: { id: string }) => l.id === 'andi-only'));
  assert.equal((await roommate.call('add_items', { list_id: 'andi-only', items: [{ Name: 'from the roommate' }] })).added.length, 1);

  // Editors cannot make it view-only; only the token that made it can.
  assert.match((await roommate.call('update_list', { list_id: 'andi-only', editable: false })).error, /Only the token that created/);

  // A new password from the owner closes the roommate's way in.
  await andi.call('update_list', { list_id: 'andi-only', password: 'new-andi-pass' });
  assert.match((await roommate.call('get_list', { list_id: 'andi-only' })).error, /has not opened/);
});

test('a view-only list stays view-only for tokens that open it', async () => {
  const owner = await agent(server.token('Owner'));
  const guest = await agent(server.token('Guest'));
  await owner.call('create_list', { title: 'Read me', password: 'read-pass', id: 'read-me', editable: false });
  assert.equal((await guest.call('open_list', { list_id: 'read-me', password: 'read-pass' })).role, 'viewer');
  assert.equal((await guest.call('get_list', { list_id: 'read-me' })).title, 'Read me');
  assert.match((await guest.call('add_items', { list_id: 'read-me', items: [{ Name: 'x' }] })).error, /view-only/);
  assert.equal((await owner.call('add_items', { list_id: 'read-me', items: [{ Name: 'mine' }] })).added.length, 1);

  // And for people in a browser.
  const tab = new Browser(server.base);
  assert.equal((await tab.request('POST', 'api/lists/read-me/unlock', { password: 'read-pass' })).data.list.role, 'viewer');
  assert.equal((await tab.request('POST', 'api/lists/read-me/items', { values: { Name: 'x' } })).status, 403);
});

test('tokens can open lists made on the web', async () => {
  const tab = new Browser(server.base);
  const made = await tab.request('POST', 'api/lists', { title: 'Made on the web', password: 'web-pass' });
  const { call } = await agent(server.token('Helper'));
  assert.equal((await call('open_list', { list_id: made.data.list.id, password: 'web-pass' })).role, 'editor');
  assert.equal((await call('update_list', { list_id: made.data.list.id, title: 'Renamed by an agent' })).title, 'Renamed by an agent');
});

test('mistakes come back as tool errors the agent can read', async () => {
  const { call } = await agent(server.token('Errors'));
  assert.match((await call('get_list', { list_id: 'nope' })).error, /No list with id "nope"/);
  await call('create_list', { title: 'Errors', password: 'abcd', id: 'errors' });
  assert.match((await call('add_items', { list_id: 'errors', items: [{ Colour: 'red' }] })).error, /No column "Colour". Columns: "Name"/);
  assert.match(await call('get_style_guide'), /--sl-/);
});

test('MCP needs a token made on the server, and a revoked one stops working', async () => {
  const none = await rpc('mcp');
  assert.equal(none.status, 401);
  assert.match(none.headers.get('www-authenticate') ?? '', /Bearer/);
  assert.equal((await rpc('mcp', { Authorization: 'Bearer sl_made-up-token-000000000000' })).status, 401);

  const token = server.token('Short-lived');
  assert.equal((await rpc(`mcp/${token}`)).status, 200, 'the token also works as the last path segment');
  assert.equal((await rpc('mcp', { Authorization: `Bearer ${token}` })).status, 200);
  revokeToken(server.app.store, 'Short-lived');
  assert.equal((await rpc('mcp', { Authorization: `Bearer ${token}` })).status, 401);
});

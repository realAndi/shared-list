import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { ADMIN, Browser, start, type Running } from './helpers.ts';

let server: Running;
let client: Client;

before(async () => {
  server = await start();
  client = new Client({ name: 'test', version: '1.0.0' });
  await client.connect(
    new StreamableHTTPClientTransport(new URL(server.base + 'mcp'), {
      requestInit: { headers: { Authorization: `Bearer ${ADMIN}` } },
    }),
  );
});
after(async () => {
  await client.close();
  await server.stop();
});

async function call(name: string, args: Record<string, unknown> = {}) {
  const result = (await client.callTool({ name, arguments: args })) as { isError?: boolean; content: { text: string }[] };
  const text = result.content[0].text;
  if (result.isError) return { error: text };
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

test('the server describes itself and its tools', async () => {
  assert.match(client.getInstructions() ?? '', /password-protected lists/);
  const { tools } = await client.listTools();
  assert.deepEqual(
    tools.map((t) => t.name).sort(),
    [
      'add_columns', 'add_items', 'create_list', 'delete_list', 'get_css', 'get_list', 'get_style_guide',
      'list_lists', 'move_item', 'remove_column', 'remove_items', 'set_css', 'update_column', 'update_items', 'update_list',
    ],
  );
});

test('an agent can build a list end to end', async () => {
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
    items: [
      { Item: 'Bed frame', Room: 'Bedroom', Price: '$349' },
      { Item: 'Desk', Room: 'Office', Price: 220 },
    ],
  });
  assert.equal(added.added.length, 2);

  const list = await call('get_list', { list_id: 'furniture' });
  assert.equal(list.items.length, 3);
  assert.equal(list.view.group_by, 'room');
  assert.deepEqual(list.columns[2].options.map((o: { value: string }) => o.value), ['Living room', 'Bedroom', 'Office']);

  const sofa = list.items[0];
  const updated = await call('update_items', { list_id: 'furniture', updates: [{ item_id: sofa.id, values: { 'Got it': true } }] });
  assert.equal(updated.updated[0].values['got-it'], true);

  const styled = await call('set_css', { list_id: 'furniture', css: ':root { --sl-accent: #2b6; }' });
  assert.ok(styled.bytes > 0);
  assert.equal((await call('get_css', { list_id: 'furniture' })).css, ':root { --sl-accent: #2b6; }');

  // And the person it was made for can open it with the password the agent set.
  const person = new Browser(server.base);
  const opened = await person.request('POST', 'api/lists/furniture/unlock', { password: 'couch123' });
  assert.equal(opened.status, 200);
  assert.equal(opened.data.list.items.length, 3);
});

test('mistakes come back as tool errors the agent can read', async () => {
  const missing = await call('get_list', { list_id: 'nope' });
  assert.match(missing.error, /No list with id "nope"/);
  await call('create_list', { title: 'Errors', password: 'abcd', id: 'errors' });
  const bad = await call('add_items', { list_id: 'errors', items: [{ Colour: 'red' }] });
  assert.match(bad.error, /No column "Colour". Columns: "Name"/);
});

test('the style guide is there', async () => {
  const guide = await call('get_style_guide');
  assert.match(guide, /--sl-/);
});

test('MCP refuses requests without the admin token', async () => {
  const res = await fetch(server.base + 'mcp', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
  });
  assert.equal(res.status, 401);
  assert.match(res.headers.get('www-authenticate') ?? '', /Bearer/);

  const viaPath = await fetch(server.base + `mcp/${ADMIN}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'ping' }),
  });
  assert.equal(viaPath.status, 200);
});

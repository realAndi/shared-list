import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { ADMIN, Browser, start, type Running } from './helpers.ts';

let server: Running;
const admin = { Authorization: `Bearer ${ADMIN}` };

before(async () => {
  server = await start();
});
after(() => server.stop());

async function createList(body: Record<string, unknown>) {
  const res = await new Browser(server.base).request('POST', 'api/lists', body, admin);
  assert.equal(res.status, 200, JSON.stringify(res.data));
  return res.data.list;
}

test('creating a list needs the admin token', async () => {
  const anon = new Browser(server.base);
  const res = await anon.request('POST', 'api/lists', { title: 'x', password: 'abcd' });
  assert.equal(res.status, 401);
  const wrong = await anon.request('POST', 'api/lists', { title: 'x', password: 'abcd' }, { Authorization: 'Bearer nope' });
  assert.equal(wrong.status, 401);
  assert.match(wrong.data.error.message, /admin token/);
});

test('a list opens with its password and only its password', async () => {
  const list = await createList({ title: 'Apartment', password: 'couch123', id: 'apartment', preset: 'shopping' });
  assert.equal(list.url, `${server.base.replace(/\/$/, '')}/apartment`);
  assert.deepEqual(list.columns.map((c: { id: string }) => c.id), ['got-it', 'item', 'price', 'link', 'photo', 'notes']);

  const roommate = new Browser(server.base);
  assert.equal((await roommate.request('GET', 'api/lists/apartment')).status, 401);
  assert.equal((await roommate.request('POST', 'api/lists/apartment/unlock', { password: 'wrong' })).status, 401);

  const opened = await roommate.request('POST', 'api/lists/apartment/unlock', { password: 'couch123' });
  assert.equal(opened.status, 200);
  assert.equal(opened.data.list.role, 'editor');
  const cookie = opened.headers.getSetCookie()[0];
  assert.match(cookie, /^sl_apartment=.+; Path=\/shared-list\/; Max-Age=\d+; HttpOnly; SameSite=Lax$/);

  const read = await roommate.request('GET', 'api/lists/apartment');
  assert.equal(read.status, 200);
  assert.equal(read.data.list.title, 'Apartment');

  // The cookie for one list opens nothing else.
  await createList({ title: 'Other', password: 'other-pass', id: 'other' });
  assert.equal((await roommate.request('GET', 'api/lists/other')).status, 401);
});

test('editors add, edit and remove items; polling sees the change', async () => {
  await createList({ title: 'Edit me', password: 'pass1234', id: 'edit-me', preset: 'shopping' });
  const tab = new Browser(server.base);
  const opened = await tab.request('POST', 'api/lists/edit-me/unlock', { password: 'pass1234' });
  const version = opened.data.list.version;

  assert.equal((await tab.request('GET', `api/lists/edit-me?since=${version}`)).status, 204);

  const added = await tab.request('POST', 'api/lists/edit-me/items', { values: { Item: 'Sofa', Price: '899' } });
  assert.equal(added.status, 200, JSON.stringify(added.data));
  const [item] = added.data.items;
  assert.deepEqual(item.values, { item: 'Sofa', price: 899 });

  const polled = await tab.request('GET', `api/lists/edit-me?since=${version}`);
  assert.equal(polled.status, 200);
  assert.equal(polled.data.list.items.length, 1);

  const edited = await tab.request('PATCH', `api/lists/edit-me/items/${item.id}`, { values: { 'Got it': true } });
  assert.equal(edited.data.list.items[0].values['got-it'], true);

  const bad = await tab.request('PATCH', `api/lists/edit-me/items/${item.id}`, { values: { Price: 'lots' } });
  assert.equal(bad.status, 400);

  const removed = await tab.request('DELETE', `api/lists/edit-me/items/${item.id}`);
  assert.equal(removed.data.list.items.length, 0);
});

test('editors manage columns and CSS, but not the password', async () => {
  await createList({ title: 'Cols', password: 'pass1234', id: 'cols' });
  const tab = new Browser(server.base);
  await tab.request('POST', 'api/lists/cols/unlock', { password: 'pass1234' });

  const added = await tab.request('POST', 'api/lists/cols/columns', { name: 'Room', type: 'select', options: ['Kitchen'] });
  assert.equal(added.status, 200);
  const renamed = await tab.request('PATCH', 'api/lists/cols/columns/room', { name: 'Where' });
  assert.equal(renamed.data.list.columns.at(-1).name, 'Where');
  assert.equal(renamed.data.list.columns.at(-1).id, 'room');

  const grouped = await tab.request('PATCH', 'api/lists/cols', { group_by: 'Where', title: 'Columns' });
  assert.equal(grouped.data.list.view.group_by, 'room');

  const css = await tab.request('PUT', 'api/lists/cols/css', { css: ':root { --sl-accent: hotpink; }' });
  assert.ok(css.data.list.css_rev);
  const sheet = await tab.request('GET', 'api/lists/cols/style.css');
  assert.equal(sheet.headers.get('content-type'), 'text/css; charset=utf-8');
  assert.equal(sheet.data, ':root { --sl-accent: hotpink; }');

  const rekey = await tab.request('PATCH', 'api/lists/cols', { password: 'mine-now' });
  assert.equal(rekey.status, 403);
  assert.equal((await tab.request('DELETE', 'api/lists/cols')).status, 401);
});

test('view-only lists refuse writes from password holders', async () => {
  await createList({ title: 'Read only', password: 'pass1234', id: 'read-only', editable: false });
  const tab = new Browser(server.base);
  const opened = await tab.request('POST', 'api/lists/read-only/unlock', { password: 'pass1234' });
  assert.equal(opened.data.list.role, 'viewer');
  const write = await tab.request('POST', 'api/lists/read-only/items', { values: { Name: 'x' } });
  assert.equal(write.status, 403);
});

test('a new password signs existing sessions out', async () => {
  await createList({ title: 'Rekey', password: 'first-pass', id: 'rekey' });
  const tab = new Browser(server.base);
  await tab.request('POST', 'api/lists/rekey/unlock', { password: 'first-pass' });
  assert.equal((await tab.request('GET', 'api/lists/rekey')).status, 200);

  const changed = await new Browser(server.base).request('PATCH', 'api/lists/rekey', { password: 'second-pass' }, admin);
  assert.equal(changed.status, 200);
  assert.equal((await tab.request('GET', 'api/lists/rekey')).status, 401);
  assert.equal((await tab.request('POST', 'api/lists/rekey/unlock', { password: 'second-pass' })).status, 200);
});

test('cross-site writes are refused', async () => {
  await createList({ title: 'CSRF', password: 'pass1234', id: 'csrf' });
  const tab = new Browser(server.base);
  await tab.request('POST', 'api/lists/csrf/unlock', { password: 'pass1234' });
  const res = await tab.request('POST', 'api/lists/csrf/items', { values: { Name: 'x' } }, { Origin: 'https://evil.example' });
  assert.equal(res.status, 403);
  const site = await tab.request('POST', 'api/lists/csrf/items', { values: { Name: 'x' } }, { 'Sec-Fetch-Site': 'cross-site' });
  assert.equal(site.status, 403);
  const form = await tab.request('POST', 'api/lists/csrf/lock', undefined, { 'Content-Type': 'application/x-www-form-urlencoded' });
  assert.equal(form.status, 200, 'lock takes no body, and only clears the cookie');
});

test('wrong passwords are rate limited per list', async () => {
  await createList({ title: 'Limited', password: 'right-pass', id: 'limited' });
  const tab = new Browser(server.base);
  for (let i = 0; i < 10; i++) {
    assert.equal((await tab.request('POST', 'api/lists/limited/unlock', { password: `guess-${i}` })).status, 401);
  }
  const blocked = await tab.request('POST', 'api/lists/limited/unlock', { password: 'right-pass' });
  assert.equal(blocked.status, 429);
  assert.ok(Number(blocked.headers.get('retry-after')) > 0);
});

test('admin sees every list and can delete one', async () => {
  await createList({ title: 'Doomed', password: 'pass1234', id: 'doomed' });
  const tab = new Browser(server.base);
  const all = await tab.request('GET', 'api/admin', undefined, admin);
  assert.ok(all.data.lists.some((l: { id: string }) => l.id === 'doomed'));
  assert.equal((await tab.request('DELETE', 'api/lists/doomed', undefined, admin)).status, 200);
  assert.equal((await tab.request('GET', 'api/lists/doomed', undefined, admin)).status, 404);
});

test('the base path is enforced and redirected', async () => {
  const root = server.base.replace(/shared-list\/$/, '');
  const outside = await fetch(root + 'elsewhere', { redirect: 'manual' });
  assert.equal(outside.status, 404);
  const bare = await fetch(root + 'shared-list', { redirect: 'manual' });
  assert.equal(bare.status, 301);
  assert.equal(bare.headers.get('location'), '/shared-list/');
  assert.equal((await fetch(server.base + 'healthz')).status, 200);
});

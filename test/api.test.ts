import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { Browser, start, type Running } from './helpers.ts';

let server: Running;

before(async () => {
  // These tests make plenty of lists from one address; the limit has its own test.
  server = await start({ MAX_CREATES_PER_HOUR: '1000' });
});
after(() => server.stop());

/** Make a list from a browser, which leaves that browser signed in to it. */
async function create(body: Record<string, unknown>, tab = new Browser(server.base)) {
  const res = await tab.request('POST', 'api/lists', body);
  assert.equal(res.status, 200, JSON.stringify(res.data));
  return { tab, list: res.data.list };
}

test('anyone can create a list, and its creator is signed in to it', async () => {
  const { tab, list } = await create({ title: 'Apartment', password: 'couch123', preset: 'shopping' });
  assert.match(list.id, /^[a-z0-9]{10}$/);
  assert.equal(list.url, `${server.base}${list.id}`);
  assert.equal(list.role, 'editor');
  assert.deepEqual(list.columns.map((c: { id: string }) => c.id), ['got-it', 'item', 'price', 'link', 'photo', 'notes']);
  assert.equal((await tab.request('GET', `api/lists/${list.id}`)).status, 200);
});

test('the web cannot pick an id, make a list view-only, or skip the password', async () => {
  const { list } = await create({ title: 'Mine', password: 'pass1234', id: 'taken-name', editable: false });
  assert.notEqual(list.id, 'taken-name');
  assert.equal(list.editable, true);
  const res = await new Browser(server.base).request('POST', 'api/lists', { title: 'No password' });
  assert.equal(res.status, 400);
});

test('a list opens with its password and only its password', async () => {
  const { list } = await create({ title: 'Locked', password: 'couch123' });
  const roommate = new Browser(server.base);
  assert.equal((await roommate.request('GET', `api/lists/${list.id}`)).status, 401);
  assert.equal((await roommate.request('POST', `api/lists/${list.id}/unlock`, { password: 'wrong' })).status, 401);

  const opened = await roommate.request('POST', `api/lists/${list.id}/unlock`, { password: 'couch123' });
  assert.equal(opened.status, 200);
  assert.equal(opened.data.list.role, 'editor');
  const cookie = opened.headers.getSetCookie()[0];
  assert.match(cookie, new RegExp(`^sl_${list.id}=.+; Path=/shared-list/; Max-Age=\\d+; HttpOnly; SameSite=Lax$`));

  // The cookie for one list opens nothing else.
  const other = await create({ title: 'Other', password: 'other-pass' });
  assert.equal((await roommate.request('GET', `api/lists/${other.list.id}`)).status, 401);
});

test('editors add, edit and remove items; polling sees the change', async () => {
  const { tab, list } = await create({ title: 'Edit me', password: 'pass1234', preset: 'shopping' });
  const id = list.id;
  assert.equal((await tab.request('GET', `api/lists/${id}?since=${list.version}`)).status, 204);

  const added = await tab.request('POST', `api/lists/${id}/items`, { values: { Item: 'Sofa', Price: '899' } });
  assert.equal(added.status, 200, JSON.stringify(added.data));
  const [item] = added.data.items;
  assert.deepEqual(item.values, { item: 'Sofa', price: 899 });

  const polled = await tab.request('GET', `api/lists/${id}?since=${list.version}`);
  assert.equal(polled.status, 200);
  assert.equal(polled.data.list.items.length, 1);

  const edited = await tab.request('PATCH', `api/lists/${id}/items/${item.id}`, { values: { 'Got it': true } });
  assert.equal(edited.data.list.items[0].values['got-it'], true);
  assert.equal((await tab.request('PATCH', `api/lists/${id}/items/${item.id}`, { values: { Price: 'lots' } })).status, 400);
  assert.equal((await tab.request('DELETE', `api/lists/${id}/items/${item.id}`)).data.list.items.length, 0);
});

test('editors manage columns and CSS', async () => {
  const { tab, list } = await create({ title: 'Cols', password: 'pass1234' });
  const id = list.id;
  assert.equal((await tab.request('POST', `api/lists/${id}/columns`, { name: 'Room', type: 'select', options: ['Kitchen'] })).status, 200);
  const renamed = await tab.request('PATCH', `api/lists/${id}/columns/room`, { name: 'Where' });
  assert.equal(renamed.data.list.columns.at(-1).name, 'Where');
  assert.equal(renamed.data.list.columns.at(-1).id, 'room');

  const grouped = await tab.request('PATCH', `api/lists/${id}`, { group_by: 'Where', title: 'Columns' });
  assert.equal(grouped.data.list.view.group_by, 'room');

  const css = await tab.request('PUT', `api/lists/${id}/css`, { css: ':root { --sl-accent: hotpink; }' });
  assert.ok(css.data.list.css_rev);
  const sheet = await tab.request('GET', `api/lists/${id}/style.css`);
  assert.equal(sheet.headers.get('content-type'), 'text/css; charset=utf-8');
  assert.equal(sheet.data, ':root { --sl-accent: hotpink; }');

  assert.equal((await tab.request('PATCH', `api/lists/${id}`, { editable: false })).status, 403);
});

test('a new password keeps its changer in and signs everyone else out', async () => {
  const { tab, list } = await create({ title: 'Rekey', password: 'first-pass' });
  const roommate = new Browser(server.base);
  await roommate.request('POST', `api/lists/${list.id}/unlock`, { password: 'first-pass' });

  assert.equal((await tab.request('PATCH', `api/lists/${list.id}`, { password: 'second-pass' })).status, 200);
  assert.equal((await tab.request('GET', `api/lists/${list.id}`)).status, 200);
  assert.equal((await roommate.request('GET', `api/lists/${list.id}`)).status, 401);
  assert.equal((await roommate.request('POST', `api/lists/${list.id}/unlock`, { password: 'second-pass' })).status, 200);
});

test('anyone with the password can delete a list', async () => {
  const { list } = await create({ title: 'Doomed', password: 'pass1234' });
  const roommate = new Browser(server.base);
  await roommate.request('POST', `api/lists/${list.id}/unlock`, { password: 'pass1234' });
  assert.equal((await new Browser(server.base).request('DELETE', `api/lists/${list.id}`)).status, 401);
  assert.equal((await roommate.request('DELETE', `api/lists/${list.id}`)).status, 200);
  assert.equal((await roommate.request('POST', `api/lists/${list.id}/unlock`, { password: 'pass1234' })).status, 404);
});

test('cross-site writes are refused', async () => {
  const { tab, list } = await create({ title: 'CSRF', password: 'pass1234' });
  const write = (headers: Record<string, string>) => tab.request('POST', `api/lists/${list.id}/items`, { values: { Name: 'x' } }, headers);
  assert.equal((await write({ Origin: 'https://evil.example' })).status, 403);
  assert.equal((await write({ 'Sec-Fetch-Site': 'cross-site' })).status, 403);
  const cross = await new Browser(server.base).request('POST', 'api/lists', { title: 'x', password: 'abcd' }, { Origin: 'https://evil.example' });
  assert.equal(cross.status, 403);
});

test('wrong passwords are rate limited per list', async () => {
  const { list } = await create({ title: 'Limited', password: 'right-pass' });
  const tab = new Browser(server.base);
  for (let i = 0; i < 10; i++) {
    assert.equal((await tab.request('POST', `api/lists/${list.id}/unlock`, { password: `guess-${i}` })).status, 401);
  }
  const blocked = await tab.request('POST', `api/lists/${list.id}/unlock`, { password: 'right-pass' });
  assert.equal(blocked.status, 429);
  assert.ok(Number(blocked.headers.get('retry-after')) > 0);
});

test('creating lists is rate limited per address', async () => {
  const fresh = await start();
  try {
    const tab = new Browser(fresh.base);
    for (let i = 0; i < 10; i++) {
      assert.equal((await tab.request('POST', 'api/lists', { title: `List ${i}`, password: 'pass1234' })).status, 200);
    }
    const blocked = await tab.request('POST', 'api/lists', { title: 'One more', password: 'pass1234' });
    assert.equal(blocked.status, 429);
    assert.match(blocked.data.error.message, /a lot of new lists/);
  } finally {
    await fresh.stop();
  }
});

test('there is no admin surface', async () => {
  const tab = new Browser(server.base);
  assert.equal((await tab.request('GET', 'api/admin')).status, 404);
  // "admin" is just a list id now, and a missing one at that.
  assert.equal((await tab.request('GET', 'api/lists/admin')).status, 404);
});

test('the base path is enforced and redirected', async () => {
  const root = server.base.replace(/shared-list\/$/, '');
  assert.equal((await fetch(root + 'elsewhere', { redirect: 'manual' })).status, 404);
  const bare = await fetch(root + 'shared-list', { redirect: 'manual' });
  assert.equal(bare.status, 301);
  assert.equal(bare.headers.get('location'), '/shared-list/');
  assert.equal((await fetch(server.base + 'healthz')).status, 200);
});

test('pictures upload into a list and show only behind its password', async () => {
  const { tab, list } = await create({ title: 'Photos', password: 'pass1234', preset: 'shopping' });
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');
  const uploaded = await tab.request('POST', `api/lists/${list.id}/images`, { data: `data:image/png;base64,${png.toString('base64')}` });
  assert.equal(uploaded.status, 200, JSON.stringify(uploaded.data));
  const path: string = uploaded.data.path;
  assert.match(path, new RegExp(`^api/lists/${list.id}/images/[0-9a-f]{16}\\.png$`));

  const added = await tab.request('POST', `api/lists/${list.id}/items`, { values: { Item: 'Lamp', Photo: path } });
  assert.equal(added.data.list.items[0].values.photo, path);
  assert.equal(added.data.list.items[0].links, undefined, 'an upload is never looked up');

  const shown = await tab.request('GET', path);
  assert.equal(shown.status, 200);
  assert.equal(shown.headers.get('content-type'), 'image/png');
  assert.equal(shown.headers.get('content-length'), String(png.length));
  assert.equal((await new Browser(server.base).request('GET', path)).status, 401);

  const notPicture = await tab.request('POST', `api/lists/${list.id}/images`, { data: Buffer.from('<svg onload=alert(1)>').toString('base64') });
  assert.equal(notPicture.status, 400);

  // Unused pictures go after a day; used ones stay.
  const unused = (await tab.request('POST', `api/lists/${list.id}/images`, { data: png.toString('base64') })).data.path as string;
  assert.equal(server.app.store.pruneImages(new Date(Date.now() + 1000).toISOString()), 1);
  assert.equal((await tab.request('GET', unused)).status, 404);
  assert.equal((await tab.request('GET', path)).status, 200);
});

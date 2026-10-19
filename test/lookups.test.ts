import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { extract, parsePrice } from '../server/extract.ts';
import { FetchError, getPage, isPrivateAddress } from '../server/fetcher.ts';
import type { Preview } from '../server/extract.ts';
import { Browser, start, type Running } from './helpers.ts';

// --- reading pages -------------------------------------------------------------

test('Temu: product meta tags', () => {
  const html = `<html><head>
    <meta property="og:title" content="109 cloud couches living room 56&quot; sleeper - Temu"/>
    <meta property="og:site_name" content="temu"/>
    <meta property="og:image" content="https://img.kwcdn.com/product/fancy/651edf03.jpg"/>
    <meta property="product:price:amount" content="183.53"/>
    <meta property="product:price:currency" content="USD"/>
  </head></html>`;
  assert.deepEqual(extract(html, 'https://www.temu.com/goods.html?goods_id=1'), {
    url: 'https://www.temu.com/goods.html?goods_id=1',
    site: 'temu.com',
    title: '109 cloud couches living room 56" sleeper',
    image: 'https://img.kwcdn.com/product/fancy/651edf03.jpg',
    price: 183.53,
    currency: 'USD',
  });
});

test('Shopify-style JSON-LD, with the price on a variant', () => {
  const html = `<title>Men's Tree Runner | Allbirds</title>
    <script type="application/ld+json">{"@context":"https://schema.org","@type":"ProductGroup","name":"Men's Tree Runner",
      "image":["https://cdn.example/shoe.jpg"],"hasVariant":[{"@type":"Product","offers":{"@type":"Offer","price":"100.00","priceCurrency":"USD"}}]}</script>`;
  const preview = extract(html, 'https://www.allbirds.com/products/mens-tree-runners');
  assert.equal(preview.title, "Men's Tree Runner");
  assert.equal(preview.price, 100);
  assert.equal(preview.currency, 'USD');
  assert.equal(preview.image, 'https://cdn.example/shoe.jpg');
});

test('Amazon: its own price and photo, not the generic share icon', () => {
  const html = `<title>Amazon.com: Echo Dot (5th Gen) : Amazon Devices &amp; Accessories</title>
    <meta property="og:image" content="https://m.media-amazon.com/images/G/01/share-icons/previewdoh/amazon.png"/>
    <span id="productTitle" class="a-size-large">   Echo Dot (5th Gen, 2022 release)   </span>
    <script>var data = {"priceAmount":79.99,"currencySymbol":"$"};</script>
    <script>{"colorImages":{"initial":[{"hiRes":"https://m.media-amazon.com/images/I/61J2sQtBYDL._AC_SL1500_.jpg"}]}}</script>`;
  const preview = extract(html, 'https://www.amazon.com/dp/B09B8V1LZ3');
  assert.equal(preview.title, 'Echo Dot (5th Gen, 2022 release)');
  assert.equal(preview.price, 79.99);
  assert.equal(preview.currency, 'USD');
  assert.equal(preview.image, 'https://m.media-amazon.com/images/I/61J2sQtBYDL._AC_SL1500_.jpg');
});

test('relative images resolve against the page, and odd prices are not guessed', () => {
  const html = `<meta property="og:image" content="/img/lamp.jpg"><meta itemprop="price" content="1.299,00"><title>Lamp</title>`;
  const preview = extract(html, 'https://shop.example/p/lamp');
  assert.equal(preview.image, 'https://shop.example/img/lamp.jpg');
  assert.equal(preview.price, undefined);
  assert.equal(parsePrice('$1,299.50'), 1299.5);
  assert.equal(parsePrice('USD 85'), 85);
  assert.equal(parsePrice('free'), undefined);
});

// --- refusing private addresses ------------------------------------------------

test('private and internal addresses are never fetched', async () => {
  for (const address of ['127.0.0.1', '10.1.2.3', '172.18.0.1', '192.168.1.1', '169.254.169.254', '100.64.0.1', '0.0.0.0', '::1', '::ffff:127.0.0.1', 'fd00::1', 'fe80::1']) {
    assert.equal(isPrivateAddress(address), true, address);
  }
  for (const address of ['8.8.8.8', '142.93.66.124', '2606:4700:4700::1111']) {
    assert.equal(isPrivateAddress(address), false, address);
  }
  const refused = async (url: string, pattern: RegExp) =>
    assert.rejects(getPage(url, { userAgent: 'test' }), (e: Error) => e instanceof FetchError && pattern.test(e.message));
  await refused('http://127.0.0.1/', /private/);
  await refused('http://[::1]/', /private/);
  await refused('http://169.254.169.254/latest/meta-data/', /private/);
  await refused('http://localhost/', /private/);
  await refused('http://example.com:5432/', /standard web ports/);
  await refused('file:///etc/passwd', /http and https/);
  await refused('http://user:pass@example.com/', /username/);
});

// --- filling rows ---------------------------------------------------------------

let server: Running;
const pages: Record<string, Preview | Error> = {};
const fetched: string[] = [];

before(async () => {
  server = await start({}, async (url) => {
    fetched.push(url);
    await new Promise((r) => setTimeout(r, 30));
    const page = pages[url];
    if (!page) throw new FetchError('There is no site there.');
    if (page instanceof Error) throw page;
    return page;
  });
});
after(() => server.stop());

const couch: Preview = {
  url: 'https://www.temu.com/couch',
  site: 'temu.com',
  title: 'Cloud couch',
  image: 'https://img.example/couch.jpg',
  price: 183.53,
  currency: 'USD',
};

async function shoppingList() {
  const tab = new Browser(server.base);
  const res = await tab.request('POST', 'api/lists', { title: 'Furniture', password: 'pass1234', preset: 'shopping' });
  return { tab, id: res.data.list.id as string };
}

async function settled(tab: Browser, id: string) {
  for (let i = 0; i < 100; i++) {
    const { data } = await tab.request('GET', `api/lists/${id}`);
    const pending = data.list.items.some((item: { links?: Record<string, { status: string }> }) =>
      Object.values(item.links ?? {}).some((l) => l.status === 'pending'),
    );
    if (!pending) return data.list;
    await new Promise((r) => setTimeout(r, 20));
  }
  throw new Error('lookups never finished');
}

test('a pasted link fills the empty price, photo and name', async () => {
  pages['https://share.temu.com/abc'] = couch;
  const { tab, id } = await shoppingList();
  const added = await tab.request('POST', `api/lists/${id}/items`, { values: { Link: 'https://share.temu.com/abc' } });
  assert.equal(added.data.list.items[0].links.link.status, 'pending');

  const list = await settled(tab, id);
  const item = list.items[0];
  assert.deepEqual(item.values, {
    link: 'https://share.temu.com/abc',
    item: 'Cloud couch',
    price: 183.53,
    photo: 'https://img.example/couch.jpg',
  });
  assert.equal(item.links.link.status, 'done');
  assert.equal(item.links.link.site, 'temu.com');
});

test('what someone typed is never overwritten, and a price in another currency is left alone', async () => {
  pages['https://shop.example/sofa'] = { ...couch, url: 'https://shop.example/sofa', price: 900, currency: 'EUR' };
  const { tab, id } = await shoppingList();
  await tab.request('POST', `api/lists/${id}/items`, { values: { Item: 'Our sofa', Link: 'https://shop.example/sofa' } });
  const item = (await settled(tab, id)).items[0];
  assert.equal(item.values.item, 'Our sofa');
  assert.equal(item.values.price, undefined, 'EUR does not go in a USD column');
  assert.equal(item.links.link.price, 900, 'but what the page said is kept');
  assert.equal(item.values.photo, 'https://img.example/couch.jpg');
});

test('a link changed while it was being looked up keeps the newer link\'s answer', async () => {
  pages['https://shop.example/first'] = { ...couch, title: 'First' };
  pages['https://shop.example/second'] = { ...couch, title: 'Second' };
  const { tab, id } = await shoppingList();
  const added = await tab.request('POST', `api/lists/${id}/items`, { values: { Link: 'https://shop.example/first' } });
  const itemId = added.data.items[0].id;
  await tab.request('PATCH', `api/lists/${id}/items/${itemId}`, { values: { Link: 'https://shop.example/second' } });
  const item = (await settled(tab, id)).items[0];
  assert.equal(item.values.item, 'Second');
});

test('failures are kept with a reason, and can be retried', async () => {
  pages['https://blocked.example/p'] = new FetchError("blocked.example doesn't let servers read its pages.");
  const { tab, id } = await shoppingList();
  const added = await tab.request('POST', `api/lists/${id}/items`, { values: { Link: 'https://blocked.example/p' } });
  let item = (await settled(tab, id)).items[0];
  assert.equal(item.links.link.status, 'failed');
  assert.match(item.links.link.error, /doesn't let servers/);

  pages['https://blocked.example/p'] = couch;
  const retried = await tab.request('POST', `api/lists/${id}/items/${added.data.items[0].id}/lookup`);
  assert.equal(retried.data.list.items[0].links.link.status, 'pending');
  item = (await settled(tab, id)).items[0];
  assert.equal(item.values.price, 183.53);
});

test('a link column can be told what to fill, or to look nothing up', async () => {
  pages['https://shop.example/rug'] = { ...couch, title: 'Rug', price: 260 };
  const { tab, id } = await shoppingList();
  await tab.request('POST', `api/lists/${id}/columns`, { name: 'Budget', type: 'currency' });
  await tab.request('PATCH', `api/lists/${id}/columns/link`, { fill: { price: 'Budget', title: null } });
  await tab.request('POST', `api/lists/${id}/items`, { values: { Link: 'https://shop.example/rug' } });
  let item = (await settled(tab, id)).items[0];
  assert.equal(item.values.budget, 260);
  assert.equal(item.values.price, undefined);
  assert.equal(item.values.item, undefined);

  await tab.request('PATCH', `api/lists/${id}/columns/link`, { lookup: false });
  const before = fetched.length;
  await tab.request('POST', `api/lists/${id}/items`, { values: { Link: 'https://shop.example/elsewhere' } });
  item = (await settled(tab, id)).items[1];
  assert.equal(item.links, undefined);
  assert.equal(fetched.length, before);
});

test('the same link is fetched once, however many rows it is in', async () => {
  pages['https://shop.example/once'] = couch;
  const { tab, id } = await shoppingList();
  const before = fetched.filter((u) => u === 'https://shop.example/once').length;
  await tab.request('POST', `api/lists/${id}/items`, { values: { Link: 'https://shop.example/once' } });
  await tab.request('POST', `api/lists/${id}/items`, { values: { Link: 'https://shop.example/once' } });
  await settled(tab, id);
  assert.equal(fetched.filter((u) => u === 'https://shop.example/once').length - before, 1);
});

test('links from before lookups existed are looked up when the server starts', async () => {
  pages['https://shop.example/old'] = { ...couch, title: 'Old link' };
  const { tab, id } = await shoppingList();
  // Switched off, a link goes in without a lookup, like one from an older version.
  await tab.request('PATCH', `api/lists/${id}/columns/link`, { lookup: false });
  await tab.request('POST', `api/lists/${id}/items`, { values: { Link: 'https://shop.example/old' } });
  await tab.request('PATCH', `api/lists/${id}/columns/link`, { lookup: true });
  assert.equal((await settled(tab, id)).items[0].links, undefined);

  server.app.service.lookups.resume();
  const item = (await settled(tab, id)).items[0];
  assert.equal(item.values.item, 'Old link');
  assert.equal(item.links.link.status, 'done');
});

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadConfig } from '../server/config.ts';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  addColumn,
  addItems,
  coerce,
  emptyDoc,
  findColumn,
  moveItem,
  removeColumn,
  removeItems,
  setGroupBy,
  updateColumn,
  updateItem,
  validateListId,
} from '../server/model.ts';

const { limits } = loadConfig({ DATA_DIR: mkdtempSync(join(tmpdir(), 'shared-list-model-')), SESSION_SECRET: 'y' });

function furniture() {
  const doc = emptyDoc();
  addColumn(doc, { name: 'Got it', type: 'checkbox' }, limits);
  addColumn(doc, { name: 'Item' }, limits);
  addColumn(doc, { name: 'Room', type: 'select', options: ['Living room', 'Bedroom'] }, limits);
  addColumn(doc, { name: 'Price', type: 'currency' }, limits);
  addColumn(doc, { name: 'Link', type: 'url' }, limits);
  return doc;
}

test('column ids come from names and stay unique', () => {
  const doc = furniture();
  assert.deepEqual(doc.columns.map((c) => c.id), ['got-it', 'item', 'room', 'price', 'link']);
  assert.equal(doc.columns[3].currency, 'USD');
  assert.throws(() => addColumn(doc, { name: 'price' }, limits), /already a column/);
  assert.equal(findColumn(doc.columns, 'GOT IT')?.id, 'got-it');
  assert.equal(findColumn(doc.columns, 'item')?.name, 'Item');
});

test('values are coerced the way people type them', () => {
  const doc = furniture();
  const [item] = addItems(doc, [{ Item: 'Sofa', price: '$1,299.50', Room: 'living ROOM', link: 'ikea.com/p/123', 'Got it': 'yes' }], limits);
  assert.deepEqual(item.values, {
    'item': 'Sofa',
    price: 1299.5,
    room: 'Living room',
    link: 'https://ikea.com/p/123',
    'got-it': true,
  });
});

test('an unknown select label becomes a new option', () => {
  const doc = furniture();
  addItems(doc, [{ Item: 'Desk', Room: 'Office' }], limits);
  const room = findColumn(doc.columns, 'room')!;
  assert.deepEqual(room.options!.map((o) => o.value), ['Living room', 'Bedroom', 'Office']);
});

test('bad values are refused with a message naming the column', () => {
  const doc = furniture();
  assert.throws(() => addItems(doc, [{ Price: 'cheap' }], limits), /"cheap" in "Price" is not a number/);
  assert.throws(() => addItems(doc, [{ Link: 'javascript:alert(1)' }], limits), /only takes http and https/);
  assert.throws(() => addItems(doc, [{ Colour: 'red' }], limits), /No column "Colour"/);
  // Nothing from a failed batch lands.
  assert.throws(() => addItems(doc, [{ Item: 'ok' }, { Price: 'nope' }], limits));
  assert.equal(doc.items.length, 0);
});

test('dates normalize to YYYY-MM-DD', () => {
  const column = { id: 'due', name: 'Due', type: 'date' as const };
  assert.equal(coerce(column, '2026-11-02', limits, false), '2026-11-02');
  assert.throws(() => coerce(column, '2026-02-30', limits, false), /not a date/);
});

test('retyping keeps what still makes sense and reports the rest', () => {
  const doc = emptyDoc();
  addColumn(doc, { name: 'Qty' }, limits);
  addItems(doc, [{ Qty: '12' }, { Qty: 'a few' }, {}], limits);
  const { cleared } = updateColumn(doc, 'qty', { type: 'number' }, limits);
  assert.equal(cleared, 1);
  assert.deepEqual(doc.items.map((i) => i.values.qty), [12, undefined, undefined]);
});

test('renaming an option carries its rows along', () => {
  const doc = furniture();
  addItems(doc, [{ Room: 'Bedroom' }, { Room: 'Living room' }], limits);
  updateColumn(doc, 'room', { options: [{ value: 'Lounge', from: 'Living room' }, 'Bedroom'] }, limits);
  assert.deepEqual(doc.items.map((i) => i.values.room), ['Bedroom', 'Lounge']);
});

test('grouping, moving, editing and removing', () => {
  const doc = furniture();
  const [a, b, c] = addItems(doc, [{ Item: 'A' }, { Item: 'B' }, { Item: 'C' }], limits);
  moveItem(doc, c.id, 0);
  assert.deepEqual(doc.items.map((i) => i.values['item']), ['C', 'A', 'B']);
  updateItem(doc, a.id, { Price: 10, Item: null }, limits);
  assert.deepEqual(doc.items[1].values, { price: 10 });
  assert.throws(() => setGroupBy(doc, 'price'), /select or checkbox/);
  setGroupBy(doc, 'room');
  removeColumn(doc, 'room');
  assert.equal(doc.view.group_by, null);
  removeItems(doc, [b.id]);
  assert.equal(doc.items.length, 2);
  assert.throws(() => removeItems(doc, ['nope']), /No item/);
});

test('list ids', () => {
  assert.equal(validateListId('Apartment-Furniture'), 'apartment-furniture');
  assert.throws(() => validateListId('api'), /reserved/);
  assert.equal(validateListId('admin'), 'admin');
  assert.throws(() => validateListId('-x-'), /lowercase/);
  assert.throws(() => validateListId('a'), /3 to 48/);
});

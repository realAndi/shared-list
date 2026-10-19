// Everything that changes a list's contents, as plain functions over its
// document. Nothing here touches the database or knows who is asking; the
// service wraps these in a transaction and the routes decide who may call them.

import { randomInt } from 'node:crypto';
import type { Limits } from './config.ts';
import { AppError, invalid } from './errors.ts';
import {
  COLUMN_TYPES,
  TAG_COLORS,
  type CellValue,
  type Column,
  type ColumnInput,
  type ColumnType,
  type Item,
  type ListView,
  type SelectOption,
  type TagColor,
} from '../shared/types.ts';

export interface ListDoc {
  description: string;
  columns: Column[];
  items: Item[];
  view: ListView;
}

export function emptyDoc(): ListDoc {
  return { description: '', columns: [], items: [], view: { group_by: null } };
}

// --- ids ----------------------------------------------------------------------

/** No 0/o, 1/l/i: list ids get read out loud and typed on phones. */
const ID_ALPHABET = '23456789abcdefghjkmnpqrstuvwxyz';

export function randomId(length: number, prefix = ''): string {
  let id = prefix;
  for (let i = 0; i < length; i++) id += ID_ALPHABET[randomInt(ID_ALPHABET.length)];
  return id;
}

/** Paths the app itself answers on, so no list can be named after one. */
export const RESERVED_IDS = new Set([
  'admin', 'api', 'mcp', 'assets', 'healthz', 'new', 'static', 'login', 'logout', 'favicon',
]);

export function validateListId(raw: unknown): string {
  if (typeof raw !== 'string') throw invalid('The list id must be a string.');
  const id = raw.trim().toLowerCase();
  if (!/^[a-z0-9](?:[a-z0-9-]{1,46}[a-z0-9])$/.test(id)) {
    throw invalid('A list id is 3 to 48 lowercase letters, digits or dashes, and starts and ends with a letter or digit.');
  }
  if (RESERVED_IDS.has(id)) throw invalid(`"${id}" is reserved. Pick another list id.`);
  return id;
}

// --- list fields --------------------------------------------------------------

function text(raw: unknown, field: string, min: number, max: number): string {
  if (typeof raw !== 'string') throw invalid(`${field} must be a string.`);
  const value = raw.trim();
  if (value.length < min) throw invalid(min === 1 ? `${field} can't be empty.` : `${field} needs at least ${min} characters.`);
  if (value.length > max) throw invalid(`${field} can be at most ${max} characters.`);
  return value;
}

export const validateTitle = (raw: unknown) => text(raw, 'The title', 1, 120);
export const validateDescription = (raw: unknown) => text(raw ?? '', 'The description', 0, 2000);

export function validatePassword(raw: unknown): string {
  if (typeof raw !== 'string') throw invalid('The password must be a string.');
  if (raw.length < 4) throw invalid('The password needs at least 4 characters.');
  if (raw.length > 200) throw invalid('The password can be at most 200 characters.');
  return raw;
}

export function validateCss(raw: unknown, limits: Limits): string {
  if (typeof raw !== 'string') throw invalid('CSS must be a string.');
  const css = raw.replace(/\0/g, '');
  const bytes = Buffer.byteLength(css);
  if (bytes > limits.maxCssBytes) {
    throw new AppError('too_large', `The CSS is ${bytes} bytes; the limit is ${limits.maxCssBytes}.`);
  }
  return css;
}

// --- columns ------------------------------------------------------------------

function slug(name: string): string {
  const s = name
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 32)
    .replace(/-+$/, '');
  return s || 'column';
}

function uniqueColumnId(columns: Column[], name: string): string {
  const base = slug(name);
  const taken = new Set(columns.map((c) => c.id));
  if (!taken.has(base)) return base;
  for (let n = 2; ; n++) {
    const candidate = `${base}-${n}`;
    if (!taken.has(candidate)) return candidate;
  }
}

/** A column by id, or by name (case and spacing ignored), which is how agents tend to refer to them. */
export function findColumn(columns: Column[], key: string): Column | undefined {
  const wanted = key.trim().toLowerCase();
  return (
    columns.find((c) => c.id === key) ??
    columns.find((c) => c.name.trim().toLowerCase() === wanted) ??
    columns.find((c) => c.id === slug(key))
  );
}

function columnList(columns: Column[]): string {
  return columns.length ? columns.map((c) => `"${c.name}" (${c.id}, ${c.type})`).join(', ') : 'none yet';
}

export function requireColumn(columns: Column[], key: string): Column {
  const column = findColumn(columns, key);
  if (!column) throw new AppError('not_found', `No column "${key}". Columns: ${columnList(columns)}.`);
  return column;
}

function columnType(raw: unknown): ColumnType {
  if (raw === undefined) return 'text';
  if (typeof raw === 'string' && (COLUMN_TYPES as readonly string[]).includes(raw)) return raw as ColumnType;
  throw invalid(`Unknown column type "${String(raw)}". Use one of: ${COLUMN_TYPES.join(', ')}.`);
}

const CURRENCIES = new Set(Intl.supportedValuesOf('currency'));

function currencyCode(raw: unknown): string {
  if (raw === undefined || raw === null || raw === '') return 'USD';
  const code = typeof raw === 'string' ? raw.trim().toUpperCase() : '';
  if (!CURRENCIES.has(code)) throw invalid(`"${String(raw)}" is not an ISO 4217 currency code, like USD or EUR.`);
  return code;
}

/** New options take the next color in this order, so the first few are easy to tell apart. */
const COLOR_CYCLE: TagColor[] = ['blue', 'green', 'yellow', 'orange', 'purple', 'pink', 'teal', 'red', 'gray'];

function nextColor(options: SelectOption[]): TagColor {
  return COLOR_CYCLE[options.length % COLOR_CYCLE.length];
}

function tagColor(raw: unknown): TagColor | undefined {
  if (raw === undefined || raw === null || raw === '') return undefined;
  if (typeof raw === 'string' && (TAG_COLORS as readonly string[]).includes(raw)) return raw as TagColor;
  throw invalid(`Unknown color "${String(raw)}". Use one of: ${TAG_COLORS.join(', ')}.`);
}

function optionLabel(raw: unknown): string {
  return text(raw, 'An option', 1, 60);
}

export interface OptionInput {
  value: string;
  color?: TagColor;
  /** Renames an existing option: rows holding `from` are moved to `value`. */
  from?: string;
}

function parseOptions(raw: unknown, limits: Limits): { options: SelectOption[]; renames: Map<string, string> } {
  if (raw === undefined || raw === null) return { options: [], renames: new Map() };
  if (!Array.isArray(raw)) throw invalid('Options must be a list.');
  const options: SelectOption[] = [];
  const renames = new Map<string, string>();
  for (const entry of raw as (string | OptionInput)[]) {
    const input = typeof entry === 'string' ? { value: entry } : entry;
    if (!input || typeof input !== 'object') throw invalid('Each option is a string or { value, color }.');
    const value = optionLabel(input.value);
    if (options.some((o) => o.value.toLowerCase() === value.toLowerCase())) continue;
    options.push({ value, color: tagColor(input.color) ?? nextColor(options) });
    if (typeof input.from === 'string' && input.from !== value) renames.set(input.from, value);
  }
  if (options.length > limits.maxOptions) throw invalid(`A column can have at most ${limits.maxOptions} options.`);
  return { options, renames };
}

function clampIndex(index: unknown, length: number): number {
  if (index === undefined || index === null) return length;
  if (typeof index !== 'number' || !Number.isInteger(index)) throw invalid('A position must be a whole number.');
  return Math.max(0, Math.min(length, index));
}

export function addColumn(doc: ListDoc, input: ColumnInput, limits: Limits, position?: number): Column {
  if (!input || typeof input !== 'object') throw invalid('A column needs at least a name.');
  if (doc.columns.length >= limits.maxColumns) {
    throw new AppError('too_large', `A list can have at most ${limits.maxColumns} columns.`);
  }
  const name = text(input.name, 'A column name', 1, 60);
  if (doc.columns.some((c) => c.name.toLowerCase() === name.toLowerCase())) {
    throw new AppError('conflict', `There is already a column called "${name}".`);
  }
  const type = columnType(input.type);
  const column: Column = { id: uniqueColumnId(doc.columns, name), name, type };
  if (type === 'select') column.options = parseOptions(input.options, limits).options;
  if (type === 'currency') column.currency = currencyCode(input.currency);
  doc.columns.splice(clampIndex(position, doc.columns.length), 0, column);
  return column;
}

export interface ColumnPatch {
  name?: string;
  type?: ColumnType;
  options?: (string | OptionInput)[];
  currency?: string;
  position?: number;
}

/** Returns how many cells were emptied because their value had no meaning in the new type. */
export function updateColumn(doc: ListDoc, key: string, patch: ColumnPatch, limits: Limits): { column: Column; cleared: number } {
  const column = requireColumn(doc.columns, key);
  let cleared = 0;

  if (patch.name !== undefined) {
    const name = text(patch.name, 'A column name', 1, 60);
    if (doc.columns.some((c) => c !== column && c.name.toLowerCase() === name.toLowerCase())) {
      throw new AppError('conflict', `There is already a column called "${name}".`);
    }
    column.name = name;
  }

  const type = patch.type === undefined ? column.type : columnType(patch.type);
  const retyped = type !== column.type;
  if (retyped) {
    column.type = type;
    if (type !== 'select') delete column.options;
    if (type !== 'currency') delete column.currency;
    if (type === 'select') column.options = [];
    if (type === 'currency') column.currency = 'USD';
    if (doc.view.group_by === column.id && type !== 'select' && type !== 'checkbox') doc.view.group_by = null;
  }

  if (patch.currency !== undefined && column.type === 'currency') column.currency = currencyCode(patch.currency);

  let renames = new Map<string, string>();
  if (patch.options !== undefined) {
    if (column.type !== 'select') throw invalid(`Only select columns have options; "${column.name}" is ${column.type}.`);
    ({ options: column.options, renames } = parseOptions(patch.options, limits));
  }

  if (retyped || patch.options !== undefined) {
    for (const item of doc.items) {
      if (!(column.id in item.values)) continue;
      let value = item.values[column.id];
      if (typeof value === 'string' && renames.has(value)) value = renames.get(value)!;
      try {
        // Retyping keeps whatever still makes sense — a text "12" becomes the
        // number 12, a text value becomes a new option — and drops the rest.
        const next = coerce(column, value, limits, retyped);
        if (next === null) delete item.values[column.id];
        else item.values[column.id] = next;
      } catch {
        delete item.values[column.id];
        cleared++;
      }
    }
  }

  if (patch.position !== undefined) {
    const from = doc.columns.indexOf(column);
    doc.columns.splice(from, 1);
    doc.columns.splice(clampIndex(patch.position, doc.columns.length), 0, column);
  }

  return { column, cleared };
}

export function removeColumn(doc: ListDoc, key: string): Column {
  const column = requireColumn(doc.columns, key);
  doc.columns = doc.columns.filter((c) => c !== column);
  for (const item of doc.items) delete item.values[column.id];
  if (doc.view.group_by === column.id) doc.view.group_by = null;
  return column;
}

export function setGroupBy(doc: ListDoc, key: string | null): void {
  if (key === null || key === '') {
    doc.view.group_by = null;
    return;
  }
  const column = requireColumn(doc.columns, key);
  if (column.type !== 'select' && column.type !== 'checkbox') {
    throw invalid(`Rows can only be grouped by a select or checkbox column; "${column.name}" is ${column.type}.`);
  }
  doc.view.group_by = column.id;
}

// --- values -------------------------------------------------------------------

const TRUE_WORDS = new Set(['true', 'yes', 'y', '1', 'x', 'done', 'checked', 'on']);
const FALSE_WORDS = new Set(['false', 'no', 'n', '0', 'off', 'unchecked']);

function parseNumber(raw: string): number | undefined {
  const cleaned = raw.replace(/[\s,_$€£¥₹]/g, '');
  if (!/^[-+]?(\d+\.?\d*|\.\d+)(e[-+]?\d+)?$/i.test(cleaned)) return undefined;
  const n = Number(cleaned);
  return Number.isFinite(n) ? n : undefined;
}

function parseUrl(raw: string, column: Column): string {
  let value = raw.trim();
  // "ikea.com/p/123" is how links get typed on a phone.
  if (!/^[a-z][a-z0-9+.-]*:/i.test(value) && /^[\w-]+(\.[\w-]+)+/.test(value)) value = `https://${value}`;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw invalid(`"${raw}" in "${column.name}" is not a link.`);
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    throw invalid(`"${column.name}" only takes http and https links.`);
  }
  if (url.href.length > 2048) throw invalid(`That link in "${column.name}" is longer than 2048 characters.`);
  return url.href;
}

function parseDate(raw: string, column: Column): string {
  const value = raw.trim();
  const iso = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  const date = iso ? new Date(Date.UTC(+iso[1], +iso[2] - 1, +iso[3])) : new Date(value);
  if (Number.isNaN(date.getTime()) || (iso && date.getUTCDate() !== +iso[3])) {
    throw invalid(`"${raw}" in "${column.name}" is not a date. Use YYYY-MM-DD.`);
  }
  if (!iso) {
    // A free-form date is read in the server's zone; keep the calendar day it named.
    return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
  }
  return date.toISOString().slice(0, 10);
}

/**
 * Turns whatever was sent into the value a column stores, or throws a message
 * that says what was wrong. `addOptions` lets a select column grow a new option
 * instead of refusing an unknown one.
 */
export function coerce(column: Column, raw: unknown, limits: Limits, addOptions: boolean): CellValue {
  if (raw === null || raw === undefined || raw === '') return null;

  switch (column.type) {
    case 'text': {
      const value = typeof raw === 'boolean' ? (raw ? 'Yes' : 'No') : typeof raw === 'number' ? String(raw) : raw;
      if (typeof value !== 'string') throw invalid(`"${column.name}" takes text.`);
      if (value.length > limits.maxCellChars) {
        throw invalid(`"${column.name}" can hold at most ${limits.maxCellChars} characters.`);
      }
      return value.trim() === '' ? null : value;
    }
    case 'number':
    case 'currency': {
      const n = typeof raw === 'number' ? raw : typeof raw === 'string' ? parseNumber(raw) : undefined;
      if (n === undefined || !Number.isFinite(n)) throw invalid(`"${String(raw)}" in "${column.name}" is not a number.`);
      return n;
    }
    case 'checkbox': {
      if (typeof raw === 'boolean') return raw;
      if (typeof raw === 'number') return raw !== 0;
      if (typeof raw === 'string') {
        const word = raw.trim().toLowerCase();
        if (TRUE_WORDS.has(word)) return true;
        if (FALSE_WORDS.has(word)) return false;
      }
      throw invalid(`"${column.name}" is a checkbox; send true or false.`);
    }
    case 'url':
    case 'image':
      if (typeof raw !== 'string') throw invalid(`"${column.name}" takes a link.`);
      return parseUrl(raw, column);
    case 'date':
      if (typeof raw !== 'string') throw invalid(`"${column.name}" takes a date as YYYY-MM-DD.`);
      return parseDate(raw, column);
    case 'select': {
      const value = typeof raw === 'string' ? raw.trim() : typeof raw === 'number' || typeof raw === 'boolean' ? String(raw) : undefined;
      if (!value) throw invalid(`"${column.name}" takes one of its options.`);
      const options = (column.options ??= []);
      const match = options.find((o) => o.value.toLowerCase() === value.toLowerCase());
      if (match) return match.value;
      if (!addOptions) {
        throw invalid(`"${value}" is not an option in "${column.name}". Options: ${options.map((o) => o.value).join(', ') || 'none yet'}.`);
      }
      if (options.length >= limits.maxOptions) throw invalid(`"${column.name}" already has ${limits.maxOptions} options.`);
      const label = optionLabel(value);
      options.push({ value: label, color: nextColor(options) });
      return label;
    }
  }
}

/** `{ "Price": "$12" }` or `{ price: 12 }` → `{ price: 12 }`. */
export function normalizeValues(doc: ListDoc, input: unknown, limits: Limits): Record<string, CellValue> {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw invalid('Item values are an object of column → value.');
  }
  const out: Record<string, CellValue> = {};
  for (const [key, raw] of Object.entries(input)) {
    const column = findColumn(doc.columns, key);
    if (!column) throw invalid(`No column "${key}". Columns: ${columnList(doc.columns)}.`);
    out[column.id] = coerce(column, raw, limits, true);
  }
  return out;
}

// --- items --------------------------------------------------------------------

function now(): string {
  return new Date().toISOString();
}

function requireItem(doc: ListDoc, id: unknown): Item {
  const item = typeof id === 'string' ? doc.items.find((i) => i.id === id) : undefined;
  if (!item) throw new AppError('not_found', `No item with id "${String(id)}" in this list.`);
  return item;
}

function applyValues(item: Item, values: Record<string, CellValue>): void {
  for (const [key, value] of Object.entries(values)) {
    if (value === null) delete item.values[key];
    else item.values[key] = value;
  }
}

export function addItems(doc: ListDoc, inputs: unknown[], limits: Limits, position?: number): Item[] {
  if (!Array.isArray(inputs) || inputs.length === 0) throw invalid('Send at least one item.');
  if (doc.items.length + inputs.length > limits.maxItems) {
    throw new AppError('too_large', `A list can hold at most ${limits.maxItems} items; this one has ${doc.items.length}.`);
  }
  // Validate every item before inserting any, so a bad row in a batch changes nothing.
  const prepared = inputs.map((input) => normalizeValues(doc, input ?? {}, limits));
  const stamp = now();
  const taken = new Set(doc.items.map((i) => i.id));
  const items = prepared.map((values) => {
    let id: string;
    do id = randomId(8, 'i'); while (taken.has(id));
    taken.add(id);
    const item: Item = { id, values: {}, created_at: stamp, updated_at: stamp };
    applyValues(item, values);
    return item;
  });
  doc.items.splice(clampIndex(position, doc.items.length), 0, ...items);
  return items;
}

export function updateItem(doc: ListDoc, id: unknown, values: unknown, limits: Limits): Item {
  const item = requireItem(doc, id);
  applyValues(item, normalizeValues(doc, values, limits));
  item.updated_at = now();
  return item;
}

export function removeItems(doc: ListDoc, ids: unknown): string[] {
  if (!Array.isArray(ids) || ids.length === 0) throw invalid('Send at least one item id.');
  const wanted = new Set(ids.map(String));
  const removed = doc.items.filter((i) => wanted.has(i.id)).map((i) => i.id);
  const missing = [...wanted].filter((id) => !removed.includes(id));
  if (missing.length) throw new AppError('not_found', `No item with id ${missing.map((m) => `"${m}"`).join(', ')}.`);
  doc.items = doc.items.filter((i) => !wanted.has(i.id));
  return removed;
}

export function moveItem(doc: ListDoc, id: unknown, index: unknown): void {
  const item = requireItem(doc, id);
  doc.items.splice(doc.items.indexOf(item), 1);
  doc.items.splice(clampIndex(index, doc.items.length), 0, item);
}

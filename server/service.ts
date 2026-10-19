// The operations both the web API and the MCP tools offer, each one a single
// transaction. Callers have already decided the caller may do it.

import { createHash } from 'node:crypto';
import type { Limits } from './config.ts';
import { AppError, invalid } from './errors.ts';
import { hashPassword, verifyPassword } from './auth.ts';
import {
  addColumn,
  addItems,
  emptyDoc,
  moveItem,
  randomId,
  removeColumn,
  removeItems,
  setGroupBy,
  updateColumn,
  updateItem,
  validateCss,
  validateDescription,
  validateListId,
  validatePassword,
  validateTitle,
  type ColumnPatch,
} from './model.ts';
import type { ListRow, Store } from './store.ts';
import { PRESETS } from '../shared/presets.ts';
import type { Column, ColumnInput, Item, ListPayload, ListSummary, Role } from '../shared/types.ts';

export interface CreateListInput {
  title?: unknown;
  password?: unknown;
  id?: unknown;
  description?: unknown;
  editable?: unknown;
  preset?: unknown;
  columns?: unknown;
  items?: unknown;
  css?: unknown;
  group_by?: unknown;
}

export interface ListPatch {
  title?: unknown;
  description?: unknown;
  group_by?: unknown;
}

export interface AccessPatch {
  password?: unknown;
  /** Only the token that created a list may change this; the caller checks. */
  editable?: unknown;
}

export class ListService {
  readonly store: Store;
  readonly limits: Limits;
  private readonly basePath: string;

  constructor(store: Store, limits: Limits, basePath: string) {
    this.store = store;
    this.limits = limits;
    this.basePath = basePath;
  }

  /** The link people open, e.g. https://example.com/shared-list/abc. */
  link(id: string, origin: string): string {
    return `${origin}${this.basePath}${id}`;
  }

  get(id: string): ListRow {
    const row = this.store.get(id);
    if (!row) throw new AppError('not_found', `No list with id "${id}".`);
    return row;
  }

  payload(row: ListRow, role: Role, origin: string): ListPayload {
    return {
      id: row.id,
      url: this.link(row.id, origin),
      title: row.title,
      description: row.doc.description,
      editable: row.editable,
      columns: row.doc.columns,
      items: row.doc.items,
      view: row.doc.view,
      version: row.version,
      has_css: row.css.trim() !== '',
      css_rev: row.css.trim() === '' ? '' : createHash('sha256').update(row.css).digest('base64url').slice(0, 12),
      created_at: row.created_at,
      updated_at: row.updated_at,
      role,
    };
  }

  summariesFor(tokenId: string, origin: string): ListSummary[] {
    return this.store.summariesFor(tokenId).map((s) => ({ ...s, url: this.link(s.id, origin) }));
  }

  async checkPassword(id: string, password: unknown): Promise<ListRow> {
    const row = this.get(id);
    if (typeof password !== 'string' || !(await verifyPassword(password, row.password_hash))) {
      throw new AppError('unauthorized', 'That password does not open this list.');
    }
    return row;
  }

  private checkStorage(): void {
    if (this.store.sizeBytes() >= this.limits.maxDbBytes) {
      throw new AppError('storage_full', 'This server has used all the storage it is allowed. Delete a list or some items first.');
    }
  }

  /**
   * `owner` is the MCP token making the list, if any. A list made on the web has
   * no owner, so it is always editable: nobody would be left who could edit it.
   */
  async create(input: CreateListInput, owner: string | null = null): Promise<ListRow> {
    if (this.store.count() >= this.limits.maxLists) {
      throw new AppError('too_large', `This server already holds ${this.limits.maxLists} lists, its limit.`);
    }
    this.checkStorage();

    const title = validateTitle(input.title);
    const password = validatePassword(input.password);
    let id: string;
    if (input.id !== undefined && input.id !== null && input.id !== '') {
      id = validateListId(input.id);
      if (this.store.get(id)) throw new AppError('conflict', `A list with id "${id}" already exists.`);
    } else {
      do id = randomId(10); while (this.store.get(id));
    }

    const doc = emptyDoc();
    doc.description = validateDescription(input.description ?? '');

    let columns: ColumnInput[];
    if (input.columns !== undefined && input.columns !== null) {
      if (!Array.isArray(input.columns) || input.columns.length === 0) throw invalid('Columns must be a non-empty list.');
      columns = input.columns as ColumnInput[];
    } else {
      const preset = typeof input.preset === 'string' && input.preset ? input.preset : 'blank';
      if (!PRESETS[preset]) throw invalid(`Unknown preset "${preset}". Use one of: ${Object.keys(PRESETS).join(', ')}.`);
      columns = PRESETS[preset].columns;
    }
    for (const column of columns) addColumn(doc, column, this.limits);

    if (input.items !== undefined && input.items !== null) {
      if (!Array.isArray(input.items)) throw invalid('Items must be a list of objects.');
      if (input.items.length) addItems(doc, input.items, this.limits);
    }
    if (typeof input.group_by === 'string' && input.group_by) setGroupBy(doc, input.group_by);

    const stamp = new Date().toISOString();
    const row: ListRow = {
      id,
      title,
      password_hash: await hashPassword(password),
      auth_epoch: 1,
      editable: owner === null || input.editable === undefined ? true : Boolean(input.editable),
      owner_token: owner,
      doc,
      css: input.css === undefined || input.css === null ? '' : validateCss(input.css, this.limits),
      version: 1,
      created_at: stamp,
      updated_at: stamp,
    };
    // Two creates racing for the same id: the second fails on the primary key.
    try {
      this.store.insert(row);
    } catch {
      throw new AppError('conflict', `A list with id "${id}" already exists.`);
    }
    return row;
  }

  private change<T>(id: string, fn: (row: ListRow) => T): { row: ListRow; result: T } {
    const out = this.store.update(id, fn);
    if (!out) throw new AppError('not_found', `No list with id "${id}".`);
    return out;
  }

  updateList(id: string, patch: ListPatch): ListRow {
    return this.change(id, (row) => {
      if (patch.title !== undefined) row.title = validateTitle(patch.title);
      if (patch.description !== undefined) row.doc.description = validateDescription(patch.description);
      if (patch.group_by !== undefined) {
        if (patch.group_by !== null && typeof patch.group_by !== 'string') throw invalid('group_by is a column or null.');
        setGroupBy(row.doc, patch.group_by);
      }
    }).row;
  }

  async updateAccess(id: string, patch: AccessPatch): Promise<ListRow> {
    const hash = patch.password === undefined ? undefined : await hashPassword(validatePassword(patch.password));
    return this.change(id, (row) => {
      if (hash) {
        row.password_hash = hash;
        row.auth_epoch += 1;
      }
      if (patch.editable !== undefined) row.editable = Boolean(patch.editable);
    }).row;
  }

  setCss(id: string, css: unknown): ListRow {
    const value = validateCss(css, this.limits);
    return this.change(id, (row) => {
      row.css = value;
    }).row;
  }

  addColumns(id: string, inputs: unknown, position?: number): { row: ListRow; result: Column[] } {
    if (!Array.isArray(inputs) || inputs.length === 0) throw invalid('Send at least one column.');
    return this.change(id, (row) =>
      inputs.map((input, i) => addColumn(row.doc, input as ColumnInput, this.limits, position === undefined ? undefined : position + i)),
    );
  }

  updateColumn(id: string, key: string, patch: ColumnPatch): { row: ListRow; result: { column: Column; cleared: number } } {
    return this.change(id, (row) => updateColumn(row.doc, key, patch, this.limits));
  }

  removeColumn(id: string, key: string): { row: ListRow; result: Column } {
    return this.change(id, (row) => {
      if (row.doc.columns.length === 1) throw invalid('A list needs at least one column.');
      return removeColumn(row.doc, key);
    });
  }

  addItems(id: string, inputs: unknown, position?: number): { row: ListRow; result: Item[] } {
    this.checkStorage();
    return this.change(id, (row) => addItems(row.doc, inputs as unknown[], this.limits, position));
  }

  updateItems(id: string, updates: unknown): { row: ListRow; result: Item[] } {
    if (!Array.isArray(updates) || updates.length === 0) throw invalid('Send at least one update.');
    return this.change(id, (row) =>
      updates.map((u: { item_id?: unknown; id?: unknown; values?: unknown }) =>
        updateItem(row.doc, u?.item_id ?? u?.id, u?.values, this.limits),
      ),
    );
  }

  removeItems(id: string, itemIds: unknown): { row: ListRow; result: string[] } {
    return this.change(id, (row) => removeItems(row.doc, itemIds));
  }

  moveItem(id: string, itemId: unknown, index: unknown): ListRow {
    return this.change(id, (row) => moveItem(row.doc, itemId, index)).row;
  }

  delete(id: string): void {
    if (!this.store.delete(id)) throw new AppError('not_found', `No list with id "${id}".`);
  }
}

// SQLite through Node's built-in driver: one file, no native module to build,
// and fast enough that a list is simply read, changed and written back whole.

import { DatabaseSync } from 'node:sqlite';
import { statSync } from 'node:fs';
import type { ListDoc } from './model.ts';

export interface ListRow {
  id: string;
  title: string;
  password_hash: string;
  /** Bumped when the password changes, which signs every open session out. */
  auth_epoch: number;
  editable: boolean;
  /** The MCP token that created the list, if one did. Null for lists made on the web. */
  owner_token: string | null;
  doc: ListDoc;
  css: string;
  /** Bumped on every change. Clients poll with it. */
  version: number;
  created_at: string;
  updated_at: string;
}

interface RawRow extends Omit<ListRow, 'editable' | 'doc'> {
  editable: number;
  doc: string;
}

export interface RowSummary {
  id: string;
  title: string;
  editable: boolean;
  items: number;
  created_at: string;
  updated_at: string;
}

export interface TokenRow {
  id: string;
  name: string;
  /** SHA-256 of the secret. The secret itself is shown once, when it is made, and never stored. */
  hash: string;
  created_at: string;
  last_used_at: string | null;
}

function fromRaw(raw: RawRow): ListRow {
  return { ...raw, editable: raw.editable === 1, doc: JSON.parse(raw.doc) as ListDoc };
}

export class Store {
  readonly file: string;
  private db: DatabaseSync;

  constructor(file: string) {
    this.file = file;
    this.db = new DatabaseSync(file);
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA synchronous = NORMAL;
      PRAGMA busy_timeout = 5000;
      PRAGMA foreign_keys = ON;
      CREATE TABLE IF NOT EXISTS lists (
        id            TEXT PRIMARY KEY,
        title         TEXT NOT NULL,
        password_hash TEXT NOT NULL,
        auth_epoch    INTEGER NOT NULL DEFAULT 1,
        editable      INTEGER NOT NULL DEFAULT 1,
        doc           TEXT NOT NULL,
        css           TEXT NOT NULL DEFAULT '',
        version       INTEGER NOT NULL DEFAULT 1,
        created_at    TEXT NOT NULL,
        updated_at    TEXT NOT NULL
      ) STRICT;
      CREATE TABLE IF NOT EXISTS tokens (
        id           TEXT PRIMARY KEY,
        name         TEXT NOT NULL,
        hash         TEXT NOT NULL UNIQUE,
        created_at   TEXT NOT NULL,
        last_used_at TEXT
      ) STRICT;
      -- A token that opened a list with its password, under the password epoch it used.
      CREATE TABLE IF NOT EXISTS grants (
        token_id TEXT NOT NULL REFERENCES tokens(id) ON DELETE CASCADE,
        list_id  TEXT NOT NULL REFERENCES lists(id) ON DELETE CASCADE,
        epoch    INTEGER NOT NULL,
        PRIMARY KEY (token_id, list_id)
      ) STRICT;
    `);
    // Databases from before tokens existed.
    const columns = this.db.prepare('PRAGMA table_info(lists)').all() as { name: string }[];
    if (!columns.some((c) => c.name === 'owner_token')) {
      this.db.exec('ALTER TABLE lists ADD COLUMN owner_token TEXT');
    }
  }

  // --- lists ----------------------------------------------------------------

  get(id: string): ListRow | undefined {
    const raw = this.db.prepare('SELECT * FROM lists WHERE id = ?').get(id) as RawRow | undefined;
    return raw ? fromRaw(raw) : undefined;
  }

  /** The lists a token created or has opened under the current password, most recently changed first. */
  summariesFor(tokenId: string): RowSummary[] {
    const rows = this.db
      .prepare(
        `SELECT id, title, editable, json_array_length(doc, '$.items') AS items, created_at, updated_at
         FROM lists
         WHERE owner_token = ?1
            OR id IN (SELECT g.list_id FROM grants g WHERE g.token_id = ?1 AND g.epoch = lists.auth_epoch)
         ORDER BY updated_at DESC`,
      )
      .all(tokenId) as unknown as (Omit<RowSummary, 'editable'> & { editable: number })[];
    return rows.map((r) => ({ ...r, editable: r.editable === 1 }));
  }

  count(): number {
    return (this.db.prepare('SELECT count(*) AS n FROM lists').get() as { n: number }).n;
  }

  insert(row: ListRow): void {
    this.db
      .prepare(
        `INSERT INTO lists (id, title, password_hash, auth_epoch, editable, owner_token, doc, css, version, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        row.id,
        row.title,
        row.password_hash,
        row.auth_epoch,
        row.editable ? 1 : 0,
        row.owner_token,
        JSON.stringify(row.doc),
        row.css,
        row.version,
        row.created_at,
        row.updated_at,
      );
  }

  /**
   * Read, change and write one list as a single transaction. `change` edits the
   * row in place; if it throws, nothing is written.
   */
  update<T>(id: string, change: (row: ListRow) => T): { row: ListRow; result: T } | undefined {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const row = this.get(id);
      if (!row) {
        this.db.exec('ROLLBACK');
        return undefined;
      }
      const result = change(row);
      row.version += 1;
      row.updated_at = new Date().toISOString();
      this.db
        .prepare(
          `UPDATE lists SET title = ?, password_hash = ?, auth_epoch = ?, editable = ?, doc = ?, css = ?,
             version = ?, updated_at = ? WHERE id = ?`,
        )
        .run(
          row.title,
          row.password_hash,
          row.auth_epoch,
          row.editable ? 1 : 0,
          JSON.stringify(row.doc),
          row.css,
          row.version,
          row.updated_at,
          id,
        );
      this.db.exec('COMMIT');
      return { row, result };
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  delete(id: string): boolean {
    return Number(this.db.prepare('DELETE FROM lists WHERE id = ?').run(id).changes) > 0;
  }

  // --- tokens ---------------------------------------------------------------

  insertToken(token: TokenRow): void {
    this.db
      .prepare('INSERT INTO tokens (id, name, hash, created_at, last_used_at) VALUES (?, ?, ?, ?, ?)')
      .run(token.id, token.name, token.hash, token.created_at, token.last_used_at);
  }

  tokenByHash(hash: string): TokenRow | undefined {
    return this.db.prepare('SELECT * FROM tokens WHERE hash = ?').get(hash) as TokenRow | undefined;
  }

  tokens(): (TokenRow & { lists: number })[] {
    return this.db
      .prepare(
        `SELECT t.*, (SELECT count(*) FROM lists l WHERE l.owner_token = t.id) AS lists
         FROM tokens t ORDER BY t.created_at`,
      )
      .all() as unknown as (TokenRow & { lists: number })[];
  }

  deleteToken(id: string): boolean {
    return Number(this.db.prepare('DELETE FROM tokens WHERE id = ?').run(id).changes) > 0;
  }

  touchToken(id: string, at: string): void {
    this.db.prepare('UPDATE tokens SET last_used_at = ? WHERE id = ?').run(at, id);
  }

  grant(tokenId: string, listId: string, epoch: number): void {
    this.db
      .prepare('INSERT INTO grants (token_id, list_id, epoch) VALUES (?, ?, ?) ON CONFLICT (token_id, list_id) DO UPDATE SET epoch = excluded.epoch')
      .run(tokenId, listId, epoch);
  }

  grantEpoch(tokenId: string, listId: string): number | undefined {
    const row = this.db.prepare('SELECT epoch FROM grants WHERE token_id = ? AND list_id = ?').get(tokenId, listId) as
      | { epoch: number }
      | undefined;
    return row?.epoch;
  }

  // --- the file ---------------------------------------------------------------

  /** The database plus its write-ahead log, which is what the disk actually holds. */
  sizeBytes(): number {
    let total = 0;
    for (const suffix of ['', '-wal']) {
      try {
        total += statSync(this.file + suffix).size;
      } catch {
        // No WAL yet.
      }
    }
    return total;
  }

  /** A consistent copy, safe to take while the app is serving. */
  backupTo(path: string): void {
    this.db.prepare('VACUUM INTO ?').run(path);
  }

  close(): void {
    this.db.close();
  }
}

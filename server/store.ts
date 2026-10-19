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
  doc: ListDoc;
  css: string;
  /** Bumped on every change. Clients poll with it. */
  version: number;
  created_at: string;
  updated_at: string;
}

interface RawRow {
  id: string;
  title: string;
  password_hash: string;
  auth_epoch: number;
  editable: number;
  doc: string;
  css: string;
  version: number;
  created_at: string;
  updated_at: string;
}

export interface RowSummary {
  id: string;
  title: string;
  editable: boolean;
  items: number;
  created_at: string;
  updated_at: string;
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
    `);
  }

  get(id: string): ListRow | undefined {
    const raw = this.db.prepare('SELECT * FROM lists WHERE id = ?').get(id) as RawRow | undefined;
    return raw ? fromRaw(raw) : undefined;
  }

  /** Version only, for the cheap "has anything changed" poll. */
  version(id: string): number | undefined {
    const row = this.db.prepare('SELECT version FROM lists WHERE id = ?').get(id) as { version: number } | undefined;
    return row?.version;
  }

  summaries(): RowSummary[] {
    const rows = this.db
      .prepare(
        `SELECT id, title, editable, json_array_length(doc, '$.items') AS items, created_at, updated_at
         FROM lists ORDER BY updated_at DESC`,
      )
      .all() as unknown as (Omit<RowSummary, 'editable'> & { editable: number })[];
    return rows.map((r) => ({ ...r, editable: r.editable === 1 }));
  }

  count(): number {
    return (this.db.prepare('SELECT count(*) AS n FROM lists').get() as { n: number }).n;
  }

  insert(row: ListRow): void {
    this.db
      .prepare(
        `INSERT INTO lists (id, title, password_hash, auth_epoch, editable, doc, css, version, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        row.id,
        row.title,
        row.password_hash,
        row.auth_epoch,
        row.editable ? 1 : 0,
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

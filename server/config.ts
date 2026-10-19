import { randomBytes } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

export interface Limits {
  maxLists: number;
  maxItems: number;
  maxColumns: number;
  maxOptions: number;
  maxCellChars: number;
  maxCssBytes: number;
  maxBodyBytes: number;
  /** New lists one address may make from the web in an hour. */
  createsPerHour: number;
  /** Creating lists and adding rows stop once the database file reaches this. */
  maxDbBytes: number;
}

export interface Config {
  /** A TCP port, or a path to listen on as a Unix socket. */
  listen: string;
  /** Where the app is mounted, with leading and trailing slash: `/` or `/shared-list/`. */
  basePath: string;
  /** Origin used in links the server hands out, e.g. `https://example.com`. Empty means "from the request". */
  publicUrl: string;
  dataDir: string;
  sessionSecret: Buffer;
  /** Believe X-Real-IP / X-Forwarded-For. Only safe when a proxy is the only thing that can connect. */
  trustProxy: boolean;
  backupKeep: number;
  webDir: string;
  limits: Limits;
}

function int(value: string | undefined, fallback: number): number {
  if (value === undefined || value === '') return fallback;
  const n = Number(value);
  if (!Number.isInteger(n) || n < 0) throw new Error(`Expected a whole number, got "${value}"`);
  return n;
}

function normalizeBase(value: string): string {
  const trimmed = value.trim().replace(/^\/+|\/+$/g, '');
  return trimmed ? `/${trimmed}/` : '/';
}

/**
 * A secret from the environment, or else one generated on first start and kept
 * in the data directory, so a self-hosted install works with no configuration
 * and still survives restarts.
 */
function persistentSecret(dataDir: string, file: string, fromEnv: string | undefined): { value: string } {
  if (fromEnv) return { value: fromEnv.trim() };
  const path = join(dataDir, file);
  if (existsSync(path)) return { value: readFileSync(path, 'utf8').trim() };
  const value = randomBytes(32).toString('base64url');
  writeFileSync(path, value + '\n', { mode: 0o600 });
  chmodSync(path, 0o600);
  return { value };
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const dataDir = resolve(env.DATA_DIR ?? './data');
  mkdirSync(dataDir, { recursive: true });

  const listen = env.LISTEN ?? env.PORT ?? '8787';
  const isSocket = !/^\d+$/.test(listen);

  const session = persistentSecret(dataDir, 'session-secret', env.SESSION_SECRET);

  return {
    listen,
    basePath: normalizeBase(env.BASE_PATH ?? '/'),
    publicUrl: (env.PUBLIC_URL ?? '').replace(/\/+$/, ''),
    dataDir,
    sessionSecret: Buffer.from(session.value),
    trustProxy: env.TRUST_PROXY ? env.TRUST_PROXY === '1' || env.TRUST_PROXY === 'true' : isSocket,
    backupKeep: int(env.BACKUP_KEEP, 7),
    webDir: resolve(env.WEB_DIR ?? './dist/web'),
    limits: {
      maxLists: int(env.MAX_LISTS, 200),
      maxItems: int(env.MAX_ITEMS, 1000),
      maxColumns: int(env.MAX_COLUMNS, 30),
      maxOptions: 50,
      maxCellChars: int(env.MAX_CELL_CHARS, 5000),
      maxCssBytes: int(env.MAX_CSS_BYTES, 64 * 1024),
      maxBodyBytes: int(env.MAX_BODY_BYTES, 1024 * 1024),
      createsPerHour: int(env.MAX_CREATES_PER_HOUR, 10),
      maxDbBytes: int(env.MAX_DB_MB, 100) * 1024 * 1024,
    },
  };
}

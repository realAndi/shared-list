import { createHash, createHmac, randomBytes, scrypt, timingSafeEqual } from 'node:crypto';

// --- passwords ----------------------------------------------------------------

// N=2^14 is about 16 MB and 50 ms a hash: slow enough to matter to a guesser,
// cheap enough for a small box.
const SCRYPT = { N: 16384, r: 8, p: 1, keylen: 32 };

function derive(password: string, salt: Buffer, N: number, r: number, p: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scrypt(password.normalize('NFC'), salt, SCRYPT.keylen, { N, r, p, maxmem: 64 * 1024 * 1024 }, (error, key) =>
      error ? reject(error) : resolve(key),
    );
  });
}

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const key = await derive(password, salt, SCRYPT.N, SCRYPT.r, SCRYPT.p);
  return ['scrypt', SCRYPT.N, SCRYPT.r, SCRYPT.p, salt.toString('base64url'), key.toString('base64url')].join('$');
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const [scheme, N, r, p, salt, hash] = stored.split('$');
  if (scheme !== 'scrypt' || !hash) return false;
  const expected = Buffer.from(hash, 'base64url');
  const key = await derive(password, Buffer.from(salt, 'base64url'), Number(N), Number(r), Number(p));
  return key.length === expected.length && timingSafeEqual(key, expected);
}

/** Constant-time string comparison, by way of fixed-length digests. */
export function safeEqual(a: string, b: string): boolean {
  const da = createHash('sha256').update(a).digest();
  const db = createHash('sha256').update(b).digest();
  return timingSafeEqual(da, db);
}

// --- sessions -----------------------------------------------------------------

/**
 * A session is a signed cookie, not a server-side record: it names the list,
 * the password epoch it was issued under, and when it expires. Changing a
 * list's password bumps the epoch, which retires every cookie for it at once.
 */
export interface Session {
  list: string;
  epoch: number;
  expires: number;
}

export const SESSION_DAYS = 30;

export function signSession(session: Session, secret: Buffer): string {
  const body = Buffer.from(JSON.stringify([session.list, session.epoch, session.expires])).toString('base64url');
  const mac = createHmac('sha256', secret).update(body).digest('base64url');
  return `${body}.${mac}`;
}

export function readSession(token: string | undefined, secret: Buffer): Session | undefined {
  if (!token) return undefined;
  const [body, mac] = token.split('.');
  if (!body || !mac) return undefined;
  const expected = createHmac('sha256', secret).update(body).digest();
  const given = Buffer.from(mac, 'base64url');
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) return undefined;
  try {
    const [list, epoch, expires] = JSON.parse(Buffer.from(body, 'base64url').toString()) as [string, number, number];
    if (typeof list !== 'string' || typeof epoch !== 'number' || typeof expires !== 'number') return undefined;
    if (expires < Date.now()) return undefined;
    return { list, epoch, expires };
  } catch {
    return undefined;
  }
}

/** One cookie per list, so being signed in to one list says nothing about another. */
export const cookieName = (listId: string) => `sl_${listId.replace(/[^a-z0-9-]/g, '')}`;

export function parseCookies(header: string | undefined): Map<string, string> {
  const cookies = new Map<string, string>();
  for (const part of (header ?? '').split(';')) {
    const eq = part.indexOf('=');
    if (eq < 0) continue;
    const name = part.slice(0, eq).trim();
    if (!cookies.has(name)) cookies.set(name, part.slice(eq + 1).trim());
  }
  return cookies;
}

export function sessionCookie(name: string, value: string, path: string, secure: boolean, maxAgeSeconds: number): string {
  return [
    `${name}=${value}`,
    `Path=${path}`,
    `Max-Age=${maxAgeSeconds}`,
    'HttpOnly',
    'SameSite=Lax',
    ...(secure ? ['Secure'] : []),
  ].join('; ');
}

// --- rate limiting ------------------------------------------------------------

/**
 * Counts failures per key in a fixed window. Only failures are counted, so
 * someone who knows the password is never slowed down by the limit.
 */
export class FailureLimiter {
  private readonly max: number;
  private readonly windowMs: number;
  private readonly hits = new Map<string, { count: number; resetAt: number }>();

  constructor(max: number, windowMs: number) {
    this.max = max;
    this.windowMs = windowMs;
    setInterval(() => this.sweep(), windowMs).unref();
  }

  /** Seconds until the key may try again, or 0 if it may try now. */
  blockedFor(key: string): number {
    const entry = this.hits.get(key);
    if (!entry || entry.resetAt <= Date.now() || entry.count < this.max) return 0;
    return Math.ceil((entry.resetAt - Date.now()) / 1000);
  }

  fail(key: string): void {
    const at = Date.now();
    const entry = this.hits.get(key);
    if (!entry || entry.resetAt <= at) this.hits.set(key, { count: 1, resetAt: at + this.windowMs });
    else entry.count++;
  }

  clear(key: string): void {
    this.hits.delete(key);
  }

  private sweep(): void {
    const at = Date.now();
    for (const [key, entry] of this.hits) if (entry.resetAt <= at) this.hits.delete(key);
  }
}

// MCP tokens. There is no way to make one over HTTP: they come from the CLI
// (server/cli.ts), so only someone with a shell on the server can hand one out.

import { createHash, randomBytes } from 'node:crypto';
import { AppError, invalid } from './errors.ts';
import { randomId } from './model.ts';
import type { Store, TokenRow } from './store.ts';

const PREFIX = 'sl_';

export function hashToken(secret: string): string {
  return createHash('sha256').update(secret).digest('hex');
}

/** Returns the secret, which exists only in this return value from now on. */
export function createToken(store: Store, rawName: string): { id: string; name: string; token: string } {
  const name = rawName.trim();
  if (!name) throw invalid('Give the token a name, like the person it is for.');
  if (name.length > 60) throw invalid('A token name can be at most 60 characters.');
  const token = PREFIX + randomBytes(24).toString('base64url');
  const id = randomId(6, 'tok_');
  store.insertToken({ id, name, hash: hashToken(token), created_at: new Date().toISOString(), last_used_at: null });
  return { id, name, token };
}

export function verifyToken(store: Store, secret: string): TokenRow | undefined {
  // Secrets are 192 random bits, so a plain hash is the right tool: there is
  // nothing to brute-force that a slow hash would protect.
  if (!secret.startsWith(PREFIX)) return undefined;
  const token = store.tokenByHash(hashToken(secret));
  if (token && (!token.last_used_at || Date.now() - Date.parse(token.last_used_at) > 60_000)) {
    store.touchToken(token.id, new Date().toISOString());
  }
  return token;
}

/** By id, or by name when exactly one token has it. */
export function revokeToken(store: Store, key: string): TokenRow {
  const all = store.tokens();
  const byId = all.find((t) => t.id === key);
  const byName = all.filter((t) => t.name.toLowerCase() === key.toLowerCase());
  const token = byId ?? (byName.length === 1 ? byName[0] : undefined);
  if (!token) {
    throw new AppError(
      'not_found',
      byName.length > 1 ? `More than one token is called "${key}"; revoke it by id.` : `No token "${key}".`,
    );
  }
  store.deleteToken(token.id);
  return token;
}

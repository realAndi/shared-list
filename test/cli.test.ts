import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const cli = new URL('../server/cli.ts', import.meta.url).pathname;

test('the CLI makes, lists and revokes tokens', () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'shared-list-cli-'));
  const env = { ...process.env, DATA_DIR: dataDir, BASE_PATH: '/shared-list', PUBLIC_URL: 'https://example.com' };
  const run = (...args: string[]) => execFileSync(process.execPath, [cli, ...args], { env, encoding: 'utf8' });
  try {
    const made = run('token', 'create', 'Roommate');
    assert.match(made, /^Token for Roommate \(tok_\w+\)/);
    const secret = /\n {2}(sl_[\w-]+)\n/.exec(made)?.[1];
    assert.ok(secret, made);
    assert.match(made, new RegExp(`https://example.com/shared-list/mcp --header "Authorization: Bearer ${secret}"`));

    const listed = run('token', 'list');
    assert.match(listed, /Roommate/);
    assert.ok(!listed.includes(secret!), 'the secret is never shown again');

    assert.match(run('token', 'revoke', 'roommate'), /Revoked Roommate/);
    assert.match(run('token', 'list'), /No tokens yet/);
  } finally {
    rmSync(dataDir, { recursive: true, force: true });
  }
});

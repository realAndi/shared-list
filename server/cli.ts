// MCP tokens are made here and nowhere else, so handing one out takes a shell
// on the server. In the container:
//
//   docker exec <container> node server/cli.ts token create "Roommate"
//   docker exec <container> node server/cli.ts token list
//   docker exec <container> node server/cli.ts token revoke <id or name>

import { join } from 'node:path';
import { loadConfig } from './config.ts';
import { AppError } from './errors.ts';
import { Store } from './store.ts';
import { createToken, revokeToken } from './tokens.ts';

const USAGE = `Usage:
  node server/cli.ts token create <name>     make a token; it is shown once
  node server/cli.ts token list              every token, and what it last did
  node server/cli.ts token revoke <id|name>  stop a token working`;

const [group, command, ...rest] = process.argv.slice(2);
if (group !== 'token' || !command) {
  console.log(USAGE);
  process.exit(group ? 1 : 0);
}

const config = loadConfig();
const store = new Store(join(config.dataDir, 'shared-list.db'));

try {
  if (command === 'create') {
    const { id, name, token } = createToken(store, rest.join(' '));
    console.log(`Token for ${name} (${id}). This is the only time it is shown:\n\n  ${token}\n`);
    console.log('It can create lists, and open other lists with their passwords. Connect with:');
    const url = config.publicUrl ? `${config.publicUrl}${config.basePath}mcp` : `https://<host>${config.basePath}mcp`;
    console.log(`\n  claude mcp add --transport http shared-list ${url} --header "Authorization: Bearer ${token}"\n`);
  } else if (command === 'list') {
    const tokens = store.tokens();
    if (!tokens.length) console.log('No tokens yet. Make one with: node server/cli.ts token create <name>');
    for (const t of tokens) {
      const used = t.last_used_at ? `last used ${t.last_used_at.slice(0, 16).replace('T', ' ')}` : 'never used';
      console.log(`${t.id}  ${t.name.padEnd(24)}  ${String(t.lists).padStart(3)} list${t.lists === 1 ? ' ' : 's'}  made ${t.created_at.slice(0, 10)}  ${used}`);
    }
  } else if (command === 'revoke') {
    const token = revokeToken(store, rest.join(' '));
    console.log(`Revoked ${token.name} (${token.id}). The lists it made stay, and open with their passwords as before.`);
  } else {
    console.log(USAGE);
    process.exitCode = 1;
  }
} catch (error) {
  if (!(error instanceof AppError)) throw error;
  console.error(error.message);
  process.exitCode = 1;
} finally {
  store.close();
}

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import { createApp, type App } from '../server/app.ts';
import { loadConfig, type Config } from '../server/config.ts';

export const ADMIN = 'test-admin-token-0123456789';

export interface Running {
  app: App;
  config: Config;
  base: string;
  stop(): Promise<void>;
}

export async function start(env: Record<string, string> = {}): Promise<Running> {
  const dataDir = mkdtempSync(join(tmpdir(), 'shared-list-test-'));
  const config = loadConfig({
    DATA_DIR: dataDir,
    ADMIN_TOKEN: ADMIN,
    BASE_PATH: '/shared-list',
    BACKUP_KEEP: '0',
    WEB_DIR: join(dataDir, 'no-web'),
    ...env,
  });
  const app = createApp(config);
  await new Promise<void>((resolve) => app.server.listen(0, '127.0.0.1', resolve));
  const { port } = app.server.address() as AddressInfo;
  return {
    app,
    config,
    base: `http://127.0.0.1:${port}/shared-list/`,
    stop: async () => {
      await app.close();
      rmSync(dataDir, { recursive: true, force: true });
    },
  };
}

/** A tiny client that keeps cookies, like a browser tab would. */
export class Browser {
  readonly base: string;
  private cookies = new Map<string, string>();

  constructor(base: string) {
    this.base = base;
  }

  async request(method: string, path: string, body?: unknown, headers: Record<string, string> = {}) {
    const res = await fetch(this.base + path, {
      method,
      headers: {
        ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
        ...(this.cookies.size ? { Cookie: [...this.cookies].map(([k, v]) => `${k}=${v}`).join('; ') } : {}),
        ...headers,
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      redirect: 'manual',
    });
    for (const cookie of res.headers.getSetCookie()) {
      const [pair] = cookie.split(';');
      const [name, value] = pair.split('=');
      if (value) this.cookies.set(name, value);
      else this.cookies.delete(name);
    }
    const text = await res.text();
    let data: any = text;
    try {
      data = JSON.parse(text);
    } catch {
      // Not JSON.
    }
    return { status: res.status, headers: res.headers, data };
  }
}

import { chmodSync, rmSync } from 'node:fs';
import { createApp } from './app.ts';
import { loadConfig } from './config.ts';

const config = loadConfig();
const app = createApp(config);
const socket = /^\d+$/.test(config.listen) ? undefined : config.listen;

if (socket) {
  // A socket left by a container that was killed would make listen fail.
  rmSync(socket, { force: true });
  app.server.listen(socket, () => {
    // The proxy runs as another user; it needs to be able to connect.
    chmodSync(socket, 0o666);
    console.log(`Shared List listening on ${socket} at ${config.basePath}`);
  });
} else {
  app.server.listen(Number(config.listen), () => {
    console.log(`Shared List listening on http://localhost:${config.listen}${config.basePath}`);
  });
}

let stopping = false;
for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    if (stopping) return;
    stopping = true;
    void app.close().then(() => {
      if (socket) rmSync(socket, { force: true });
      process.exit(0);
    });
  });
}

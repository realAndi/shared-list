// `node server/healthcheck.ts` exits 0 if the server answers. Used by the
// container's HEALTHCHECK, which cannot use curl when the app is on a socket.

import { request } from 'node:http';

const listen = process.env.LISTEN ?? process.env.PORT ?? '8787';
const base = `/${(process.env.BASE_PATH ?? '').replace(/^\/+|\/+$/g, '')}/`.replace('//', '/');
const target = /^\d+$/.test(listen) ? { port: Number(listen) } : { socketPath: listen };

const req = request({ ...target, path: `${base}healthz`, timeout: 3000 }, (res) => {
  process.exit(res.statusCode === 200 ? 0 : 1);
});
req.on('timeout', () => req.destroy());
req.on('error', () => process.exit(1));
req.end();

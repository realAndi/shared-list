// Fetches a web page someone pasted, without letting the link point the server
// at itself. The address check happens in the connection's own DNS lookup, so
// the IP that is checked is the IP that is connected to: a name that resolves
// to something public once and to 127.0.0.1 the next time gets nowhere.

import { lookup as dnsLookup, type LookupAddress } from 'node:dns';
import { request as httpRequest, type IncomingMessage } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { BlockList, isIP } from 'node:net';
import { createBrotliDecompress, createGunzip, createInflate } from 'node:zlib';
import type { Readable } from 'node:stream';

/** Everything that is not the public internet. */
const PRIVATE = new BlockList();
for (const [net, prefix] of [
  ['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8], ['169.254.0.0', 16],
  ['172.16.0.0', 12], ['192.0.0.0', 24], ['192.0.2.0', 24], ['192.88.99.0', 24], ['192.168.0.0', 16],
  ['198.18.0.0', 15], ['198.51.100.0', 24], ['203.0.113.0', 24], ['224.0.0.0', 4], ['240.0.0.0', 4],
] as const) {
  PRIVATE.addSubnet(net, prefix, 'ipv4');
}
// Not ::ffff:0:0/96: BlockList checks IPv4 addresses against IPv6 rules as
// mapped addresses, so that rule would block all of IPv4. Mapped addresses are
// unwrapped below instead.
for (const [net, prefix] of [
  ['::', 128], ['::1', 128], ['64:ff9b::', 96], ['100::', 64], ['2001:db8::', 32],
  ['fc00::', 7], ['fe80::', 10], ['ff00::', 8],
] as const) {
  PRIVATE.addSubnet(net, prefix, 'ipv6');
}

export function isPrivateAddress(address: string): boolean {
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(address)?.[1];
  if (mapped) return isPrivateAddress(mapped);
  const family = isIP(address);
  if (family === 0) return true;
  // ::ffff:7f00:1 is 127.0.0.1 written in hex.
  if (family === 6 && /^::ffff:[0-9a-f]{1,4}:[0-9a-f]{1,4}$/i.test(address)) return true;
  return PRIVATE.check(address, family === 4 ? 'ipv4' : 'ipv6');
}

export class FetchError extends Error {}

type LookupCallback = (error: NodeJS.ErrnoException | null, address: string | LookupAddress[], family?: number) => void;

function publicLookup(hostname: string, options: { all?: boolean }, callback: LookupCallback): void {
  dnsLookup(hostname, { all: true }, (error, addresses) => {
    if (error) return callback(error, '');
    // One private answer spoils the lot, so a name cannot mix the two and hope.
    if (!addresses.length || addresses.some((a) => isPrivateAddress(a.address))) {
      return callback(Object.assign(new Error(`${hostname} is not on the public internet`), { code: 'EPRIVATE' }), '');
    }
    if (options.all) callback(null, addresses);
    else callback(null, addresses[0].address, addresses[0].family);
  });
}

function checkUrl(url: URL): void {
  if (url.protocol !== 'https:' && url.protocol !== 'http:') throw new FetchError('Only http and https links can be looked up.');
  if (url.username || url.password) throw new FetchError('Links with a username or password are not looked up.');
  // Web pages live on the web's ports; anything else is somebody's service.
  if (url.port && url.port !== '80' && url.port !== '443') throw new FetchError('Only links on the standard web ports are looked up.');
  const host = url.hostname.replace(/^\[|\]$/g, '');
  if (isIP(host) && isPrivateAddress(host)) throw new FetchError('That link points at a private address.');
  if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.internal') || host.endsWith('.local')) {
    throw new FetchError('That link points at a private address.');
  }
}

export interface Page {
  url: string;
  status: number;
  contentType: string;
  body: string;
}

export interface FetchOptions {
  userAgent: string;
  timeoutMs?: number;
  maxBytes?: number;
  maxRedirects?: number;
  /** Ask for and read JSON rather than a page. */
  json?: boolean;
}

function once(url: URL, userAgent: string, timeoutMs: number, json = false): Promise<IncomingMessage> {
  return new Promise((resolve, reject) => {
    const request = (url.protocol === 'https:' ? httpsRequest : httpRequest)(url, {
      method: 'GET',
      agent: false,
      lookup: publicLookup as never,
      timeout: timeoutMs,
      headers: {
        'User-Agent': userAgent,
        Accept: json ? 'application/json' : 'text/html,application/xhtml+xml;q=0.9,*/*;q=0.5',
        'Accept-Language': 'en-US,en;q=0.9',
        'Accept-Encoding': 'gzip, deflate, br',
      },
    });
    request.on('response', resolve);
    request.on('timeout', () => request.destroy(new FetchError('The site took too long to answer.')));
    request.on('error', (error: NodeJS.ErrnoException) => {
      if (error instanceof FetchError) reject(error);
      else if (error.code === 'EPRIVATE') reject(new FetchError('That link points at a private address.'));
      else if (error.code === 'ENOTFOUND') reject(new FetchError(`There is no site at ${url.hostname}.`));
      else reject(new FetchError(`Could not reach ${url.hostname}.`));
    });
    request.end();
  });
}

function decoded(res: IncomingMessage): Readable {
  switch ((res.headers['content-encoding'] ?? '').toLowerCase()) {
    case 'gzip':
    case 'x-gzip':
      return res.pipe(createGunzip());
    case 'deflate':
      return res.pipe(createInflate());
    case 'br':
      return res.pipe(createBrotliDecompress());
    default:
      return res;
  }
}

/** Reads up to `maxBytes` of the decoded body. A page cut short is still worth reading. */
function readText(res: IncomingMessage, maxBytes: number, deadline: number): Promise<string> {
  return new Promise((resolve) => {
    const stream = decoded(res);
    const chunks: Buffer[] = [];
    let size = 0;
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      res.destroy();
      const charset = /charset=["']?([\w-]+)/i.exec(String(res.headers['content-type'] ?? ''))?.[1] ?? 'utf-8';
      let decoder: TextDecoder;
      try {
        decoder = new TextDecoder(charset);
      } catch {
        decoder = new TextDecoder('utf-8');
      }
      resolve(decoder.decode(Buffer.concat(chunks)));
    };
    const timer = setTimeout(finish, Math.max(0, deadline - Date.now()));
    stream.on('data', (chunk: Buffer) => {
      chunks.push(chunk);
      size += chunk.length;
      if (size >= maxBytes) finish();
    });
    stream.on('end', finish);
    stream.on('error', finish);
  });
}

export async function getPage(start: string, opts: FetchOptions): Promise<Page> {
  const timeoutMs = opts.timeoutMs ?? 10_000;
  const deadline = Date.now() + timeoutMs;
  let url: URL;
  try {
    url = new URL(start);
  } catch {
    throw new FetchError('That is not a link.');
  }

  for (let hop = 0; hop <= (opts.maxRedirects ?? 6); hop++) {
    // Every hop is checked again: a public page can redirect anywhere.
    checkUrl(url);
    const left = deadline - Date.now();
    if (left <= 0) throw new FetchError('The site took too long to answer.');
    const res = await once(url, opts.userAgent, left, opts.json);
    const status = res.statusCode ?? 0;
    const location = res.headers.location;
    if (status >= 300 && status < 400 && location) {
      res.destroy();
      url = new URL(location, url);
      continue;
    }
    const contentType = String(res.headers['content-type'] ?? '').toLowerCase();
    // Only pages, or JSON when that was asked for, are read. For anything else the headers say all there is to know.
    if (!opts.json && !/text\/html|application\/xhtml\+xml/.test(contentType)) {
      res.destroy();
      return { url: url.href, status, contentType, body: '' };
    }
    return { url: url.href, status, contentType, body: await readText(res, opts.maxBytes ?? 2_500_000, deadline) };
  }
  throw new FetchError('That link redirects too many times.');
}

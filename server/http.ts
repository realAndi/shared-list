import type { IncomingMessage, ServerResponse } from 'node:http';
import { AppError, invalid } from './errors.ts';

export interface Context {
  req: IncomingMessage;
  res: ServerResponse;
  url: URL;
  /** The path below the app's base, without a leading slash: `api/lists/abc`. */
  path: string;
  ip: string;
  /** Scheme and host the browser used, e.g. `https://example.com`. */
  origin: string;
  secure: boolean;
}

export function send(res: ServerResponse, status: number, body: string | Buffer, headers: Record<string, string> = {}): void {
  res.writeHead(status, { 'Content-Length': String(Buffer.byteLength(body)), ...headers });
  res.end(body);
}

export function json(res: ServerResponse, status: number, data: unknown, headers: Record<string, string> = {}): void {
  send(res, status, JSON.stringify(data), {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    ...headers,
  });
}

export function sendError(res: ServerResponse, error: unknown): void {
  if (error instanceof AppError) {
    const headers: Record<string, string> = {};
    if (error.retryAfter) headers['Retry-After'] = String(error.retryAfter);
    json(res, error.status, { error: { code: error.code, message: error.message } }, headers);
    return;
  }
  console.error(error);
  json(res, 500, { error: { code: 'internal', message: 'Something went wrong on the server.' } });
}

export function readBody(req: IncomingMessage, maxBytes: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const declared = Number(req.headers['content-length'] ?? 0);
    if (declared > maxBytes) {
      reject(new AppError('too_large', `Requests can be at most ${maxBytes} bytes.`));
      req.resume();
      return;
    }
    const chunks: Buffer[] = [];
    let size = 0;
    req.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > maxBytes) {
        reject(new AppError('too_large', `Requests can be at most ${maxBytes} bytes.`));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

/**
 * Every write takes JSON. Besides being the API's format, that keeps a
 * cross-site form from posting here: a form cannot send this content type
 * without a CORS preflight, which this server never answers.
 */
export async function readJson(req: IncomingMessage, maxBytes: number): Promise<Record<string, unknown>> {
  const type = req.headers['content-type'] ?? '';
  if (!/^application\/json\b/i.test(type)) throw invalid('Send the request body as application/json.');
  const body = await readBody(req, maxBytes);
  let data: unknown;
  try {
    data = JSON.parse(body.toString('utf8') || '{}');
  } catch {
    throw invalid('The request body is not valid JSON.');
  }
  if (!data || typeof data !== 'object' || Array.isArray(data)) throw invalid('The request body must be a JSON object.');
  return data as Record<string, unknown>;
}

export function bearer(req: IncomingMessage): string | undefined {
  const header = req.headers.authorization;
  const match = header ? /^Bearer\s+(.+)$/i.exec(header) : null;
  return match?.[1].trim();
}

import { storage } from './dom.ts';
import type { ListPayload, ListSummary } from '../../shared/types.ts';

/** Where the app is mounted, from the <base> the server injects; `/` in development. */
export const BASE = new URL(document.querySelector('base')?.getAttribute('href') ?? '/', location.origin).pathname;

const ADMIN_KEY = 'sl-admin-token';

export const adminToken = {
  get: () => storage.get(ADMIN_KEY),
  set: (token: string | null) => storage.set(ADMIN_KEY, token),
};

export class ApiError extends Error {
  readonly status: number;
  readonly code: string;

  constructor(status: number, code: string, message: string) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

async function request<T>(method: string, path: string, body?: unknown, token = adminToken.get()): Promise<T | undefined> {
  let res: Response;
  try {
    res = await fetch(BASE + path, {
      method,
      credentials: 'same-origin',
      headers: {
        ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch {
    throw new ApiError(0, 'offline', 'Could not reach the server. Check your connection and try again.');
  }
  if (res.status === 204) return undefined;
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const error = data?.error ?? {};
    // A stored admin token that has since been rotated: forget it and carry on as a visitor.
    if (res.status === 401 && token && /admin token/.test(error.message ?? '')) {
      adminToken.set(null);
      return request<T>(method, path, body, null);
    }
    throw new ApiError(res.status, error.code ?? 'error', error.message ?? `The server answered ${res.status}.`);
  }
  return data as T;
}

type ListResponse = { list: ListPayload };
const list = (path: string) => `api/lists/${encodeURIComponent(path)}`;

export const api = {
  get: (id: string, since?: number) =>
    request<ListResponse>('GET', list(id) + (since === undefined ? '' : `?since=${since}`)),
  unlock: (id: string, password: string) => request<ListResponse>('POST', `${list(id)}/unlock`, { password }),
  lock: (id: string) => request('POST', `${list(id)}/lock`),
  update: (id: string, patch: Record<string, unknown>) => request<ListResponse>('PATCH', list(id), patch),
  remove: (id: string) => request('DELETE', list(id)),
  setCss: (id: string, css: string) => request<ListResponse>('PUT', `${list(id)}/css`, { css }),
  addColumn: (id: string, column: Record<string, unknown>) => request<ListResponse>('POST', `${list(id)}/columns`, column),
  updateColumn: (id: string, column: string, patch: Record<string, unknown>) =>
    request<ListResponse & { cleared: number }>('PATCH', `${list(id)}/columns/${encodeURIComponent(column)}`, patch),
  removeColumn: (id: string, column: string) =>
    request<ListResponse>('DELETE', `${list(id)}/columns/${encodeURIComponent(column)}`),
  addItem: (id: string, values: Record<string, unknown>, position?: number) =>
    request<ListResponse & { items: { id: string }[] }>('POST', `${list(id)}/items`, { values, position }),
  updateItem: (id: string, item: string, values: Record<string, unknown>) =>
    request<ListResponse>('PATCH', `${list(id)}/items/${encodeURIComponent(item)}`, { values }),
  removeItem: (id: string, item: string) => request<ListResponse>('DELETE', `${list(id)}/items/${encodeURIComponent(item)}`),
  moveItem: (id: string, item: string, index: number) =>
    request<ListResponse>('POST', `${list(id)}/items/${encodeURIComponent(item)}/move`, { index }),
  admin: (token?: string) => request<{ lists: ListSummary[] }>('GET', 'api/admin', undefined, token ?? adminToken.get()),
  create: (input: Record<string, unknown>) => request<ListResponse>('POST', 'api/lists', input),
};

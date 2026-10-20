// When a link lands in a link column, look the page up in the background and
// fill the row's empty price, photo and name from it. A page link put in an
// image column is swapped for the photo on that page. Nothing a person typed is
// ever overwritten, and a lookup that finishes after its link was changed or
// removed is dropped.

import { RateLimiter } from './auth.ts';
import { extract, isAmazon, isBotWall, merge, type Preview } from './extract.ts';
import { FetchError, getPage } from './fetcher.ts';
import { coerce, fillFromLink } from './model.ts';
import type { Limits } from './config.ts';
import type { Store } from './store.ts';
import type { LinkInfo } from '../shared/types.ts';

const BOT = 'SharedListBot/1.0 (+https://github.com/realAndi/shared-list)';
const BROWSER = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36';

/**
 * Asks as itself first: plenty of shops, Temu among them, hand a named crawler
 * the page with its product data in it. If that leaves the price or the photo
 * out, it asks again as a browser. Amazon only ever answers the browser.
 */
export async function fetchPreview(url: string): Promise<Preview> {
  let host: string;
  try {
    host = new URL(url).hostname.toLowerCase();
  } catch {
    throw new FetchError('That is not a link.');
  }
  const agents = isAmazon(host) ? [BROWSER] : [BOT, BROWSER];
  let found: Preview | undefined;
  let problem: string | undefined;
  for (const agent of agents) {
    try {
      const page = await getPage(url, { userAgent: agent });
      if (page.status >= 400) {
        problem = page.status === 403 || page.status === 429 || page.status === 503
          ? `${new URL(page.url).hostname} doesn't let servers read its pages.`
          : `The page answered ${page.status}.`;
        continue;
      }
      if (/^image\//.test(page.contentType)) return { url: page.url, site: new URL(page.url).hostname.replace(/^www\./, ''), image: page.url };
      if (!page.body) continue;
      if (isBotWall(page.body)) {
        problem = `${new URL(page.url).hostname.replace(/^www\./, '')} asked for a CAPTCHA instead of showing the page.`;
        continue;
      }
      found = merge(found, extract(page.body, page.url));
      if (found.price !== undefined && found.image) break;
    } catch (error) {
      if (!(error instanceof FetchError)) throw error;
      problem = error.message;
      // A private address or a bad link will not improve with another user agent.
      if (/private|not a link|ports|username/.test(error.message)) break;
    }
  }
  // A title on its own is as likely to be "Products" or "Sign in" as the
  // product's name, so it takes a price or a photo to count as found.
  if (!found || (!found.image && found.price === undefined)) {
    throw new FetchError(problem ?? 'No price or photo on that page.');
  }
  return found;
}

export interface Job {
  list: string;
  item: string;
  column: string;
  url: string;
}

type Fetch = (url: string) => Promise<Preview>;

const CACHE_MS = 6 * 3600_000;

export class Lookups {
  private readonly store: Store;
  private readonly limits: Limits;
  private readonly fetch: Fetch;
  private readonly queue: (Job & { done: () => void })[] = [];
  private readonly cache = new Map<string, { at: number; result: Promise<Preview> }>();
  // The box is small and shared: two pages at a time, and a ceiling on how
  // often anyone can make it fetch.
  private readonly perList = new RateLimiter(60, 10 * 60_000);
  private readonly overall = new RateLimiter(400, 60 * 60_000);
  private active = 0;
  private readonly concurrency = 2;

  constructor(store: Store, limits: Limits, fetch: Fetch = fetchPreview) {
    this.store = store;
    this.limits = limits;
    this.fetch = fetch;
  }

  /** Cached for a few hours once it has worked, so a link pasted into five lists is fetched once. */
  preview(url: string): Promise<Preview> {
    const now = Date.now();
    for (const [key, entry] of this.cache) if (now - entry.at > CACHE_MS) this.cache.delete(key);
    const cached = this.cache.get(url);
    if (cached) return cached.result;
    const result = this.fetch(url);
    this.cache.set(url, { at: now, result });
    // Failures are not kept: the next try should really try.
    result.catch(() => {
      if (this.cache.get(url)?.result === result) this.cache.delete(url);
    });
    if (this.cache.size > 500) this.cache.delete(this.cache.keys().next().value!);
    return result;
  }

  /** Queue lookups. Each one has already been marked pending on its row. Resolves when they have all finished. */
  enqueue(jobs: Job[]): Promise<void> {
    return Promise.all(
      jobs.map(
        (job) =>
          new Promise<void>((done) => {
            this.queue.push({ ...job, done });
            this.pump();
          }),
      ),
    ).then(() => undefined);
  }

  /**
   * At startup: lookups that were pending when the server stopped, and links
   * that were never looked up at all, because they were added before lookups
   * existed or while a column had them switched off.
   */
  resume(): void {
    const jobs: Job[] = [];
    for (const id of this.store.ids()) {
      const row = this.store.get(id);
      if (!row) continue;
      const columns = row.doc.columns.filter((c) => c.type === 'url' && c.lookup !== false);
      const unseen = row.doc.items.some((item) =>
        columns.some((c) => typeof item.values[c.id] === 'string' && !item.links?.[c.id]),
      );
      if (unseen) {
        // Marked pending first, so the rows say so while they wait.
        this.store.update(id, (fresh) => {
          const stamp = new Date().toISOString();
          for (const item of fresh.doc.items) {
            for (const c of columns) {
              const url = item.values[c.id];
              if (typeof url === 'string' && !item.links?.[c.id]) (item.links ??= {})[c.id] = { url, status: 'pending', checked_at: stamp };
            }
          }
        });
      }
      for (const item of this.store.get(id)?.doc.items ?? []) {
        for (const [column, info] of Object.entries(item.links ?? {})) {
          if (info.status === 'pending') jobs.push({ list: id, item: item.id, column, url: info.url });
        }
      }
    }
    if (jobs.length) void this.enqueue(jobs);
  }

  private pump(): void {
    while (this.active < this.concurrency && this.queue.length) {
      const job = this.queue.shift()!;
      this.active++;
      void this.run(job).finally(() => {
        this.active--;
        job.done();
        this.pump();
      });
    }
  }

  private async run(job: Job): Promise<void> {
    let preview: Preview | undefined;
    let error: string | undefined;
    const limited = this.perList.blockedFor(job.list) || this.overall.blockedFor('all');
    if (limited) {
      error = 'Too many lookups right now. Try again in a few minutes.';
    } else {
      this.perList.hit(job.list);
      this.overall.hit('all');
      try {
        preview = await this.preview(job.url);
      } catch (e) {
        if (!(e instanceof FetchError)) console.error('Lookup failed:', e);
        error = e instanceof FetchError ? e.message : 'Something went wrong reading that page.';
      }
    }
    this.store.update(job.list, (row) => {
      const item = row.doc.items.find((i) => i.id === job.item);
      const info = item?.links?.[job.column];
      // The link was changed or removed while it was being looked up.
      if (!item || !info || info.url !== job.url || item.values[job.column] !== job.url) return;
      const column = row.doc.columns.find((c) => c.id === job.column);
      if (!column) return;
      if (column.type === 'image') {
        // The cell becomes the picture itself; only a failure is worth keeping with the row.
        if (preview?.image) {
          try {
            item.values[job.column] = coerce(column, preview.image, this.limits, false);
            delete item.links![job.column];
            if (!Object.keys(item.links!).length) delete item.links;
            item.updated_at = new Date().toISOString();
            return;
          } catch {
            error = 'The photo on that page has a link this list cannot hold.';
          }
        }
        item.links![job.column] = { url: job.url, status: 'failed', checked_at: new Date().toISOString(), error: error ?? 'No photo on that page.' };
        return;
      }
      const next: LinkInfo = { url: job.url, status: preview ? 'done' : 'failed', checked_at: new Date().toISOString() };
      if (preview) {
        Object.assign(next, { site: preview.site, title: preview.title, image: preview.image, price: preview.price, currency: preview.currency });
        fillFromLink(row.doc, item, column, preview, this.limits);
        item.updated_at = new Date().toISOString();
      } else {
        next.error = error;
      }
      item.links![job.column] = Object.fromEntries(Object.entries(next).filter(([, v]) => v !== undefined)) as unknown as LinkInfo;
    });
  }
}

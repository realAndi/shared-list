// Reads a product page's name, photo and price out of its HTML. No DOM: the
// things worth having are in a handful of well-known places, and a regex over
// a few hundred KB is cheaper than building a tree on a small server.
//
// In order of trust: schema.org Product data (JSON-LD), Open Graph and product
// meta tags, microdata. Amazon publishes none of those for its price or photo,
// so it gets a reader of its own.

export interface Preview {
  url: string;
  site: string;
  title?: string;
  image?: string;
  price?: number;
  currency?: string;
}

const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', '#39': "'" };

export function decodeEntities(text: string): string {
  return text.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+\d*);/gi, (whole, name: string) => {
    if (name[0] === '#') {
      const code = name[1] === 'x' || name[1] === 'X' ? parseInt(name.slice(2), 16) : parseInt(name.slice(1), 10);
      return Number.isFinite(code) && code > 0 && code < 0x110000 ? String.fromCodePoint(code) : whole;
    }
    return ENTITIES[name.toLowerCase()] ?? whole;
  });
}

function clean(text: string | undefined): string | undefined {
  if (!text) return undefined;
  const value = decodeEntities(text.replace(/<[^>]*>/g, ' '))
    // Temu masks some characters in its product data: "&*;" for an inch mark,
    // a lone "*" for a word it would rather not repeat.
    .replace(/&\*;/g, '"')
    .replace(/(^|\s)\*+(?=\s|$)/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return value || undefined;
}

/**
 * Shop titles are keyword lists. A row's name wants the first phrase of one:
 * cut at the first comma, dash or bar past a reasonable length, else at a word.
 */
function shorten(title: string): string {
  if (title.length <= 70) return title;
  const breakAt = /\s*(?:,|\s[-|–—]\s|\|)\s*/g;
  for (const m of title.matchAll(breakAt)) {
    if (m.index! >= 25 && m.index! <= 90) return title.slice(0, m.index).trim();
  }
  const cut = title.slice(0, 80);
  return `${cut.slice(0, cut.lastIndexOf(' ') > 40 ? cut.lastIndexOf(' ') : 80).trim()}…`;
}

/** Pages a site shows a server instead of the one asked for. */
const WALL = /<title[^>]*>\s*(Robot or human\?|Attention Required!|Just a moment\.\.\.|Access Denied|Robot Check|Pardon Our Interruption|Are you a human\?)|api-services-support@amazon\.com|\/errors\/validateCaptcha|captcha-delivery\.com|px-captcha/i;

export const isBotWall = (html: string) => WALL.test(html.slice(0, 20_000)) || (html.length < 8000 && /captcha/i.test(html));

function attributes(tag: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const m of tag.matchAll(/([a-zA-Z_:.-]+)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+))/g)) {
    out[m[1].toLowerCase()] = m[2] ?? m[3] ?? m[4] ?? '';
  }
  return out;
}

/** <meta> content by property, name or itemprop, first one wins. */
function metaTags(html: string): Map<string, string> {
  const meta = new Map<string, string>();
  for (const [tag] of html.matchAll(/<meta\b[^>]*>/gi)) {
    const a = attributes(tag);
    const key = (a.property ?? a.name ?? a.itemprop)?.toLowerCase();
    if (key && a.content !== undefined && !meta.has(key)) meta.set(key, a.content);
  }
  return meta;
}

/** "1,299.00", "$1299", 1299 → 1299. Anything ambiguous is not a price. */
export function parsePrice(raw: unknown): number | undefined {
  if (typeof raw === 'number') return Number.isFinite(raw) && raw >= 0 ? raw : undefined;
  if (typeof raw !== 'string') return undefined;
  const cleaned = raw.replace(/[^\d.,]/g, '');
  if (!cleaned) return undefined;
  // "1,299.00" and "1299.00" are dollars-style; "1.299,00" is not something to guess at.
  const normalized = /^\d{1,3}(,\d{3})*(\.\d+)?$/.test(cleaned) ? cleaned.replace(/,/g, '') : cleaned;
  if (!/^\d+(\.\d+)?$/.test(normalized)) return undefined;
  const value = Number(normalized);
  return Number.isFinite(value) ? value : undefined;
}

function currencyCode(raw: unknown): string | undefined {
  return typeof raw === 'string' && /^[A-Za-z]{3}$/.test(raw.trim()) ? raw.trim().toUpperCase() : undefined;
}

// --- JSON-LD ------------------------------------------------------------------

type Json = Record<string, unknown>;

function isType(node: Json, wanted: string[]): boolean {
  const type = node['@type'];
  const types = Array.isArray(type) ? type : [type];
  return types.some((t) => typeof t === 'string' && wanted.includes(t.replace(/^.*[/:]/, '')));
}

function products(html: string): Json[] {
  const found: Json[] = [];
  const walk = (node: unknown, depth: number) => {
    if (depth > 6 || !node || typeof node !== 'object') return;
    if (Array.isArray(node)) return node.forEach((n) => walk(n, depth + 1));
    const obj = node as Json;
    if (isType(obj, ['Product', 'ProductGroup', 'IndividualProduct'])) found.push(obj);
    if (obj['@graph']) walk(obj['@graph'], depth + 1);
    if (obj.mainEntity) walk(obj.mainEntity, depth + 1);
  };
  for (const m of html.matchAll(/<script\b[^>]*type\s*=\s*["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi)) {
    try {
      walk(JSON.parse(m[1].trim().replace(/^<!--|-->$/g, '')), 0);
    } catch {
      // A broken block is skipped; others on the page may be fine.
    }
  }
  return found;
}

function firstImage(raw: unknown): string | undefined {
  if (typeof raw === 'string') return raw;
  if (Array.isArray(raw)) return firstImage(raw[0]);
  if (raw && typeof raw === 'object') return firstImage((raw as Json).url ?? (raw as Json).contentUrl);
  return undefined;
}

function offerPrice(raw: unknown): { price?: number; currency?: string } {
  const offers = Array.isArray(raw) ? raw : raw ? [raw] : [];
  for (const offer of offers as Json[]) {
    if (!offer || typeof offer !== 'object') continue;
    const spec = Array.isArray(offer.priceSpecification) ? offer.priceSpecification[0] : offer.priceSpecification;
    const price = parsePrice(offer.price) ?? parsePrice(offer.lowPrice) ?? parsePrice((spec as Json | undefined)?.price);
    if (price !== undefined) {
      return { price, currency: currencyCode(offer.priceCurrency) ?? currencyCode((spec as Json | undefined)?.priceCurrency) };
    }
    if (offer.offers) {
      const nested = offerPrice(offer.offers);
      if (nested.price !== undefined) return nested;
    }
  }
  return {};
}

function fromJsonLd(html: string): Partial<Preview> {
  for (const product of products(html)) {
    let { price, currency } = offerPrice(product.offers);
    if (price === undefined && Array.isArray(product.hasVariant)) {
      for (const variant of product.hasVariant as Json[]) {
        ({ price, currency } = offerPrice(variant?.offers));
        if (price !== undefined) break;
      }
    }
    const image = firstImage(product.image) ?? (Array.isArray(product.hasVariant) ? firstImage((product.hasVariant[0] as Json)?.image) : undefined);
    const title = typeof product.name === 'string' ? product.name : undefined;
    if (title || image || price !== undefined) return { title, image, price, currency };
  }
  return {};
}

// --- meta tags and microdata ---------------------------------------------------

function fromMeta(html: string): Partial<Preview> & { siteName?: string } {
  const meta = metaTags(html);
  const get = (...keys: string[]) => keys.map((k) => meta.get(k)).find((v) => v !== undefined && v.trim() !== '');
  // `price` here is <meta itemprop="price">. Not twitter:data1, which is a price
  // on some shops and a reading time on every blog.
  let price = parsePrice(get('product:price:amount', 'og:price:amount', 'price'));
  let currency = currencyCode(get('product:price:currency', 'og:price:currency', 'pricecurrency'));
  if (price === undefined) {
    // <span itemprop="price" content="12.99">, outside <meta>.
    const tag = /<[a-z]+\b[^>]*itemprop\s*=\s*["']price["'][^>]*>/i.exec(html)?.[0];
    if (tag) price = parsePrice(attributes(tag).content);
    const currencyTag = /<[a-z]+\b[^>]*itemprop\s*=\s*["']priceCurrency["'][^>]*>/i.exec(html)?.[0];
    if (currencyTag) currency ??= currencyCode(attributes(currencyTag).content);
  }
  return {
    title: get('og:title', 'twitter:title') ?? /<title\b[^>]*>([\s\S]*?)<\/title>/i.exec(html)?.[1],
    image: get('og:image:secure_url', 'og:image', 'og:image:url', 'twitter:image', 'twitter:image:src'),
    price,
    currency,
    siteName: get('og:site_name'),
  };
}

// --- Amazon --------------------------------------------------------------------

const AMAZON_CURRENCY: [RegExp, string][] = [
  [/\.co\.uk$/, 'GBP'], [/\.ca$/, 'CAD'], [/\.com\.au$/, 'AUD'], [/\.co\.jp$/, 'JPY'], [/\.in$/, 'INR'],
  [/\.com\.mx$/, 'MXN'], [/\.com\.br$/, 'BRL'], [/\.(de|fr|es|it|nl|ie|be)$/, 'EUR'], [/\.se$/, 'SEK'],
  [/\.pl$/, 'PLN'], [/\.sg$/, 'SGD'], [/\.ae$/, 'AED'], [/\.com$/, 'USD'],
];

export const isAmazon = (host: string) => /(^|\.)amazon\.[a-z.]+$/.test(host) || /(^|\.)(amzn\.to|a\.co|amzn\.com)$/.test(host);

function fromAmazon(html: string, host: string): Partial<Preview> {
  let price = parsePrice(/"priceAmount"\s*:\s*([\d.]+)/.exec(html)?.[1]);
  if (price === undefined) {
    // The buy box, not the "other sellers" prices further down the page.
    const box = /id="(?:corePrice_feature_div|corePriceDisplay_desktop_feature_div|apex_desktop)"/.exec(html);
    if (box) price = parsePrice(/<span class="a-offscreen">([^<]+)</.exec(html.slice(box.index, box.index + 6000))?.[1]);
  }
  const image =
    /"hiRes"\s*:\s*"(https:[^"]+)"/.exec(html)?.[1] ??
    /data-old-hires="(https:[^"]+)"/.exec(html)?.[1] ??
    /"large"\s*:\s*"(https:[^"]+)"/.exec(html)?.[1];
  const title = /id="productTitle"[^>]*>([\s\S]*?)<\/span>/.exec(html)?.[1];
  const currency = AMAZON_CURRENCY.find(([tld]) => tld.test(host))?.[1];
  return { title, image, price, currency };
}

// --- putting it together -------------------------------------------------------

/** Share-preview art that stands for the site, not the thing. */
const GENERIC_IMAGE = /\/share-icons\/|previewdoh|\/logo[^/]*\.(png|svg|jpe?g)$|favicon/i;

function absolute(src: string | undefined, base: string): string | undefined {
  if (!src) return undefined;
  try {
    const url = new URL(decodeEntities(src.trim()), base);
    if (url.protocol !== 'https:' && url.protocol !== 'http:') return undefined;
    if (GENERIC_IMAGE.test(url.pathname)) return undefined;
    return url.href.length <= 2048 ? url.href : undefined;
  } catch {
    return undefined;
  }
}

/** "Sofa | Wayfair", "Amazon.com: Sofa : Home" and "Sofa - Temu" are all just "Sofa". */
function tidyTitle(raw: string | undefined, host: string, siteName?: string): string | undefined {
  let title = clean(raw);
  if (!title) return undefined;
  // Amazon's <title> is "Amazon.com: <name> : <department>".
  const amazonTitle = isAmazon(host) && /^Amazon\.[a-z.]+\s*:/i.test(title);
  const brand = host.replace(/^(www|m|shop)\./, '').split('.')[0];
  const names = [siteName, brand, host.replace(/^www\./, '')].filter(Boolean).map((n) => n!.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
  for (const name of names) {
    title = title.replace(new RegExp(`\\s+[-|–—:]\\s+${name}(\\.[a-z.]+)?\\s*$`, 'i'), '');
    title = title.replace(new RegExp(`^${name}(\\.[a-z.]+)?\\s*[:|]\\s+`, 'i'), '');
  }
  if (amazonTitle) title = title.replace(/\s+:\s+[^:]+$/, '');
  if (!title || title.toLowerCase() === brand.toLowerCase()) return undefined;
  return shorten(title);
}

export function extract(html: string, pageUrl: string): Preview {
  const host = new URL(pageUrl).hostname.toLowerCase();
  const layers = [isAmazon(host) ? fromAmazon(html, host) : {}, fromJsonLd(html), fromMeta(html)];
  const meta = layers[2] as ReturnType<typeof fromMeta>;
  const first = <K extends keyof Preview>(key: K) => layers.map((l) => l[key]).find((v) => v !== undefined && v !== '');

  // A price and its currency come from the same place, never one from each.
  const priced = layers.find((l) => l.price !== undefined);
  // Open Graph images are made to be shown big; JSON-LD ones are often thumbnails.
  const image = [layers[0], layers[2], layers[1]].map((l) => absolute(l.image, pageUrl)).find(Boolean);

  return {
    url: pageUrl,
    site: host.replace(/^www\./, ''),
    title: tidyTitle(first('title') as string | undefined, host, meta.siteName),
    image,
    price: priced?.price !== undefined ? Math.round(priced.price * 100) / 100 : undefined,
    currency: priced?.currency,
  };
}

/** Fills the gaps in `a` from `b`. */
export function merge(a: Preview | undefined, b: Preview): Preview {
  if (!a) return b;
  const priced = a.price !== undefined ? a : b;
  return {
    url: a.url,
    site: a.site,
    title: a.title ?? b.title,
    image: a.image ?? b.image,
    price: priced.price,
    currency: priced.currency,
  };
}

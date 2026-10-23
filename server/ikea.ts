// IKEA answers every server with a 403 for its product pages, but the search
// API behind its own site answers anyone. A product link carries its article
// number, so the product is asked for by that number instead.

import { parsePrice, type Preview } from './extract.ts';
import { FetchError, getPage } from './fetcher.ts';

export const isIkea = (host: string) => /(^|\.)ikea\.com$/.test(host);

export interface IkeaProduct {
  country: string;
  language: string;
  /** Eight digits. A combination's "s" prefix is dropped: the search matches on the digits. */
  number: string;
}

/** The market and article number in a product link, like /us/en/p/kallax-shelf-unit-white-80275887/. */
export function ikeaProduct(link: string): IkeaProduct | undefined {
  let url: URL;
  try {
    url = new URL(link);
  } catch {
    return undefined;
  }
  if (!isIkea(url.hostname.toLowerCase())) return undefined;
  const match = /^\/([a-z]{2})\/([a-z]{2})\/p\/(?:[^/]*-)?s?(\d{8})\/?$/i.exec(url.pathname);
  return match ? { country: match[1].toLowerCase(), language: match[2].toLowerCase(), number: match[3] } : undefined;
}

type Json = Record<string, unknown>;
const isObject = (v: unknown): v is Json => typeof v === 'object' && v !== null && !Array.isArray(v);

/** Every object in the answer that looks like a product: it has an article number and a photo or a price. */
function products(node: unknown, out: Json[] = []): Json[] {
  if (Array.isArray(node)) for (const v of node) products(v, out);
  else if (isObject(node)) {
    if ((typeof node.itemNo === 'string' || typeof node.id === 'string') && (node.mainImageUrl || node.salesPrice)) out.push(node);
    for (const v of Object.values(node)) products(v, out);
  }
  return out;
}

function price(product: Json): { price?: number; currency?: string } {
  const sales = isObject(product.salesPrice) ? product.salesPrice : undefined;
  if (!sales) return {};
  const current = isObject(sales.current) ? sales.current : undefined;
  const amount =
    parsePrice(sales.numeral) ??
    (current && typeof current.wholeNumber === 'string'
      ? parsePrice(`${current.wholeNumber.replace(/\D/g, '')}.${String(current.decimals ?? '0').replace(/\D/g, '') || '0'}`)
      : undefined);
  const currency = typeof sales.currencyCode === 'string' && /^[A-Z]{3}$/.test(sales.currencyCode) ? sales.currencyCode : undefined;
  return { price: amount, currency };
}

/** Reads the product out of a search answer. Only the product with the link's number counts, never a near match. */
export function fromIkeaSearch(answer: unknown, product: IkeaProduct, link: string): Preview | undefined {
  const found = products(answer).find((p) => String(p.itemNo ?? p.id).replace(/\D/g, '') === product.number);
  if (!found) return undefined;
  const name = [found.name, found.typeName].filter((v) => typeof v === 'string' && v.trim()).join(' ').trim();
  const image = typeof found.mainImageUrl === 'string' && /^https:\/\//.test(found.mainImageUrl) ? found.mainImageUrl : undefined;
  const preview: Preview = { url: typeof found.pipUrl === 'string' ? found.pipUrl : link, site: 'ikea.com', ...price(found) };
  if (name) preview.title = name;
  if (image) preview.image = image;
  if (!preview.currency) delete preview.currency;
  if (preview.price === undefined) delete preview.price;
  return preview.image || preview.price !== undefined ? preview : undefined;
}

type GetJson = (url: string) => Promise<unknown>;

const getJson: GetJson = async (url) => {
  const page = await getPage(url, { userAgent: 'SharedListBot/1.0 (+https://github.com/realAndi/shared-list)', json: true });
  if (page.status >= 400) throw new FetchError(`IKEA's product search answered ${page.status}.`);
  try {
    return JSON.parse(page.body);
  } catch {
    throw new FetchError('IKEA answered with something other than product data.');
  }
};

export async function ikeaPreview(link: string, fetchJson: GetJson = getJson): Promise<Preview | undefined> {
  const product = ikeaProduct(link);
  if (!product) return undefined;
  const search = new URL(`https://sik.search.blue.cdtapps.com/${product.country}/${product.language}/search-result-page`);
  search.search = new URLSearchParams({ q: product.number, size: '24', types: 'PRODUCT' }).toString();
  const preview = fromIkeaSearch(await fetchJson(search.href), product, link);
  if (!preview) throw new FetchError(`IKEA's product search has nothing for article ${product.number}.`);
  return preview;
}

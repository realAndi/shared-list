import type { CellValue, Column, Item } from '../../shared/types.ts';

const moneyFormats = new Map<string, Intl.NumberFormat>();

/** Cents only when the column actually has any, so a list of round prices stays uncluttered. */
export function money(value: number, currency = 'USD', cents = true): string {
  const key = `${currency}:${cents}`;
  let format = moneyFormats.get(key);
  if (!format) {
    format = new Intl.NumberFormat(undefined, {
      style: 'currency',
      currency,
      minimumFractionDigits: cents ? 2 : 0,
      maximumFractionDigits: cents ? 2 : 0,
    });
    moneyFormats.set(key, format);
  }
  return format.format(value);
}

export function hasCents(column: Column, items: Item[]): boolean {
  return items.some((i) => {
    const v = i.values[column.id];
    return typeof v === 'number' && !Number.isInteger(v);
  });
}

const numberFormat = new Intl.NumberFormat(undefined, { maximumFractionDigits: 4 });
export const number = (value: number) => numberFormat.format(value);

const dateFormat = new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' });
export const date = (iso: string) => dateFormat.format(new Date(`${iso}T00:00:00Z`));

export function host(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return url;
  }
}

export function ago(iso: string): string {
  const seconds = Math.round((Date.now() - new Date(iso).getTime()) / 1000);
  if (seconds < 45) return 'just now';
  const units: [number, Intl.RelativeTimeFormatUnit][] = [
    [60, 'minute'],
    [3600, 'hour'],
    [86400, 'day'],
    [604800, 'week'],
  ];
  const rtf = new Intl.RelativeTimeFormat(undefined, { numeric: 'auto' });
  let unit: [number, Intl.RelativeTimeFormatUnit] = units[0];
  for (const u of units) if (seconds >= u[0]) unit = u;
  return rtf.format(-Math.round(seconds / unit[0]), unit[1]);
}

/** A value as plain text, for search and sorting. */
export function plain(column: Column, value: CellValue | undefined): string {
  if (value === null || value === undefined) return '';
  if (column.type === 'checkbox') return value ? column.name : '';
  if (column.type === 'url' || column.type === 'image') return host(String(value));
  return String(value);
}

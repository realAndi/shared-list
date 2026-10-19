// The list page: header, tally, and the sheet of rows, which is a table on a
// computer and a stack of ruled entries on a phone. Both are the same DOM,
// restyled by the stylesheet, so a list's custom CSS only has one set of
// selectors to learn.

import { api, ApiError, BASE } from './api.ts';
import { checkbox, display, tag } from './cells.ts';
import { clear, h, icon, storage, toast } from './dom.ts';
import { openItemEditor } from './editor.ts';
import { ago, hasCents, money, plain } from './format.ts';
import { CREATED_KEY } from './landing.ts';
import { renderLock } from './lock.ts';
import { openSettings } from './settings.ts';
import type { CellValue, Column, Item, ListPayload } from '../../shared/types.ts';

const POLL_MS = 8000;
/** While a link is being looked up, its answer is worth fetching sooner. */
const POLL_PENDING_MS = 2000;

/** A column's track: [minimum rem, share of the spare room]. A share of 0 is a fixed width. */
const TRACKS: Record<string, [number, number]> = {
  checkbox: [3.25, 0],
  text: [10, 2],
  number: [6, 0.8],
  currency: [7, 0.9],
  url: [8, 1.1],
  image: [4.75, 0],
  select: [8, 1],
  date: [7.5, 0.9],
};

function track(column: Column): string {
  const [min, share] = TRACKS[column.type];
  const scale = column.width === 'narrow' ? 0.6 : column.width === 'wide' ? 1.6 : 1;
  const rem = Math.round(min * (share ? scale : Math.sqrt(scale)) * 100) / 100;
  return share ? `minmax(${rem}rem, ${share * scale}fr)` : `${rem}rem`;
}

/** Text that is a link and nothing else, the way people paste one. */
const LINK = /^(https?:\/\/\S+|www\.\S+\.\S+|[\w-]+(\.[\w-]+)+\/\S*)$/i;

/** Inline cell editing is for a mouse and a wide screen; touch opens the full form. */
const inlineEditing = matchMedia('(hover: hover) and (pointer: fine) and (min-width: 720px)');

type Sort = { column: string; dir: 1 | -1 } | null;

export function mountList(root: HTMLElement, id: string): void {
  let list: ListPayload;
  let query = '';
  let sort: Sort = null;
  let editing = false;
  let incoming: ListPayload | null = null;
  let poller: number | undefined;

  const sortKey = `sl-sort-${id}`;
  try {
    sort = JSON.parse(storage.get(sortKey) ?? 'null') as Sort;
  } catch {
    sort = null;
  }

  const canEdit = () => list.role !== 'viewer';
  const shown = () => list.columns.filter((c) => !c.hidden);
  const checkColumn = () => list.columns.find((c) => c.type === 'checkbox');
  const primaryColumn = () => shown().find((c) => c.type === 'text') ?? shown().find((c) => c.type !== 'checkbox' && c.type !== 'image');
  const lookingUp = () => list.items.some((i) => Object.values(i.links ?? {}).some((l) => l.status === 'pending'));
  /** Someone's own choice of order wins; otherwise the list's default. */
  const effectiveSort = (): Sort =>
    sort ?? (list.view.sort ? { column: list.view.sort.column, dir: list.view.sort.dir === 'desc' ? -1 : 1 } : null);

  // --- custom CSS ---------------------------------------------------------

  const cssLink = () => document.getElementById('sl-custom-css') as HTMLLinkElement | null;
  let previewSheet: CSSStyleSheet | null = null;

  function applyCss(): void {
    let link = cssLink();
    if (!list.css_rev) {
      link?.remove();
      return;
    }
    const href = `${BASE}api/lists/${encodeURIComponent(list.id)}/style.css?v=${list.css_rev}`;
    if (link?.getAttribute('href') === href) return;
    const next = h('link', { rel: 'stylesheet', id: 'sl-custom-css', href });
    // Swap only once the new sheet has loaded, so a restyle never flashes the default look.
    next.addEventListener('load', () => link?.remove());
    if (link) link.id = '';
    document.head.append(next);
  }

  function preview(css: string | null): void {
    const link = cssLink();
    if (previewSheet) {
      document.adoptedStyleSheets = document.adoptedStyleSheets.filter((s) => s !== previewSheet);
      previewSheet = null;
    }
    if (css === null) {
      if (link) link.disabled = false;
      return;
    }
    if (link) link.disabled = true;
    previewSheet = new CSSStyleSheet();
    try {
      previewSheet.replaceSync(css);
    } catch {
      // Half-typed CSS; the next keystroke tries again.
    }
    document.adoptedStyleSheets = [...document.adoptedStyleSheets, previewSheet];
  }

  async function savedCss(): Promise<string> {
    if (!list.css_rev) return '';
    const res = await fetch(`${BASE}api/lists/${encodeURIComponent(list.id)}/style.css?v=${list.css_rev}`, { credentials: 'same-origin' });
    return res.ok ? res.text() : '';
  }

  // --- data ---------------------------------------------------------------

  function apply(next: ListPayload): void {
    // Never redraw under someone's cursor; their edit lands first, then the update.
    if (editing) {
      incoming = next;
      return;
    }
    const wasLookingUp = list && lookingUp();
    list = next;
    incoming = null;
    render();
    // A new lookup should not wait out the slow poll.
    if (!wasLookingUp && lookingUp()) startPolling();
  }

  async function mutate(work: () => Promise<{ list: ListPayload } | undefined>, done?: string): Promise<void> {
    try {
      const res = await work();
      if (res) apply(res.list);
      if (done) toast(done);
    } catch (error) {
      if (error instanceof ApiError && error.status === 401) return locked();
      toast((error as Error).message, 'error');
      render();
      throw error;
    }
  }

  async function poll(): Promise<void> {
    if (document.visibilityState !== 'visible' || !list) return;
    try {
      const res = await api.get(id, list.version);
      if (res) apply(res.list);
    } catch (error) {
      if (error instanceof ApiError && (error.status === 401 || error.status === 404)) locked();
    }
  }

  function startPolling(): void {
    window.clearTimeout(poller);
    poller = window.setTimeout(async () => {
      await poll();
      startPolling();
    }, list && lookingUp() ? POLL_PENDING_MS : POLL_MS);
  }

  document.addEventListener('visibilitychange', () => void poll());

  function locked(): void {
    window.clearTimeout(poller);
    cssLink()?.remove();
    renderLock(root, id, (opened) => {
      list = opened;
      render();
      startPolling();
    });
  }

  // --- rows ---------------------------------------------------------------

  function compare(column: Column, a: CellValue | undefined, b: CellValue | undefined): number {
    const empty = (v: CellValue | undefined) => v === null || v === undefined || v === '';
    if (empty(a) || empty(b)) return empty(a) === empty(b) ? 0 : empty(a) ? 1 : -1;
    switch (column.type) {
      case 'number':
      case 'currency':
        return Number(a) - Number(b);
      case 'checkbox':
        return Number(a) - Number(b);
      case 'select': {
        const order = (column.options ?? []).map((o) => o.value);
        return order.indexOf(String(a)) - order.indexOf(String(b));
      }
      default:
        return plain(column, a).localeCompare(plain(column, b), undefined, { numeric: true, sensitivity: 'base' });
    }
  }

  function visibleItems(): Item[] {
    let items = list.items;
    const q = query.trim().toLowerCase();
    if (q) items = items.filter((item) => list.columns.some((c) => plain(c, item.values[c.id]).toLowerCase().includes(q)));
    const order = effectiveSort();
    const column = order && list.columns.find((c) => c.id === order.column);
    if (column) {
      const dir = order!.dir;
      // Empty cells stay at the bottom in both directions.
      items = [...items].sort((a, b) => {
        const av = a.values[column.id];
        const bv = b.values[column.id];
        const blank = (v: CellValue | undefined) => v === null || v === undefined || v === '';
        if (blank(av) || blank(bv)) return compare(column, av, bv);
        return compare(column, av, bv) * dir;
      });
    }
    return items;
  }

  function groups(items: Item[]): { key: string; label: Node | string; items: Item[] }[] {
    const column = list.view.group_by ? list.columns.find((c) => c.id === list.view.group_by) : undefined;
    if (!column) return [{ key: '', label: '', items }];
    if (column.type === 'checkbox') {
      return [
        { key: 'open', label: 'Still open', items: items.filter((i) => !i.values[column.id]) },
        { key: 'done', label: column.name, items: items.filter((i) => i.values[column.id]) },
      ].filter((g) => g.items.length);
    }
    const out = (column.options ?? []).map((o) => ({
      key: o.value,
      label: tag(o.value, o.color) as Node | string,
      items: items.filter((i) => i.values[column.id] === o.value),
    }));
    out.push({ key: '', label: `No ${column.name.toLowerCase()}`, items: items.filter((i) => !i.values[column.id]) });
    return out.filter((g) => g.items.length);
  }

  function sum(column: Column, items: Item[]): number {
    return items.reduce((total, i) => total + (typeof i.values[column.id] === 'number' ? (i.values[column.id] as number) : 0), 0);
  }

  // --- inline editing -----------------------------------------------------

  function editCell(cell: HTMLElement, item: Item, column: Column): void {
    if (editing) return;
    editing = true;
    const original = item.values[column.id] ?? null;
    let input: HTMLInputElement | HTMLSelectElement;

    if (column.type === 'select') {
      input = h(
        'select',
        { class: 'sl-cell-input', 'aria-label': column.name },
        h('option', { value: '' }, '—'),
        (column.options ?? []).map((o) => h('option', { value: o.value, selected: o.value === original }, o.value)),
        h('option', { value: '\u0000new' }, 'New option…'),
      );
    } else {
      const kinds: Record<string, Record<string, string>> = {
        number: { type: 'text', inputmode: 'decimal' },
        currency: { type: 'text', inputmode: 'decimal' },
        url: { type: 'url' },
        image: { type: 'url', placeholder: 'Link to a picture' },
        date: { type: 'date' },
      };
      input = h('input', { class: 'sl-cell-input', type: 'text', ...kinds[column.type], 'aria-label': column.name });
      input.value = original === null ? '' : String(original);
    }

    let finished = false;
    const finish = async (save: boolean, then?: () => void) => {
      if (finished) return;
      finished = true;
      let value: string | null = input.value.trim();
      if (value === '\u0000new') value = prompt(`New option for ${column.name}`)?.trim() || null;
      editing = false;
      const changed = save && String(value ?? '') !== String(original ?? '');
      if (changed) {
        // Show the value straight away; the server's answer replaces it.
        await mutate(() => api.updateItem(list.id, item.id, { [column.id]: value || null })).catch(() => undefined);
      } else if (incoming) {
        apply(incoming);
      } else {
        render();
      }
      then?.();
    };

    input.addEventListener('keydown', (event) => {
      const key = (event as KeyboardEvent).key;
      if (key === 'Enter') {
        event.preventDefault();
        void finish(true);
      } else if (key === 'Escape') {
        event.preventDefault();
        void finish(false);
      } else if (key === 'Tab') {
        event.preventDefault();
        const step = (event as KeyboardEvent).shiftKey ? -1 : 1;
        void finish(true, () => focusCell(item.id, column.id, step));
      }
    });
    input.addEventListener('blur', () => void finish(true));
    if (column.type === 'select') input.addEventListener('change', () => void finish(true));

    cell.dataset.editing = '';
    cell.replaceChildren(input);
    input.focus();
    if (input instanceof HTMLInputElement && input.type === 'text') input.select();
  }

  /** After Tab, open the next editable cell along the row. */
  function focusCell(itemId: string, columnId: string, step: number): void {
    const editable = shown().filter((c) => c.type !== 'checkbox');
    const next = editable[editable.findIndex((c) => c.id === columnId) + step];
    const item = list.items.find((i) => i.id === itemId);
    const cell = next && root.querySelector<HTMLElement>(`.sl-row[data-item="${itemId}"] .sl-cell[data-col="${next.id}"]`);
    if (item && next && cell) editCell(cell, item, next);
  }

  function openItem(item?: Item): void {
    openItemEditor({
      list,
      item,
      canEdit: canEdit(),
      onSave: (values) =>
        item
          ? mutate(() => api.updateItem(list.id, item.id, values))
          : mutate(() => api.addItem(list.id, values), 'Item added'),
      onDelete: item ? () => mutate(() => api.removeItem(list.id, item.id), 'Item deleted') : undefined,
      onLookup: item ? () => mutate(() => api.lookup(list.id, item.id), 'Looking it up again') : undefined,
    });
  }

  function toggle(item: Item, column: Column): void {
    const next = !item.values[column.id];
    // Optimistic: a tick should feel instant, even on a slow connection.
    item.values[column.id] = next;
    render();
    void mutate(() => api.updateItem(list.id, item.id, { [column.id]: next })).catch(() => {
      item.values[column.id] = !next;
      render();
    });
  }

  // --- rendering ----------------------------------------------------------

  function row(item: Item, cents: Map<string, boolean>): HTMLElement {
    const check = checkColumn();
    const primary = primaryColumn();
    const el = h('div', {
      class: 'sl-row',
      role: 'row',
      data: { item: item.id, done: Boolean(check && item.values[check.id]) },
    });
    // Choices on hidden columns still label the row; only their cells are left out.
    for (const column of list.columns) {
      const value = item.values[column.id];
      if ((column.type === 'select' || column.type === 'checkbox') && value !== undefined && value !== null) {
        el.setAttribute(`data-col-${column.id}`, String(value));
      }
    }
    for (const column of shown()) {
      const value = item.values[column.id];
      const cell = h('div', {
        class: 'sl-cell',
        role: 'cell',
        data: {
          col: column.id,
          type: column.type,
          label: column.name,
          primary: column === primary,
          empty: value === undefined || value === null || value === '',
          width: column.width,
          lookup: item.links?.[column.id]?.status,
        },
      });
      if (column.type === 'checkbox') {
        cell.append(checkbox(Boolean(value), `${column.name}: ${primaryText(item)}`, canEdit() ? () => toggle(item, column) : undefined));
      } else {
        cell.append(display(column, value, cents.get(column.id) ?? false) ?? h('span', { class: 'sl-blank' }, '—'));
        const lookup = item.links?.[column.id];
        if (lookup?.status === 'pending') {
          cell.append(h('span', { class: 'sl-lookup', role: 'status', data: { state: 'pending' } }, 'Looking up…'));
        } else if (lookup?.status === 'failed' && canEdit()) {
          cell.append(h('span', { class: 'sl-lookup', data: { state: 'failed' }, title: lookup.error ?? '' }, 'No price found'));
        }
        if (canEdit()) {
          cell.addEventListener('click', (event) => {
            if (!inlineEditing.matches) return;
            event.stopPropagation();
            editCell(cell, item, column);
          });
        }
      }
      el.append(cell);
    }
    el.append(
      h('div', { class: 'sl-cell sl-cell--actions', role: 'cell' },
        h('button', {
          type: 'button',
          class: 'sl-icon-button',
          'aria-label': `Open ${primaryText(item) || 'item'}`,
          on: {
            click: (event: MouseEvent) => {
              event.stopPropagation();
              openItem(item);
            },
          },
        }, icon('more')),
      ),
    );
    // On a phone the whole entry is the button; on a computer, cells edit in place.
    el.addEventListener('click', () => {
      if (!inlineEditing.matches || !canEdit()) openItem(item);
    });
    return el;
  }

  function primaryText(item: Item): string {
    const primary = primaryColumn();
    return primary ? plain(primary, item.values[primary.id]) : '';
  }

  function header(): HTMLElement {
    const head = h('div', { class: 'sl-head', role: 'row' });
    const order = effectiveSort();
    for (const column of shown()) {
      const active = order?.column === column.id;
      const button = h('button', {
        type: 'button',
        class: 'sl-sort',
        'aria-label': `Sort by ${column.name}`,
        on: {
          click: () => {
            // Ascending, descending, then back to the list's own order.
            sort = !active ? { column: column.id, dir: 1 } : order!.dir === 1 ? { column: column.id, dir: -1 } : null;
            storage.set(sortKey, sort ? JSON.stringify(sort) : null);
            render();
          },
        },
      }, h('span', {}, column.name), active ? icon(order!.dir === 1 ? 'up' : 'down', 12) : null);
      head.append(
        h('div', {
          class: 'sl-th',
          role: 'columnheader',
          'aria-sort': active ? (order!.dir === 1 ? 'ascending' : 'descending') : 'none',
          data: { col: column.id, type: column.type, width: column.width },
        }, column.type === 'checkbox' ? h('span', { class: 'sl-visually-hidden' }, column.name) : button),
      );
    }
    head.append(h('div', { class: 'sl-th sl-th--actions', role: 'columnheader' }, h('span', { class: 'sl-visually-hidden' }, 'Open')));
    return head;
  }

  function footer(items: Item[], cents: Map<string, boolean>): HTMLElement | null {
    const summed = shown().filter((c) => c.type === 'number' || c.type === 'currency' || c.type === 'checkbox');
    if (!summed.length || !items.length) return null;
    const primary = primaryColumn();
    const foot = h('div', { class: 'sl-foot', role: 'row' });
    for (const column of shown()) {
      let content: Node | string | null = null;
      if (column === primary) content = query ? `Total of ${items.length} shown` : 'Total';
      if (column.type === 'number') content = h('span', { class: 'sl-num' }, String(Number(sum(column, items).toFixed(4))));
      if (column.type === 'currency') content = h('span', { class: 'sl-num' }, money(sum(column, items), column.currency, cents.get(column.id)));
      if (column.type === 'checkbox') content = h('span', { class: 'sl-num' }, `${items.filter((i) => i.values[column.id]).length}/${items.length}`);
      foot.append(h('div', { class: 'sl-cell', role: 'cell', data: { col: column.id, type: column.type, label: column.name, primary: column === primary } }, content));
    }
    foot.append(h('div', { class: 'sl-cell sl-cell--actions', role: 'cell' }));
    return foot;
  }

  function quickAdd(): HTMLElement | null {
    const primary = primaryColumn();
    if (!canEdit() || !primary) return null;
    const linkColumn = list.columns.find((c) => c.type === 'url' && c.lookup !== false);
    const input = h('input', {
      class: 'sl-cell-input',
      placeholder: linkColumn ? `Add ${primary.name.toLowerCase()}, or paste a link…` : `Add ${primary.name.toLowerCase()}…`,
      'aria-label': `Add an item by ${primary.name}`,
    });
    input.addEventListener('keydown', (event) => {
      if (event.key !== 'Enter' || !input.value.trim()) return;
      event.preventDefault();
      const value = input.value.trim();
      input.value = '';
      // A pasted link becomes the row's link, and the lookup names it.
      const values = linkColumn && LINK.test(value) ? { [linkColumn.id]: value } : { [primary.id]: value };
      void mutate(() => api.addItem(list.id, values)).then(() => {
        root.querySelector<HTMLInputElement>('.sl-quick-add input')?.focus();
      });
    });
    return h('form', {
      class: 'sl-quick-add',
      role: 'row',
      on: { submit: (event: SubmitEvent) => event.preventDefault() },
    }, shown().map((c) => h('div', { class: 'sl-cell', data: { col: c.id, primary: c === primary } }, c === primary ? h('span', { class: 'sl-quick-add-field' }, icon('plus', 16), input) : null)), h('div', { class: 'sl-cell sl-cell--actions' }));
  }

  function tally(): HTMLElement | null {
    const check = checkColumn();
    const money_ = list.columns.find((c) => c.type === 'currency');
    const total = list.items.length;
    const parts: (Node | string)[] = [];
    let progress: HTMLElement | null = null;
    if (check && total) {
      const done = list.items.filter((i) => i.values[check.id]).length;
      parts.push(h('span', { class: 'sl-stat' }, h('strong', {}, `${done} of ${total}`), ` ${check.name.toLowerCase()}`));
      progress = h('div', {
        class: 'sl-progress',
        role: 'progressbar',
        'aria-valuemin': '0',
        'aria-valuemax': String(total),
        'aria-valuenow': String(done),
        'aria-label': `${done} of ${total} ${check.name.toLowerCase()}`,
      }, h('div', { class: 'sl-progress-fill' }));
      (progress.firstChild as HTMLElement).style.setProperty('--sl-done', String(done / total));
    } else {
      parts.push(h('span', { class: 'sl-stat' }, h('strong', {}, String(total)), total === 1 ? ' item' : ' items'));
    }
    if (money_ && total) {
      const cents = hasCents(money_, list.items);
      parts.push(h('span', { class: 'sl-stat' }, h('strong', {}, money(sum(money_, list.items), money_.currency, cents)), ' total'));
      if (check) {
        const left = sum(money_, list.items.filter((i) => !i.values[check.id]));
        parts.push(h('span', { class: 'sl-stat' }, h('strong', {}, money(left, money_.currency, cents)), ' left'));
      }
    }
    return h('div', { class: 'sl-tally' }, progress, h('div', { class: 'sl-stats' }, parts));
  }

  async function share(): Promise<void> {
    const url = list.url || location.href;
    if (navigator.share && matchMedia('(pointer: coarse)').matches) {
      try {
        await navigator.share({ title: list.title, url });
        return;
      } catch {
        // Cancelled, or not allowed here; fall back to copying.
      }
    }
    try {
      await navigator.clipboard.writeText(url);
      toast('Link copied. Send the password separately.');
    } catch {
      prompt('Copy this link:', url);
    }
  }

  function render(): void {
    document.body.dataset.page = 'list';
    document.title = `${list.title} · Shared List`;
    applyCss();
    root.dataset.list = list.id;
    root.dataset.role = list.role;

    const searchHadFocus = document.activeElement?.classList.contains('sl-search-input');
    const items = visibleItems();
    const cents = new Map(list.columns.map((c) => [c.id, hasCents(c, list.items)]));

    const search = h('input', {
      class: 'sl-search-input',
      type: 'search',
      placeholder: 'Search this list',
      'aria-label': 'Search this list',
      value: query,
    });
    search.addEventListener('input', () => {
      query = search.value;
      render();
    });

    const table = h('div', { class: 'sl-table', role: 'table', 'aria-label': list.title });
    table.style.setProperty('--sl-columns', [...shown().map(track), '2.75rem'].join(' '));
    table.append(header());
    const body = h('div', { class: 'sl-body', role: 'rowgroup' });
    for (const group of groups(items)) {
      if (group.key || group.label) {
        const money_ = list.columns.find((c) => c.type === 'currency');
        body.append(
          h('div', { class: 'sl-group', role: 'row', data: { group: group.key } },
            h('div', { class: 'sl-group-title', role: 'cell' },
              h('span', { class: 'sl-group-label' }, group.label),
              h('span', { class: 'sl-group-count' }, String(group.items.length)),
              money_ ? h('span', { class: 'sl-group-total' }, money(sum(money_, group.items), money_.currency, cents.get(money_.id))) : null,
            ),
          ),
        );
      }
      for (const item of group.items) body.append(row(item, cents));
    }
    table.append(body);
    if (inlineEditing.matches) table.append(quickAdd() ?? '');
    table.append(footer(items, cents) ?? '');

    let empty: HTMLElement | null = null;
    if (!list.items.length) {
      empty = h('div', { class: 'sl-empty' },
        h('p', {}, 'Nothing on this list yet.'),
        canEdit() ? h('button', { type: 'button', class: 'sl-button sl-button--primary', on: { click: () => openItem() } }, icon('plus', 16), 'Add the first item') : null,
      );
    } else if (!items.length) {
      empty = h('div', { class: 'sl-empty' }, h('p', {}, `No items match “${query.trim()}”.`));
    }

    clear(root);
    root.append(
      h('header', { class: 'sl-topbar' },
        h('a', { class: 'sl-brand', href: BASE }, h('span', { class: 'sl-brand-mark', 'aria-hidden': 'true' }), 'Shared List'),
        h('nav', { class: 'sl-actions', 'aria-label': 'List actions' },
          h('button', { type: 'button', class: 'sl-button sl-button--quiet', on: { click: () => void share() } }, icon('share', 16), h('span', { class: 'sl-label-text' }, 'Share')),
          canEdit()
            ? h('button', {
                type: 'button',
                class: 'sl-button sl-button--quiet',
                on: {
                  click: () =>
                    openSettings({
                      list: () => list,
                      apply: (next) => apply(next),
                      preview,
                      savedCss,
                      onDeleted: () => location.assign(BASE),
                    }),
                },
              }, icon('settings', 16), h('span', { class: 'sl-label-text' }, 'Settings'))
            : null,
          h('button', {
            type: 'button',
            class: 'sl-icon-button',
            'aria-label': 'Lock this list on this device',
            title: 'Lock',
            on: {
              click: async () => {
                await api.lock(list.id).catch(() => undefined);
                locked();
              },
            },
          }, icon('lock', 16)),
        ),
      ),
      h('main', { class: 'sl-main' },
        h('section', { class: 'sl-header' },
          h('h1', { class: 'sl-title' }, list.title),
          list.description ? h('p', { class: 'sl-description' }, list.description) : null,
          h('p', { class: 'sl-meta' },
            `Updated ${ago(list.updated_at)}`,
            list.role === 'viewer' ? h('span', { class: 'sl-badge' }, 'View only') : null,
          ),
          tally(),
        ),
        list.items.length
          ? h('div', { class: 'sl-toolbar' },
              h('label', { class: 'sl-search' }, icon('search', 16), search),
              canEdit() ? h('button', { type: 'button', class: 'sl-button sl-button--primary sl-add', on: { click: () => openItem() } }, icon('plus', 16), 'Add item') : null,
            )
          : null,
        list.items.length ? h('div', { class: 'sl-sheet' }, table) : null,
        empty,
      ),
    );

    if (searchHadFocus) {
      const next = root.querySelector<HTMLInputElement>('.sl-search-input');
      next?.focus();
      next?.setSelectionRange(query.length, query.length);
    }
  }

  // --- start --------------------------------------------------------------

  root.replaceChildren(h('div', { class: 'sl-loading' }, 'Opening list…'));
  void api
    .get(id)
    .then((res) => {
      list = res!.list;
      render();
      startPolling();
      try {
        if (sessionStorage.getItem(CREATED_KEY) === id) {
          sessionStorage.removeItem(CREATED_KEY);
          toast('List created. Share the link, and send the password separately.');
        }
      } catch {
        // Storage blocked; the note is a nicety.
      }
    })
    .catch((error) => {
      if (error instanceof ApiError && error.status === 401) locked();
      else if (error instanceof ApiError && error.status === 404) notFound(root);
      else root.replaceChildren(h('div', { class: 'sl-empty' }, h('p', {}, (error as Error).message)));
    });
}

function notFound(root: HTMLElement): void {
  document.body.dataset.page = 'missing';
  root.replaceChildren(
    h('main', { class: 'sl-gate' },
      h('p', { class: 'sl-eyebrow' }, 'Shared List'),
      h('h1', { class: 'sl-gate-title' }, 'There’s no list here'),
      h('p', { class: 'sl-gate-text' }, 'Check the link with whoever sent it. Lists can be renamed or deleted.'),
      h('a', { class: 'sl-button', href: BASE }, 'Go to Shared List'),
    ),
  );
}


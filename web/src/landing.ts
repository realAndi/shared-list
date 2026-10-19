import { BASE } from './api.ts';
import { checkbox, display } from './cells.ts';
import { h, icon } from './dom.ts';
import { money } from './format.ts';
import type { Column, Item } from '../../shared/types.ts';

const REPO = 'https://github.com/realAndi/shared-list';

const COLUMNS: Column[] = [
  { id: 'got-it', name: 'Got it', type: 'checkbox' },
  { id: 'item', name: 'Item', type: 'text' },
  {
    id: 'room',
    name: 'Room',
    type: 'select',
    options: [
      { value: 'Living room', color: 'green' },
      { value: 'Bedroom', color: 'blue' },
      { value: 'Kitchen', color: 'yellow' },
      { value: 'Bathroom', color: 'teal' },
    ],
  },
  { id: 'price', name: 'Price', type: 'currency', currency: 'USD' },
  { id: 'notes', name: 'Notes', type: 'text' },
];

const ROWS: [boolean, string, string, number, string][] = [
  [true, 'Sofa', 'Living room', 899, 'The green one, not the grey'],
  [false, 'Bed frame', 'Bedroom', 349, 'Queen, low'],
  [true, 'Dining table', 'Kitchen', 420, ''],
  [false, 'Floor lamp', 'Living room', 85, 'Warm bulb'],
  [false, 'Shower curtain', 'Bathroom', 24, ''],
];

/** The example is a real list, drawn by the same cells and the same stylesheet, that only lives in this tab. */
function example(): HTMLElement {
  const items: Item[] = ROWS.map(([got, item, room, price, notes], i) => ({
    id: `demo${i}`,
    values: { 'got-it': got, item, room, price, ...(notes ? { notes } : {}) },
    created_at: '',
    updated_at: '',
  }));

  const card = h('div', { class: 'sl-example', data: { page: 'list' } });

  const render = () => {
    const done = items.filter((i) => i.values['got-it']).length;
    const total = items.reduce((t, i) => t + (i.values.price as number), 0);
    const left = items.filter((i) => !i.values['got-it']).reduce((t, i) => t + (i.values.price as number), 0);

    const table = h('div', { class: 'sl-table', role: 'table', 'aria-label': 'Example list: apartment furniture' });
    table.style.setProperty('--sl-columns', '3.25rem minmax(9rem, 2fr) minmax(8rem, 1fr) minmax(6rem, 0.8fr) minmax(10rem, 2fr)');
    table.append(
      h('div', { class: 'sl-head', role: 'row' },
        COLUMNS.map((c) =>
          h('div', { class: 'sl-th', role: 'columnheader', data: { col: c.id, type: c.type } },
            c.type === 'checkbox' ? h('span', { class: 'sl-visually-hidden' }, c.name) : h('span', { class: 'sl-sort' }, c.name),
          ),
        ),
      ),
      h('div', { class: 'sl-body', role: 'rowgroup' },
        items.map((item) =>
          h('div', { class: 'sl-row', role: 'row', data: { item: item.id, done: Boolean(item.values['got-it']) } },
            COLUMNS.map((c) =>
              h('div', {
                class: 'sl-cell',
                role: 'cell',
                data: { col: c.id, type: c.type, label: c.name, primary: c.id === 'item', empty: item.values[c.id] === undefined },
              },
                c.type === 'checkbox'
                  ? checkbox(Boolean(item.values[c.id]), `Got it: ${item.values.item}`, () => {
                      item.values['got-it'] = !item.values['got-it'];
                      render();
                    })
                  : display(c, item.values[c.id], false) ?? h('span', { class: 'sl-blank' }, '—'),
              ),
            ),
          ),
        ),
      ),
    );

    card.replaceChildren(
      h('div', { class: 'sl-example-head' },
        h('p', { class: 'sl-example-title' }, 'Apartment furniture'),
        h('div', { class: 'sl-tally' },
          h('div', { class: 'sl-progress', role: 'progressbar', 'aria-valuemin': '0', 'aria-valuemax': String(items.length), 'aria-valuenow': String(done), 'aria-label': `${done} of ${items.length} got it` },
            (() => {
              const fill = h('div', { class: 'sl-progress-fill' });
              fill.style.setProperty('--sl-done', String(done / items.length));
              return fill;
            })(),
          ),
          h('div', { class: 'sl-stats' },
            h('span', { class: 'sl-stat' }, h('strong', {}, `${done} of ${items.length}`), ' got it'),
            h('span', { class: 'sl-stat' }, h('strong', {}, money(total, 'USD', false)), ' total'),
            h('span', { class: 'sl-stat' }, h('strong', {}, money(left, 'USD', false)), ' left'),
          ),
        ),
      ),
      h('div', { class: 'sl-sheet' }, table),
    );
  };

  render();
  return card;
}

export function renderLanding(root: HTMLElement): void {
  document.body.dataset.page = 'landing';
  const mcpUrl = `${location.origin}${BASE}mcp`;

  const open = h('input', { class: 'sl-input', id: 'sl-open', placeholder: 'Paste a link or list ID', autocomplete: 'off', autocapitalize: 'off', spellcheck: false });
  const openForm = h('form', { class: 'sl-open-form' },
    h('label', { class: 'sl-label', for: 'sl-open' }, 'Have a link?'),
    h('div', { class: 'sl-row-inline' }, open, h('button', { type: 'submit', class: 'sl-button sl-button--primary' }, 'Open')),
  );
  openForm.addEventListener('submit', (event) => {
    event.preventDefault();
    const raw = open.value.trim();
    const id = (raw.split('/').filter(Boolean).pop() ?? '').split(/[?#]/)[0].toLowerCase();
    if (id) location.assign(BASE + encodeURIComponent(id));
  });

  root.replaceChildren(
    h('header', { class: 'sl-topbar' },
      h('a', { class: 'sl-brand', href: BASE }, h('span', { class: 'sl-brand-mark', 'aria-hidden': 'true' }), 'Shared List'),
      h('nav', { class: 'sl-actions', 'aria-label': 'Project' },
        h('a', { class: 'sl-button sl-button--quiet', href: REPO }, 'Source', icon('out', 14)),
      ),
    ),
    h('main', { class: 'sl-main sl-landing' },
      h('section', { class: 'sl-hero' },
        h('h1', { class: 'sl-title sl-hero-title' }, 'Shared List'),
        h('p', { class: 'sl-lead' }, 'Make a list, lock it with a password, and send the link. Everyone with both can see it and edit it, from a phone or a laptop.'),
      ),
      h('figure', { class: 'sl-figure' },
        example(),
        h('figcaption', { class: 'sl-caption' }, 'An example list. Tick a row.'),
      ),
      h('section', { class: 'sl-points' },
        h('div', { class: 'sl-point' },
          openForm,
        ),
        h('div', { class: 'sl-point' },
          h('h2', { class: 'sl-point-title' }, 'Agents can use it too'),
          h('p', {}, 'Shared List is an MCP server. Connect an AI assistant and it can make lists, fill them in, and restyle them with CSS.'),
          h('pre', { class: 'sl-code-block' }, `claude mcp add --transport http shared-list \\\n  ${mcpUrl} \\\n  --header "Authorization: Bearer <admin token>"`),
        ),
        h('div', { class: 'sl-point' },
          h('h2', { class: 'sl-point-title' }, 'Every list can look its own way'),
          h('p', {}, 'Each list carries its own CSS. Change its colors and type from the list’s settings, or ask an agent to.'),
        ),
        h('div', { class: 'sl-point' },
          h('h2', { class: 'sl-point-title' }, 'Run your own'),
          h('p', {}, 'One small Node server and one SQLite file. MIT licensed. ', h('a', { href: REPO }, 'Setup on GitHub'), '.'),
        ),
      ),
    ),
    h('footer', { class: 'sl-footer' },
      h('a', { href: `${BASE}admin` }, 'Admin'),
      h('a', { href: REPO }, 'GitHub'),
    ),
  );
}

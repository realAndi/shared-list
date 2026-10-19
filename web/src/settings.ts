// The settings dialog: the list's details, its columns, its CSS, and its
// password. Anyone who can edit the list can change all of them.

import { api } from './api.ts';
import { tag } from './cells.ts';
import { openDialog } from './dialog.ts';
import { clear, h, icon, toast } from './dom.ts';
import { STYLE_GUIDE } from '../../shared/styleguide.ts';
import { COLUMN_TYPES, TAG_COLORS, type Column, type ListPayload } from '../../shared/types.ts';

const TYPE_LABELS: Record<string, string> = {
  text: 'Text',
  number: 'Number',
  currency: 'Money',
  url: 'Link',
  image: 'Image',
  checkbox: 'Checkbox',
  select: 'Choice',
  date: 'Date',
};

export interface SettingsHost {
  list(): ListPayload;
  apply(list: ListPayload): void;
  /** Swap the saved custom CSS for a preview, or pass null to go back to the saved one. */
  preview(css: string | null): void;
  savedCss(): Promise<string>;
  onDeleted(): void;
}

async function attempt(work: () => Promise<unknown>, done?: string): Promise<boolean> {
  try {
    await work();
    if (done) toast(done);
    return true;
  } catch (error) {
    toast((error as Error).message, 'error');
    return false;
  }
}

function typeSelect(value: string): HTMLSelectElement {
  return h('select', { class: 'sl-input sl-input--small' }, COLUMN_TYPES.map((t) => h('option', { value: t, selected: t === value }, TYPE_LABELS[t])));
}

function detailsTab(host: SettingsHost): HTMLElement {
  const list = host.list();
  const title = h('input', { class: 'sl-input', id: 'sl-set-title', value: list.title, maxlength: '120' });
  const description = h('textarea', { class: 'sl-input', id: 'sl-set-description', rows: 3, maxlength: '2000' });
  description.value = list.description;
  const groupable = list.columns.filter((c) => c.type === 'select' || c.type === 'checkbox');
  const group = h(
    'select',
    { class: 'sl-input', id: 'sl-set-group' },
    h('option', { value: '' }, 'Don’t group'),
    groupable.map((c) => h('option', { value: c.id, selected: list.view.group_by === c.id }, c.name)),
  );
  const sortable = list.columns.filter((c) => c.type !== 'image');
  const sortBy = h(
    'select',
    { class: 'sl-input', id: 'sl-set-sort' },
    h('option', { value: '' }, 'The order rows were added'),
    sortable.map((c) => h('option', { value: c.id, selected: list.view.sort?.column === c.id }, c.name)),
  );
  const sortDir = h(
    'select',
    { class: 'sl-input sl-sort-dir', 'aria-label': 'Sort direction' },
    h('option', { value: 'asc', selected: list.view.sort?.dir !== 'desc' }, 'A → Z, low → high'),
    h('option', { value: 'desc', selected: list.view.sort?.dir === 'desc' }, 'Z → A, high → low'),
  );
  const form = h(
    'form',
    { class: 'sl-form' },
    h('div', { class: 'sl-field' }, h('label', { class: 'sl-label', for: 'sl-set-title' }, 'Title'), title),
    h('div', { class: 'sl-field' }, h('label', { class: 'sl-label', for: 'sl-set-description' }, 'Description'), description),
    h(
      'div',
      { class: 'sl-field' },
      h('label', { class: 'sl-label', for: 'sl-set-group' }, 'Group rows by'),
      group,
      groupable.length ? null : h('p', { class: 'sl-hint' }, 'Add a Choice or Checkbox column to group rows by it.'),
    ),
    h(
      'div',
      { class: 'sl-field' },
      h('label', { class: 'sl-label', for: 'sl-set-sort' }, 'Sort rows by'),
      h('div', { class: 'sl-row-inline' }, sortBy, sortDir),
      h('p', { class: 'sl-hint' }, 'Everyone sees this order until they click a column heading to pick their own.'),
    ),
    h('div', { class: 'sl-dialog-actions' }, h('span', { class: 'sl-spacer' }), h('button', { type: 'submit', class: 'sl-button sl-button--primary' }, 'Save details')),
  );
  form.addEventListener('submit', (event) => {
    event.preventDefault();
    void attempt(async () => {
      const res = await api.update(list.id, {
        title: title.value,
        description: description.value,
        group_by: group.value || null,
        sort_by: sortBy.value || null,
        sort_dir: sortDir.value,
      });
      host.apply(res!.list);
    }, 'Details saved');
  });
  return form;
}

function optionsEditor(host: SettingsHost, column: Column): HTMLElement {
  const box = h('div', { class: 'sl-options' });
  const save = (options: OptionEdit[]) =>
    attempt(async () => {
      const res = await api.updateColumn(host.list().id, column.id, { options });
      host.apply(res!.list);
    });

  type OptionEdit = { value: string; color?: string; from?: string };
  const current = (): OptionEdit[] => (column.options ?? []).map((o) => ({ value: o.value, color: o.color }));
  for (const [index, option] of (column.options ?? []).entries()) {
    const name = h('input', { class: 'sl-input sl-input--small', value: option.value, 'aria-label': 'Option name' });
    const color = h(
      'select',
      { class: 'sl-input sl-input--small sl-color', 'aria-label': 'Option color', data: { color: option.color } },
      TAG_COLORS.map((c) => h('option', { value: c, selected: c === option.color }, c)),
    );
    name.addEventListener('change', () => {
      const next = current();
      next[index] = { value: name.value, color: option.color, from: option.value };
      void save(next);
    });
    color.addEventListener('change', () => {
      const next = current();
      next[index].color = color.value;
      void save(next);
    });
    box.append(
      h('div', { class: 'sl-option-row' },
        tag(option.value, option.color),
        name,
        color,
        h('button', {
          type: 'button',
          class: 'sl-icon-button',
          'aria-label': `Remove option ${option.value}`,
          on: {
            click: () => {
              if (!confirm(`Remove “${option.value}”? Rows with it will be left empty.`)) return;
              void save(current().filter((_, i) => i !== index));
            },
          },
        }, icon('x', 16)),
      ),
    );
  }
  const fresh = h('input', { class: 'sl-input sl-input--small', placeholder: 'Add an option', 'aria-label': `Add an option to ${column.name}` });
  fresh.addEventListener('keydown', (event) => {
    if (event.key !== 'Enter') return;
    event.preventDefault();
    // No color: the server gives a new option the next one in its cycle.
    if (fresh.value.trim()) void save([...current(), { value: fresh.value.trim() }]);
  });
  box.append(fresh);
  return box;
}

function columnsTab(host: SettingsHost): HTMLElement {
  const wrap = h('div', { class: 'sl-columns-editor' });

  const render = () => {
    clear(wrap);
    const list = host.list();
    list.columns.forEach((column, index) => {
      const name = h('input', { class: 'sl-input sl-input--small', value: column.name, 'aria-label': 'Column name' });
      name.addEventListener('change', () =>
        void attempt(async () => {
          host.apply((await api.updateColumn(list.id, column.id, { name: name.value }))!.list);
          render();
        }),
      );
      const type = typeSelect(column.type);
      type.addEventListener('change', () => {
        const filled = list.items.filter((i) => i.values[column.id] !== undefined).length;
        if (filled && !confirm(`Change “${column.name}” to ${TYPE_LABELS[type.value]}? Values that don’t fit the new type are cleared.`)) {
          type.value = column.type;
          return;
        }
        void attempt(async () => {
          const res = await api.updateColumn(list.id, column.id, { type: type.value });
          host.apply(res!.list);
          if (res!.cleared) toast(`${res!.cleared} value${res!.cleared === 1 ? '' : 's'} didn’t fit and ${res!.cleared === 1 ? 'was' : 'were'} cleared`);
          render();
        });
      });
      const move = (to: number) =>
        void attempt(async () => {
          host.apply((await api.updateColumn(list.id, column.id, { position: to }))!.list);
          render();
        });
      wrap.append(
        h(
          'div',
          { class: 'sl-column-row', data: { col: column.id } },
          h('div', { class: 'sl-column-main' },
            name,
            type,
            h('button', { type: 'button', class: 'sl-icon-button', 'aria-label': `Move ${column.name} left`, disabled: index === 0, on: { click: () => move(index - 1) } }, icon('up', 16)),
            h('button', { type: 'button', class: 'sl-icon-button', 'aria-label': `Move ${column.name} right`, disabled: index === list.columns.length - 1, on: { click: () => move(index + 1) } }, icon('down', 16)),
            h('button', {
              type: 'button',
              class: 'sl-icon-button sl-icon-button--danger',
              'aria-label': `Delete column ${column.name}`,
              disabled: list.columns.length === 1,
              on: {
                click: () => {
                  if (!confirm(`Delete the “${column.name}” column and everything in it?`)) return;
                  void attempt(async () => {
                    host.apply((await api.removeColumn(list.id, column.id))!.list);
                    render();
                  }, 'Column deleted');
                },
              },
            }, icon('trash', 16)),
          ),
          column.type === 'select' ? optionsEditor({ ...host, apply: (l) => { host.apply(l); render(); } }, column) : null,
          column.type === 'currency'
            ? (() => {
                const currency = h('input', { class: 'sl-input sl-input--small sl-currency', value: column.currency ?? 'USD', maxlength: '3', 'aria-label': 'Currency code' });
                currency.addEventListener('change', () =>
                  void attempt(async () => host.apply((await api.updateColumn(list.id, column.id, { currency: currency.value }))!.list)),
                );
                return h('label', { class: 'sl-inline-field' }, 'Currency', currency);
              })()
            : null,
          columnLook(host, column, render),
        ),
      );
    });

    const newName = h('input', { class: 'sl-input sl-input--small', placeholder: 'New column', 'aria-label': 'New column name' });
    const newType = typeSelect('text');
    const add = h('form', { class: 'sl-column-row sl-column-row--new' },
      h('div', { class: 'sl-column-main' }, newName, newType, h('button', { type: 'submit', class: 'sl-button' }, icon('plus', 16), 'Add column')),
    );
    add.addEventListener('submit', (event) => {
      event.preventDefault();
      if (!newName.value.trim()) return;
      void attempt(async () => {
        host.apply((await api.addColumn(list.id, { name: newName.value, type: newType.value }))!.list);
        render();
      }, 'Column added');
    });
    wrap.append(add);
  };

  render();
  return wrap;
}

function styleTab(host: SettingsHost): HTMLElement {
  const area = h('textarea', {
    class: 'sl-input sl-code',
    id: 'sl-set-css',
    rows: 14,
    spellcheck: false,
    autocapitalize: 'off',
    placeholder: ':root {\n  --sl-accent: #2f6fde;\n  --sl-paper: #f4f8ff;\n}',
  });
  void host.savedCss().then((css) => (area.value = css));
  let timer: number | undefined;
  area.addEventListener('input', () => {
    window.clearTimeout(timer);
    timer = window.setTimeout(() => host.preview(area.value), 250);
  });
  const save = h('button', { type: 'submit', class: 'sl-button sl-button--primary' }, 'Save style');
  const form = h(
    'form',
    { class: 'sl-form' },
    h('div', { class: 'sl-field' },
      h('label', { class: 'sl-label', for: 'sl-set-css' }, 'Custom CSS'),
      area,
      h('p', { class: 'sl-hint' }, 'Changes preview as you type. Everyone with the link sees the saved style.'),
    ),
    h('details', { class: 'sl-guide' }, h('summary', {}, 'Class names and variables'), h('pre', {}, STYLE_GUIDE)),
    h('div', { class: 'sl-dialog-actions' },
      h('button', {
        type: 'button',
        class: 'sl-button',
        on: {
          click: () => {
            area.value = '';
            host.preview('');
          },
        },
      }, 'Clear'),
      h('span', { class: 'sl-spacer' }),
      save,
    ),
  );
  form.addEventListener('submit', (event) => {
    event.preventDefault();
    save.disabled = true;
    void attempt(async () => {
      host.apply((await api.setCss(host.list().id, area.value))!.list);
      host.preview(null);
    }, 'Style saved').then(() => (save.disabled = false));
  });
  return form;
}

function accessTab(host: SettingsHost): HTMLElement {
  const list = host.list();
  const password = h('input', {
    class: 'sl-input',
    id: 'sl-set-password',
    type: 'text',
    minlength: '4',
    autocomplete: 'off',
    autocapitalize: 'off',
    spellcheck: false,
  });
  const form = h(
    'form',
    { class: 'sl-form' },
    h('div', { class: 'sl-field' },
      h('label', { class: 'sl-label', for: 'sl-set-password' }, 'New password'),
      h('div', { class: 'sl-row-inline' }, password, h('button', { type: 'submit', class: 'sl-button' }, 'Change password')),
      h('p', { class: 'sl-hint' }, 'You stay in. Everyone else who has the list open is signed out until they enter the new one.'),
    ),
    h('div', { class: 'sl-danger-zone' },
      h('div', {}, h('strong', {}, 'Delete this list'), h('p', { class: 'sl-hint' }, 'Its items and style are gone for good, and the link stops working.')),
      h('button', {
        type: 'button',
        class: 'sl-button sl-button--danger',
        on: {
          click: () => {
            if (prompt(`Type the list id (${list.id}) to delete it.`) !== list.id) return;
            void attempt(async () => {
              await api.remove(list.id);
              host.onDeleted();
            });
          },
        },
      }, icon('trash', 16), 'Delete list'),
    ),
  );
  form.addEventListener('submit', (event) => {
    event.preventDefault();
    void attempt(async () => {
      host.apply((await api.update(list.id, { password: password.value }))!.list);
      password.value = '';
    }, 'Password changed');
  });
  return form;
}

export function openSettings(host: SettingsHost): void {
  const tabs: [string, (host: SettingsHost) => HTMLElement][] = [
    ['Details', detailsTab],
    ['Columns', columnsTab],
    ['Style', styleTab],
    ['Password', accessTab],
  ];

  const panel = h('div', { class: 'sl-tab-panel', role: 'tabpanel' });
  const buttons = tabs.map(([label, build], index) => {
    const button = h('button', {
      type: 'button',
      role: 'tab',
      class: 'sl-tab',
      'aria-selected': String(index === 0),
      on: {
        click: () => {
          buttons.forEach((b) => b.setAttribute('aria-selected', String(b === button)));
          panel.replaceChildren(build(host));
        },
      },
    }, label);
    return button;
  });
  panel.append(tabs[0][1](host));

  openDialog('List settings', h('div', { class: 'sl-settings' }, h('div', { class: 'sl-tabs', role: 'tablist' }, buttons), panel), {
    className: 'sl-dialog--settings',
    onClose: () => host.preview(null),
  });
}

/** Width, hiding, and for link columns whether to look pages up. */
function columnLook(host: SettingsHost, column: Column, rerender: () => void): HTMLElement {
  const list = host.list();
  const save = (patch: Record<string, unknown>, done?: string) =>
    void attempt(async () => {
      host.apply((await api.updateColumn(list.id, column.id, patch))!.list);
      rerender();
    }, done);

  const width = h(
    'select',
    { class: 'sl-input sl-input--small', 'aria-label': `Width of ${column.name}` },
    (['narrow', 'normal', 'wide'] as const).map((w) =>
      h('option', { value: w, selected: (column.width ?? 'normal') === w }, w[0].toUpperCase() + w.slice(1)),
    ),
  );
  width.addEventListener('change', () => save({ width: width.value }));

  const hidden = h('input', { type: 'checkbox', checked: Boolean(column.hidden) });
  hidden.addEventListener('change', () => save({ hidden: hidden.checked }, hidden.checked ? `${column.name} is hidden from the table` : undefined));

  let lookup: HTMLElement | null = null;
  if (column.type === 'url') {
    const box = h('input', { type: 'checkbox', checked: column.lookup !== false });
    box.addEventListener('change', () => save({ lookup: box.checked }));
    lookup = h('label', { class: 'sl-check-field' }, box, 'Fill in price, photo and name from the link');
  }

  return h('div', { class: 'sl-column-look' },
    h('label', { class: 'sl-inline-field' }, 'Width', width),
    h('label', { class: 'sl-check-field' }, hidden, 'Hide from the table'),
    lookup,
  );
}

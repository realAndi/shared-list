// The full form for one item: how rows are added and edited on a phone, and
// the "open" view of a row on a computer.

import { display, tag } from './cells.ts';
import { openDialog } from './dialog.ts';
import { h, icon } from './dom.ts';
import { money } from './format.ts';
import { pictureIn, uploadImage } from './images.ts';
import type { CellValue, Column, Item, LinkInfo, ListPayload } from '../../shared/types.ts';

interface EditorOptions {
  list: ListPayload;
  item?: Item;
  canEdit: boolean;
  onSave(values: Record<string, CellValue>): Promise<void>;
  onDelete?(): Promise<void>;
  /** Look the row's links up again. */
  onLookup?(): Promise<void>;
  /** Add an image column, so photos found on linked pages have somewhere to go. */
  onAddPhotoColumn?(): Promise<void>;
}

/** What the last lookup of a link said, under its field. */
function linkStatus(info: LinkInfo, column: Column, retry?: () => void): HTMLElement {
  let text: string;
  if (info.status === 'pending') text = column.type === 'image' ? 'Finding the photo on that page…' : 'Looking up the price and photo…';
  else if (info.status === 'failed') text = `Couldn’t read this page. ${info.error ?? ''}`.trim();
  else {
    const found = [info.price !== undefined ? (info.currency ? money(info.price, info.currency) : String(info.price)) : null, info.image ? 'a photo' : null]
      .filter(Boolean)
      .join(' and ');
    text = found ? `Found ${found} on ${info.site ?? 'the page'}.` : `Read ${info.site ?? 'the page'}.`;
  }
  return h('p', { class: 'sl-hint sl-link-status', data: { state: info.status } },
    text,
    retry && info.status !== 'pending'
      ? h('button', { type: 'button', class: 'sl-text-button', on: { click: retry } }, 'Look up again')
      : null,
  );
}

type Reader = () => CellValue;

function autoGrow(area: HTMLTextAreaElement): void {
  const fit = () => {
    area.style.height = 'auto';
    area.style.height = `${area.scrollHeight}px`;
  };
  area.addEventListener('input', fit);
  requestAnimationFrame(fit);
}

function field(column: Column, value: CellValue | undefined, listId: string): { control: HTMLElement; read: Reader } {
  const id = `sl-field-${column.id}`;
  switch (column.type) {
    case 'checkbox': {
      const input = h('input', { type: 'checkbox', id, class: 'sl-switch-input', checked: value === true });
      return {
        control: h('label', { class: 'sl-switch', for: id }, input, h('span', { class: 'sl-switch-track' }), h('span', {}, column.name)),
        read: () => input.checked,
      };
    }
    case 'select': {
      const name = `sl-opt-${column.id}`;
      const choices = [{ value: '', label: 'None' }, ...(column.options ?? []).map((o) => ({ value: o.value, label: o.value }))];
      const other = h('input', { type: 'text', class: 'sl-input sl-input--small', placeholder: 'New option', 'aria-label': `New ${column.name} option` });
      const group = h(
        'div',
        { class: 'sl-choices', role: 'radiogroup', 'aria-labelledby': `${id}-label` },
        choices.map((choice) =>
          h(
            'label',
            { class: 'sl-choice' },
            h('input', { type: 'radio', name, value: choice.value, checked: (value ?? '') === choice.value }),
            choice.value
              ? tag(choice.label, column.options!.find((o) => o.value === choice.value)!.color)
              : h('span', { class: 'sl-tag sl-tag--none' }, choice.label),
          ),
        ),
        other,
      );
      other.addEventListener('input', () => {
        if (other.value.trim()) group.querySelectorAll<HTMLInputElement>(`input[name="${name}"]`).forEach((r) => (r.checked = false));
      });
      return {
        control: group,
        read: () => other.value.trim() || group.querySelector<HTMLInputElement>(`input[name="${name}"]:checked`)?.value || null,
      };
    }
    case 'text': {
      const area = h('textarea', { id, class: 'sl-input', rows: 1 });
      area.value = typeof value === 'string' ? value : '';
      autoGrow(area);
      return { control: area, read: () => area.value };
    }
    case 'image': {
      // A path, not a URL, once a picture has been uploaded, so the input is plain text.
      const input = h('input', { id, class: 'sl-input', type: 'text', inputmode: 'url', placeholder: 'Link to a picture or a shop page', value: String(value ?? '') });
      const preview = h('div', { class: 'sl-preview' });
      const status = h('p', { class: 'sl-hint', role: 'status' });
      const show = () => {
        preview.replaceChildren();
        if (/^(https?:\/\/|api\/)/.test(input.value)) preview.append(display(column, input.value, false) ?? '');
      };
      const file = h('input', { type: 'file', accept: 'image/*', class: 'sl-visually-hidden', tabindex: -1, 'aria-hidden': 'true' });
      const choose = h('button', { type: 'button', class: 'sl-button sl-button--small', on: { click: () => file.click() } }, icon('image', 16), 'Upload photo');
      const upload = async (picture: File) => {
        choose.disabled = true;
        status.textContent = 'Uploading…';
        try {
          input.value = await uploadImage(listId, picture);
          status.textContent = '';
          show();
        } catch (e) {
          status.textContent = (e as Error).message;
        } finally {
          choose.disabled = false;
          file.value = '';
        }
      };
      file.addEventListener('change', () => file.files?.[0] && void upload(file.files[0]));
      input.addEventListener('paste', (event) => {
        const picture = pictureIn(event.clipboardData);
        if (!picture) return;
        event.preventDefault();
        void upload(picture);
      });
      input.addEventListener('change', show);
      show();
      return {
        control: h('div', { class: 'sl-field-stack' }, input, h('div', { class: 'sl-upload' }, choose, file, status), preview),
        read: () => input.value.trim(),
      };
    }
    default: {
      const kinds: Record<string, Record<string, string>> = {
        number: { type: 'text', inputmode: 'decimal' },
        currency: { type: 'text', inputmode: 'decimal', placeholder: column.currency ?? 'USD' },
        url: { type: 'url', inputmode: 'url', placeholder: 'https://' },
        date: { type: 'date' },
      };
      const input = h('input', { id, class: 'sl-input', ...kinds[column.type], value: value === null || value === undefined ? '' : String(value) });
      return { control: input, read: () => input.value.trim() };
    }
  }
}

export function openItemEditor({ list, item, canEdit, onSave, onDelete, onLookup, onAddPhotoColumn }: EditorOptions): void {
  const readers = new Map<string, Reader>();
  const form = h('form', { class: 'sl-form', novalidate: true });

  for (const column of list.columns) {
    const value = item?.values[column.id];
    if (!canEdit) {
      const shown = column.type === 'checkbox' ? (value ? 'Yes' : 'No') : display(column, value, true);
      form.append(
        h('div', { class: 'sl-field', data: { col: column.id, type: column.type } },
          h('span', { class: 'sl-label' }, column.name),
          h('div', { class: 'sl-field-value' }, shown ?? h('span', { class: 'sl-faint' }, '—')),
        ),
      );
      continue;
    }
    const { control, read } = field(column, value, list.id);
    readers.set(column.id, read);
    const info = item?.links?.[column.id];
    form.append(
      h('div', { class: 'sl-field', data: { col: column.id, type: column.type } },
        column.type === 'checkbox' ? null : h('label', { class: 'sl-label', id: `sl-field-${column.id}-label`, for: `sl-field-${column.id}` }, column.name),
        control,
        info && info.url === value
          ? linkStatus(info, column, onLookup ? () => void onLookup().then(() => dialog.close()) : undefined)
          : column.type === 'url' && column.lookup !== false
            ? item && typeof value === 'string' && onLookup
              ? h('p', { class: 'sl-hint sl-link-status' },
                  'This link hasn’t been looked up.',
                  h('button', { type: 'button', class: 'sl-text-button', on: { click: () => void onLookup().then(() => dialog.close()) } }, 'Fill in price and photo'),
                )
              : !item
                ? h('p', { class: 'sl-hint' }, 'Paste a shop link and the price, photo and name fill in by themselves.')
                : null
            : null,
        // The page had a photo, but the list has nowhere to show it.
        info?.image && column.type === 'url' && onAddPhotoColumn && !list.columns.some((c) => c.type === 'image')
          ? h('p', { class: 'sl-hint' },
              h('button', { type: 'button', class: 'sl-text-button', on: { click: () => void onAddPhotoColumn().then(() => dialog.close()) } }, 'Add a Photo column'),
              ' to show the photos from your links.',
            )
          : null,
      ),
    );
  }

  const error = h('p', { class: 'sl-error', role: 'alert' });
  const save = h('button', { type: 'submit', class: 'sl-button sl-button--primary' }, item ? 'Save changes' : 'Add item');
  const actions = h(
    'div',
    { class: 'sl-dialog-actions' },
    item && canEdit && onDelete
      ? h('button', {
          type: 'button',
          class: 'sl-button sl-button--danger',
          on: {
            click: async () => {
              if (!confirm('Delete this item? This cannot be undone.')) return;
              await onDelete();
              dialog.close();
            },
          },
        }, icon('trash', 16), 'Delete item')
      : null,
    h('span', { class: 'sl-spacer' }),
    h('button', { type: 'button', class: 'sl-button', on: { click: () => dialog.close() } }, canEdit ? 'Cancel' : 'Close'),
    canEdit ? save : null,
  );
  form.append(error, actions);

  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    const values: Record<string, CellValue> = {};
    for (const [key, read] of readers) {
      const next = read();
      const before = item?.values[key] ?? null;
      const normalized = next === '' ? null : next;
      // Only what changed is sent, so two people editing different cells of the same row don't overwrite each other.
      if (item ? String(normalized ?? '') !== String(before ?? '') : normalized !== null && normalized !== false) values[key] = normalized;
    }
    if (item && Object.keys(values).length === 0) {
      dialog.close();
      return;
    }
    save.disabled = true;
    error.textContent = '';
    try {
      await onSave(values);
      dialog.close();
    } catch (e) {
      error.textContent = (e as Error).message;
      save.disabled = false;
    }
  });

  const dialog = openDialog(item ? (canEdit ? 'Edit item' : 'Item') : 'New item', form, { className: 'sl-dialog--item' });
  if (canEdit && !item) form.querySelector<HTMLElement>('textarea, input:not([type="checkbox"]):not([type="radio"])')?.focus();
}

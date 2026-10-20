// How each column type shows a value. Shared by the list page and the landing
// page's example, so the two can never look different.

import { h, icon } from './dom.ts';
import { date, host, money, number } from './format.ts';
import type { CellValue, Column, TagColor } from '../../shared/types.ts';

export function tag(value: string, color: TagColor): HTMLElement {
  return h('span', { class: 'sl-tag', data: { color, value } }, value);
}

export function optionColor(column: Column, value: string): TagColor {
  return column.options?.find((o) => o.value === value)?.color ?? 'gray';
}

export function checkbox(checked: boolean, label: string, onToggle?: () => void): HTMLButtonElement {
  return h(
    'button',
    {
      type: 'button',
      class: 'sl-check',
      role: 'checkbox',
      'aria-checked': String(checked),
      'aria-label': label,
      disabled: !onToggle,
      on: onToggle
        ? {
            click: (event: MouseEvent) => {
              event.stopPropagation();
              onToggle();
            },
          }
        : {},
    },
    icon('check', 16),
  );
}

/** The content of a cell, or null when it is empty. Checkboxes are drawn by the caller, which owns the toggle. */
export function display(column: Column, value: CellValue | undefined, cents: boolean): Node | null {
  if (value === null || value === undefined || value === '') return null;
  switch (column.type) {
    case 'text':
      return h('span', { class: 'sl-text' }, String(value));
    case 'number':
      return h('span', { class: 'sl-num' }, number(Number(value)));
    case 'currency':
      return h('span', { class: 'sl-num' }, money(Number(value), column.currency, cents));
    case 'date':
      return h('time', { class: 'sl-date', datetime: String(value) }, date(String(value)));
    case 'select':
      return tag(String(value), optionColor(column, String(value)));
    case 'url':
      return h(
        'a',
        {
          class: 'sl-link',
          href: String(value),
          target: '_blank',
          rel: 'noopener noreferrer',
          on: { click: (event: MouseEvent) => event.stopPropagation() },
        },
        h('span', {}, host(String(value))),
        icon('out', 13),
      );
    case 'image': {
      const img = h('img', {
        class: 'sl-thumb',
        src: String(value),
        alt: '',
        loading: 'lazy',
        decoding: 'async',
        referrerPolicy: 'no-referrer',
      });
      const button = h(
        'button',
        {
          type: 'button',
          class: 'sl-thumb-button',
          'aria-label': `Enlarge ${column.name.toLowerCase()}`,
          on: {
            click: (event: MouseEvent) => {
              // The row and the cell would open their own editors.
              event.stopPropagation();
              openPicture(String(value));
            },
          },
        },
        img,
      );
      img.addEventListener('error', () => button.replaceWith(h('span', { class: 'sl-thumb sl-thumb--broken', title: 'Image did not load' }, icon('image', 16))));
      return button;
    }
    case 'checkbox':
      return null;
  }
}

/** A picture at full size, over everything. Any tap or Escape closes it. */
export function openPicture(src: string): void {
  const dialog = h(
    'dialog',
    { class: 'sl-lightbox', 'aria-label': 'Photo' },
    h('img', { class: 'sl-lightbox-image', src, alt: '', referrerPolicy: 'no-referrer' }),
    h('button', { type: 'button', class: 'sl-icon-button sl-lightbox-close', 'aria-label': 'Close' }, icon('x')),
  );
  dialog.addEventListener('click', (event) => {
    event.stopPropagation();
    dialog.close();
  });
  dialog.addEventListener('close', () => dialog.remove());
  document.body.appendChild(dialog);
  dialog.showModal();
}

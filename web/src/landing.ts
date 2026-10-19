import { api, BASE } from './api.ts';
import { openDialog } from './dialog.ts';
import { h, icon } from './dom.ts';
import { PRESETS } from '../../shared/presets.ts';

const REPO = 'https://github.com/realAndi/shared-list';

/** Read by the list page, which says what to do next the first time it opens. */
export const CREATED_KEY = 'sl-created';

function openCreate(): void {
  const title = h('input', { class: 'sl-input', id: 'sl-new-title', required: true, maxlength: '120', placeholder: 'Apartment furniture', autocomplete: 'off' });
  const password = h('input', {
    class: 'sl-input',
    id: 'sl-new-password',
    // Shown as typed: it is about to be shared, so it should be seen.
    type: 'text',
    required: true,
    minlength: '4',
    autocomplete: 'off',
    autocapitalize: 'off',
    spellcheck: false,
  });
  const preset = h(
    'select',
    { class: 'sl-input', id: 'sl-new-preset' },
    Object.entries(PRESETS).map(([key, p]) => h('option', { value: key }, `${p.label}: ${p.columns.map((c) => c.name).join(', ')}`)),
  );
  const error = h('p', { class: 'sl-error', role: 'alert' });
  const submit = h('button', { type: 'submit', class: 'sl-button sl-button--primary' }, 'Create list');

  const form = h('form', { class: 'sl-form' },
    h('div', { class: 'sl-field' }, h('label', { class: 'sl-label', for: 'sl-new-title' }, 'Title'), title),
    h('div', { class: 'sl-field' },
      h('label', { class: 'sl-label', for: 'sl-new-password' }, 'Password'),
      password,
      h('p', { class: 'sl-hint' }, 'Everyone you send the link to needs this to open the list.'),
    ),
    h('div', { class: 'sl-field' },
      h('label', { class: 'sl-label', for: 'sl-new-preset' }, 'Columns to start with'),
      preset,
      h('p', { class: 'sl-hint' }, 'Add, rename and remove columns any time from the list’s settings.'),
    ),
    error,
    h('div', { class: 'sl-dialog-actions' }, h('span', { class: 'sl-spacer' }), submit),
  );

  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    submit.disabled = true;
    error.textContent = '';
    try {
      const res = await api.create({ title: title.value, password: password.value, preset: preset.value });
      const id = res!.list.id;
      try {
        sessionStorage.setItem(CREATED_KEY, id);
      } catch {
        // No note for the list page; it opens all the same.
      }
      location.assign(BASE + encodeURIComponent(id));
    } catch (e) {
      error.textContent = (e as Error).message;
      submit.disabled = false;
    }
  });

  openDialog('New list', form);
  title.focus();
}

export function renderLanding(root: HTMLElement): void {
  document.body.dataset.page = 'landing';

  root.replaceChildren(
    h('header', { class: 'sl-topbar' },
      h('a', { class: 'sl-brand', href: BASE }, h('span', { class: 'sl-brand-mark', 'aria-hidden': 'true' }), 'Shared List'),
    ),
    h('main', { class: 'sl-main sl-landing' },
      h('h1', { class: 'sl-title sl-hero-title' }, 'Shared List'),
      h('p', { class: 'sl-lead' }, 'Make a list, lock it with a password, and send the link. Everyone with both can see it and edit it.'),
      h('button', { type: 'button', class: 'sl-button sl-button--primary sl-create', on: { click: openCreate } }, icon('plus', 18), 'Create list'),
    ),
    h('footer', { class: 'sl-footer' }, h('a', { href: REPO }, 'Source on GitHub')),
  );
}

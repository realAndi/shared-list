import { api } from './api.ts';
import { h, icon } from './dom.ts';
import type { ListPayload } from '../../shared/types.ts';

/** The password gate. It says nothing about the list — not even its title — until it opens. */
export function renderLock(root: HTMLElement, id: string, onOpen: (list: ListPayload) => void): void {
  document.body.dataset.page = 'lock';
  document.title = 'Locked list · Shared List';
  delete root.dataset.list;

  const password = h('input', {
    class: 'sl-input',
    id: 'sl-password',
    type: 'password',
    autocomplete: 'current-password',
    required: true,
    enterkeyhint: 'go',
  });
  const error = h('p', { class: 'sl-error', role: 'alert' });
  const submit = h('button', { type: 'submit', class: 'sl-button sl-button--primary' }, 'Open list');

  const form = h(
    'form',
    { class: 'sl-gate-form' },
    // A username field, hidden, lets password managers file the password under this list.
    h('input', { type: 'text', name: 'username', autocomplete: 'username', value: id, hidden: true, readonly: true }),
    h('label', { class: 'sl-label', for: 'sl-password' }, 'Password'),
    h('div', { class: 'sl-row-inline' }, password, submit),
    error,
  );

  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    if (!password.value) return;
    submit.disabled = true;
    error.textContent = '';
    try {
      const res = await api.unlock(id, password.value);
      onOpen(res!.list);
    } catch (e) {
      error.textContent = (e as Error).message;
      submit.disabled = false;
      password.select();
    }
  });

  root.replaceChildren(
    h('main', { class: 'sl-gate' },
      h('div', { class: 'sl-gate-icon', 'aria-hidden': 'true' }, icon('lock', 22)),
      h('p', { class: 'sl-eyebrow' }, 'Shared List'),
      h('h1', { class: 'sl-gate-title' }, 'Enter the password'),
      h('p', { class: 'sl-gate-text' }, 'This list is private. Whoever sent you the link has the password.'),
      form,
    ),
  );
  password.focus();
}

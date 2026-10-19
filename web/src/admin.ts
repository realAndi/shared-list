// Admin: everything the admin token can do from a browser — see every list,
// make a new one, and find the details for connecting an agent.

import { adminToken, api, ApiError, BASE } from './api.ts';
import { h, icon, toast } from './dom.ts';
import { ago } from './format.ts';
import { PRESETS } from '../../shared/presets.ts';
import type { ListSummary } from '../../shared/types.ts';

function topbar(signOut?: () => void): HTMLElement {
  return h('header', { class: 'sl-topbar' },
    h('a', { class: 'sl-brand', href: BASE }, h('span', { class: 'sl-brand-mark', 'aria-hidden': 'true' }), 'Shared List'),
    h('nav', { class: 'sl-actions', 'aria-label': 'Admin' },
      signOut ? h('button', { type: 'button', class: 'sl-button sl-button--quiet', on: { click: signOut } }, 'Sign out') : null,
    ),
  );
}

function signIn(root: HTMLElement): void {
  const token = h('input', { class: 'sl-input', id: 'sl-token', type: 'password', autocomplete: 'current-password', required: true });
  const error = h('p', { class: 'sl-error', role: 'alert' });
  const form = h('form', { class: 'sl-gate-form' },
    h('input', { type: 'text', name: 'username', autocomplete: 'username', value: 'shared-list-admin', hidden: true, readonly: true }),
    h('label', { class: 'sl-label', for: 'sl-token' }, 'Admin token'),
    h('div', { class: 'sl-row-inline' }, token, h('button', { type: 'submit', class: 'sl-button sl-button--primary' }, 'Sign in')),
    error,
  );
  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    try {
      await api.admin(token.value.trim());
      adminToken.set(token.value.trim());
      renderAdmin(root);
    } catch (e) {
      error.textContent = e instanceof ApiError && e.status === 401 ? 'That token is not this server’s admin token.' : (e as Error).message;
    }
  });
  root.replaceChildren(
    topbar(),
    h('main', { class: 'sl-gate' },
      h('p', { class: 'sl-eyebrow' }, 'Shared List'),
      h('h1', { class: 'sl-gate-title' }, 'Admin'),
      h('p', { class: 'sl-gate-text' }, 'The admin token is set when the server is deployed. It stays in this browser until you sign out.'),
      form,
    ),
  );
  token.focus();
}

function createForm(onCreated: (url: string, password: string) => void): HTMLElement {
  const title = h('input', { class: 'sl-input', id: 'sl-new-title', required: true, maxlength: '120', placeholder: 'Apartment furniture' });
  const slug = h('input', { class: 'sl-input', id: 'sl-new-id', placeholder: 'Random if empty', autocapitalize: 'off', spellcheck: false });
  const password = h('input', { class: 'sl-input', id: 'sl-new-password', type: 'text', required: true, minlength: '4', autocomplete: 'off', spellcheck: false });
  const preset = h('select', { class: 'sl-input', id: 'sl-new-preset' }, Object.entries(PRESETS).map(([key, p]) => h('option', { value: key }, `${p.label} — ${p.columns.map((c) => c.name).join(', ')}`)));
  const editable = h('input', { type: 'checkbox', id: 'sl-new-editable', class: 'sl-switch-input', checked: true });
  const error = h('p', { class: 'sl-error', role: 'alert' });

  const form = h('form', { class: 'sl-form sl-panel' },
    h('h2', { class: 'sl-panel-title' }, 'New list'),
    h('div', { class: 'sl-field' }, h('label', { class: 'sl-label', for: 'sl-new-title' }, 'Title'), title),
    h('div', { class: 'sl-field-pair' },
      h('div', { class: 'sl-field' }, h('label', { class: 'sl-label', for: 'sl-new-id' }, 'List ID'), slug, h('p', { class: 'sl-hint' }, `${location.host}${BASE}${'<id>'}`)),
      h('div', { class: 'sl-field' }, h('label', { class: 'sl-label', for: 'sl-new-password' }, 'Password'), password),
    ),
    h('div', { class: 'sl-field' }, h('label', { class: 'sl-label', for: 'sl-new-preset' }, 'Start with'), preset),
    h('label', { class: 'sl-switch', for: 'sl-new-editable' }, editable, h('span', { class: 'sl-switch-track' }), h('span', {}, 'People with the password can edit')),
    error,
    h('div', { class: 'sl-dialog-actions' }, h('span', { class: 'sl-spacer' }), h('button', { type: 'submit', class: 'sl-button sl-button--primary' }, icon('plus', 16), 'Create list')),
  );
  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    error.textContent = '';
    try {
      const res = await api.create({
        title: title.value,
        id: slug.value.trim() || undefined,
        password: password.value,
        preset: preset.value,
        editable: editable.checked,
      });
      onCreated(res!.list.url, password.value);
      form.reset();
    } catch (e) {
      error.textContent = (e as Error).message;
    }
  });
  return form;
}

function listsTable(lists: ListSummary[]): HTMLElement {
  if (!lists.length) return h('p', { class: 'sl-hint' }, 'No lists yet. Make one with the form, or ask an agent to.');
  return h('div', { class: 'sl-admin-lists' },
    lists.map((l) =>
      h('a', { class: 'sl-admin-list', href: `${BASE}${l.id}` },
        h('span', { class: 'sl-admin-list-title' }, l.title),
        h('span', { class: 'sl-admin-list-meta' }, `/${l.id} · ${l.items} item${l.items === 1 ? '' : 's'}${l.editable ? '' : ' · view only'} · ${ago(l.updated_at)}`),
      ),
    ),
  );
}

function connectPanel(): HTMLElement {
  const token = adminToken.get() ?? '';
  const url = `${location.origin}${BASE}mcp`;
  const command = `claude mcp add --transport http shared-list ${url} --header "Authorization: Bearer ${token}"`;
  const shown = h('pre', { class: 'sl-code-block' }, command.replace(token, '•'.repeat(12)));
  return h('section', { class: 'sl-panel' },
    h('h2', { class: 'sl-panel-title' }, 'Connect an agent'),
    h('p', {}, 'Any MCP client that speaks Streamable HTTP. Send the admin token as a bearer token; a client that only takes a URL can use ', h('code', {}, `${url}/<token>`), '.'),
    shown,
    h('div', { class: 'sl-dialog-actions' },
      h('span', { class: 'sl-spacer' }),
      h('button', {
        type: 'button',
        class: 'sl-button',
        on: {
          click: async () => {
            try {
              await navigator.clipboard.writeText(command);
              toast('Command copied, token included');
            } catch {
              shown.textContent = command;
            }
          },
        },
      }, 'Copy command'),
    ),
  );
}

export async function renderAdmin(root: HTMLElement): Promise<void> {
  document.body.dataset.page = 'admin';
  document.title = 'Admin · Shared List';
  if (!adminToken.get()) return signIn(root);

  let lists: ListSummary[];
  try {
    lists = (await api.admin())!.lists;
  } catch (e) {
    if (e instanceof ApiError && e.status === 401) return signIn(root);
    root.replaceChildren(h('div', { class: 'sl-empty' }, h('p', {}, (e as Error).message)));
    return;
  }

  const listBox = h('section', { class: 'sl-panel' }, h('h2', { class: 'sl-panel-title' }, `Lists (${lists.length})`), listsTable(lists));
  const created = h('div', { class: 'sl-created', role: 'status' });

  root.replaceChildren(
    topbar(() => {
      adminToken.set(null);
      signIn(root);
    }),
    h('main', { class: 'sl-main sl-admin' },
      h('h1', { class: 'sl-title' }, 'Admin'),
      created,
      h('div', { class: 'sl-admin-grid' },
        createForm(async (url, password) => {
          created.replaceChildren(
            h('p', {}, h('strong', {}, 'List created. '), 'Send both of these:'),
            h('pre', { class: 'sl-code-block' }, `${url}\nPassword: ${password}`),
          );
          lists = (await api.admin())!.lists;
          listBox.replaceChildren(h('h2', { class: 'sl-panel-title' }, `Lists (${lists.length})`), listsTable(lists));
        }),
        listBox,
      ),
      connectPanel(),
    ),
  );
}

import { h, icon } from './dom.ts';

/**
 * A modal <dialog> with a heading and a close button. It removes itself when
 * closed, and a click on the backdrop closes it like Escape does.
 */
export function openDialog(title: string, body: Node, opts: { className?: string; onClose?: () => void } = {}): HTMLDialogElement {
  const dialog = h(
    'dialog',
    { class: `sl-dialog ${opts.className ?? ''}`, 'aria-labelledby': 'sl-dialog-title' },
    h(
      'div',
      { class: 'sl-dialog-head' },
      h('h2', { class: 'sl-dialog-title', id: 'sl-dialog-title' }, title),
      h('button', { type: 'button', class: 'sl-icon-button', 'aria-label': 'Close', on: { click: () => dialog.close() } }, icon('x')),
    ),
    body,
  );
  dialog.addEventListener('click', (event) => {
    if (event.target === dialog) dialog.close();
  });
  dialog.addEventListener('close', () => {
    dialog.remove();
    opts.onClose?.();
  });
  document.body.appendChild(dialog);
  dialog.showModal();
  return dialog;
}

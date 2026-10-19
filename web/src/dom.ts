// DOM built with createElement rather than innerHTML, so nothing a list holds
// can ever be read as markup.

type Child = Node | string | number | false | null | undefined | Child[];
type Props = {
  class?: string;
  data?: Record<string, string | number | boolean | undefined>;
  on?: Partial<{ [K in keyof HTMLElementEventMap]: (event: HTMLElementEventMap[K]) => void }>;
  [attr: string]: unknown;
};

function append(parent: Node, child: Child): void {
  if (child === null || child === undefined || child === false) return;
  if (Array.isArray(child)) child.forEach((c) => append(parent, c));
  else parent.appendChild(child instanceof Node ? child : document.createTextNode(String(child)));
}

export function h<K extends keyof HTMLElementTagNameMap>(tag: K, props: Props = {}, ...children: Child[]): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  for (const [key, value] of Object.entries(props)) {
    if (value === undefined || value === null || value === false) continue;
    if (key === 'class') el.className = value as string;
    else if (key === 'data') {
      for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
        if (v !== undefined && v !== false) el.dataset[k] = v === true ? '' : String(v);
      }
    } else if (key === 'on') {
      for (const [event, handler] of Object.entries(value as Record<string, EventListener>)) el.addEventListener(event, handler);
    } else if (key in el && typeof value !== 'string') {
      (el as unknown as Record<string, unknown>)[key] = value;
    } else {
      el.setAttribute(key, value === true ? '' : String(value));
    }
  }
  append(el, children);
  return el;
}

const PATHS: Record<string, string> = {
  check: 'M4.5 12.5l4.5 4.5L19.5 6.5',
  plus: 'M12 5v14M5 12h14',
  x: 'M6 6l12 12M18 6L6 18',
  search: 'M10.5 17a6.5 6.5 0 1 0 0-13 6.5 6.5 0 0 0 0 13zM15.5 15.5L20 20',
  share: 'M12 15V4M8 8l4-4 4 4M5 13v6h14v-6',
  settings: 'M4 7h10M18 7h2M4 17h4M12 17h8M14 4.5v5M8 14.5v5',
  lock: 'M7 11V8a5 5 0 0 1 10 0v3M5.5 11h13v9h-13z',
  out: 'M14 5h5v5M19 5l-8 8M17 14v5H5V7h5',
  up: 'M12 19V5M6 11l6-6 6 6',
  down: 'M12 5v14M6 13l6 6 6-6',
  more: 'M5 12h.01M12 12h.01M19 12h.01',
  trash: 'M5 7h14M10 7V4.5h4V7M7 7l1 12.5h8L17 7',
  image: 'M4.5 5.5h15v13h-15zM4.5 15l4-4 4 4 2.5-2.5 4.5 4.5',
};

export function icon(name: keyof typeof PATHS | string, size = 18): SVGSVGElement {
  const ns = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(ns, 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('width', String(size));
  svg.setAttribute('height', String(size));
  svg.setAttribute('aria-hidden', 'true');
  svg.setAttribute('class', 'sl-icon');
  const path = document.createElementNS(ns, 'path');
  path.setAttribute('d', PATHS[name] ?? '');
  svg.appendChild(path);
  return svg;
}

export function clear(el: Element): void {
  while (el.firstChild) el.removeChild(el.firstChild);
}

let toastTimer: number | undefined;

/** One short line at the foot of the screen; a newer one replaces it. */
export function toast(message: string, tone: 'info' | 'error' = 'info'): void {
  let el = document.querySelector<HTMLElement>('.sl-toast');
  if (!el) {
    el = h('div', { class: 'sl-toast', role: 'status', 'aria-live': 'polite' });
    document.body.appendChild(el);
  }
  el.textContent = message;
  el.dataset.tone = tone;
  el.dataset.show = '';
  window.clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => delete el!.dataset.show, tone === 'error' ? 5000 : 2400);
}

/** Read and write localStorage without letting a private window or blocked storage break the page. */
export const storage = {
  get(key: string): string | null {
    try {
      return localStorage.getItem(key);
    } catch {
      return null;
    }
  },
  set(key: string, value: string | null): void {
    try {
      if (value === null) localStorage.removeItem(key);
      else localStorage.setItem(key, value);
    } catch {
      // Not persisted; the page still works.
    }
  },
};

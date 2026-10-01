/* UI kit: DOM helpers, toasts, modals, popover menus, focus management,
 * and a virtualised list. No framework — just the handful of primitives the
 * views actually need. */

import { esc, clamp, debounce } from '../core/util.js';
import { icon } from './icons.js';

/* ------------------------------ DOM basics ------------------------------ */

export const $ = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

/**
 * Create an element.
 *   el('div.card', { onclick }, 'text', childNode)
 * The tag accepts `tag.class.class#id` shorthand.
 */
export function el(tag, props = {}, ...children) {
  const [name, ...rest] = String(tag).split(/(?=[.#])/);
  const node = document.createElement(name || 'div');

  for (const token of rest) {
    if (token[0] === '.') node.classList.add(token.slice(1));
    else if (token[0] === '#') node.id = token.slice(1);
  }

  for (const [k, v] of Object.entries(props || {})) {
    if (v == null || v === false) continue;
    if (k === 'class' || k === 'className') node.className += ` ${v}`;
    else if (k === 'html') node.innerHTML = v;
    else if (k === 'text') node.textContent = v;
    else if (k === 'style' && typeof v === 'object') Object.assign(node.style, v);
    else if (k === 'dataset') Object.assign(node.dataset, v);
    else if (k.startsWith('on') && typeof v === 'function') {
      node.addEventListener(k.slice(2).toLowerCase(), v);
    } else if (k === 'ref' && typeof v === 'function') v(node);
    else if (v === true) node.setAttribute(k, '');
    else node.setAttribute(k, v);
  }

  append(node, children);
  return node;
}

export function append(parent, children) {
  for (const c of children.flat(4)) {
    if (c == null || c === false) continue;
    parent.appendChild(c instanceof Node ? c : document.createTextNode(String(c)));
  }
  return parent;
}

export function frag(...children) {
  return append(document.createDocumentFragment(), children);
}

export function clear(node) {
  while (node.firstChild) node.removeChild(node.firstChild);
  return node;
}

/** Event delegation — one listener for a whole list. */
export function delegate(root, event, selector, handler) {
  const fn = (e) => {
    const match = e.target.closest?.(selector);
    if (match && root.contains(match)) handler(e, match);
  };
  root.addEventListener(event, fn);
  return () => root.removeEventListener(event, fn);
}

/** Textarea that grows with its content, capped. */
export function autoGrow(node, max = 160) {
  const resize = () => {
    node.style.height = 'auto';
    node.style.height = `${Math.min(node.scrollHeight, max)}px`;
  };
  node.addEventListener('input', resize);
  requestAnimationFrame(resize);
  return resize;
}

/* ------------------------------ formatting ------------------------------ */

/** Minimal inline markdown for assistant replies: **bold**, `code`, _em_,
 *  links, and `- ` lists. Everything is escaped first, so this can never
 *  introduce markup from the model or from another user. */
export function mdInline(text) {
  let s = esc(text);
  s = s.replace(/`([^`\n]+)`/g, '<code>$1</code>');
  s = s.replace(/\*\*([^*\n]+)\*\*/g, '<strong>$1</strong>');
  s = s.replace(/(^|[\s(])_([^_\n]+)_/g, '$1<em>$2</em>');
  s = s.replace(
    /\bhttps?:\/\/[^\s<]+/g,
    (m) => `<a href="${m}" target="_blank" rel="noopener noreferrer">${m}</a>`
  );
  return s;
}

export function mdBlock(text) {
  const blocks = String(text || '').split(/\n{2,}/);
  return blocks
    .map((block) => {
      const lines = block.split('\n');
      if (lines.every((l) => /^\s*[-*]\s+/.test(l))) {
        return `<ul>${lines
          .map((l) => `<li>${mdInline(l.replace(/^\s*[-*]\s+/, ''))}</li>`)
          .join('')}</ul>`;
      }
      if (lines.every((l) => /^\s*\d+[.)]\s+/.test(l))) {
        return `<ol>${lines
          .map((l) => `<li>${mdInline(l.replace(/^\s*\d+[.)]\s+/, ''))}</li>`)
          .join('')}</ol>`;
      }
      return `<p>${lines.map(mdInline).join('<br>')}</p>`;
    })
    .join('');
}

/* -------------------------------- toasts -------------------------------- */

let toastHost = null;

function host() {
  if (!toastHost) {
    toastHost = el('div.toasts', { id: 'toasts', role: 'status', 'aria-live': 'polite' });
    document.body.appendChild(toastHost);
  }
  return toastHost;
}

const TOAST_ICON = {
  info: 'info',
  success: 'circleCheck',
  warn: 'warning',
  error: 'error',
};

/**
 * Show a toast.
 * @param {string} message
 * @param {object} [opts] { kind, duration, action: { label, onClick } }
 */
export function toast(message, opts = {}) {
  const kind = opts.kind || 'info';
  const node = el(
    'div.toast',
    { role: kind === 'error' ? 'alert' : undefined },
    el('span', {
      html: icon(TOAST_ICON[kind] || 'info'),
      class:
        kind === 'error' ? 'c-danger' : kind === 'success' ? 'c-ok' : kind === 'warn' ? 'c-warn' : 'faint',
    }),
    el('div.toast-msg', { text: message })
  );

  if (opts.action) {
    node.appendChild(
      el('button.toast-action', {
        type: 'button',
        text: opts.action.label,
        onclick: () => {
          try {
            opts.action.onClick();
          } finally {
            dismiss();
          }
        },
      })
    );
  }

  node.appendChild(
    el('button.icon-btn.sm', {
      type: 'button',
      'aria-label': 'Dismiss',
      html: icon('x'),
      onclick: () => dismiss(),
    })
  );

  host().appendChild(node);

  const ttl = opts.duration ?? (opts.action ? 7000 : kind === 'error' ? 6000 : 3600);
  let timer = setTimeout(dismiss, ttl);

  // Don't yank a toast away while the pointer is on it.
  node.addEventListener('mouseenter', () => clearTimeout(timer));
  node.addEventListener('mouseleave', () => {
    timer = setTimeout(dismiss, 1500);
  });

  function dismiss() {
    clearTimeout(timer);
    if (!node.isConnected) return;
    node.classList.add('leaving');
    node.addEventListener('animationend', () => node.remove(), { once: true });
    setTimeout(() => node.remove(), 300);
  }

  return { dismiss, node };
}

/* ---------------------------- focus management ---------------------------- */

const FOCUSABLE =
  'a[href],button:not([disabled]),input:not([disabled]),select:not([disabled]),textarea:not([disabled]),[tabindex]:not([tabindex="-1"]),[contenteditable="true"]';

export function trapFocus(container) {
  const previous = document.activeElement;

  const onKey = (e) => {
    if (e.key !== 'Tab') return;
    const items = $$(FOCUSABLE, container).filter((n) => n.offsetParent !== null);
    if (!items.length) return;
    const first = items[0];
    const last = items[items.length - 1];
    if (e.shiftKey && document.activeElement === first) {
      e.preventDefault();
      last.focus();
    } else if (!e.shiftKey && document.activeElement === last) {
      e.preventDefault();
      first.focus();
    }
  };

  container.addEventListener('keydown', onKey);

  return () => {
    container.removeEventListener('keydown', onKey);
    if (previous && previous.isConnected) previous.focus();
  };
}

export function focusFirst(container) {
  const target =
    $('[autofocus]', container) || $$(FOCUSABLE, container).find((n) => n.offsetParent !== null);
  target?.focus();
  if (target?.select) target.select();
}

/* -------------------------------- modals -------------------------------- */

const openModals = [];

/**
 * Open a modal sheet.
 * @returns {{ el, close, body, foot }}
 */
export function modal({ title, body, foot, size = '', onClose, closeOnBackdrop = true } = {}) {
  const bodyEl = el('div.sheet-body');
  const footEl = el('div.sheet-foot');

  if (body) append(bodyEl, [body]);
  if (foot) append(footEl, [foot]);

  const sheet = el(
    `div.sheet${size ? `.sheet-${size}` : ''}`,
    { role: 'dialog', 'aria-modal': 'true', 'aria-label': title || 'Dialog' },
    title
      ? el(
          'div.sheet-head',
          {},
          el('div.t-sub', { text: title }),
          el('div.spacer'),
          el('button.icon-btn', {
            type: 'button',
            'aria-label': 'Close',
            html: icon('x'),
            onclick: () => close(),
          })
        )
      : null,
    bodyEl,
    foot ? footEl : null
  );

  const overlay = el('div.overlay', {}, sheet);
  overlay.addEventListener('mousedown', (e) => {
    if (e.target === overlay && closeOnBackdrop) close();
  });

  document.body.appendChild(overlay);
  requestAnimationFrame(() => overlay.classList.add('on'));

  const release = trapFocus(sheet);
  requestAnimationFrame(() => focusFirst(sheet));

  const entry = { overlay, close };
  openModals.push(entry);

  /* Escape closes the topmost dialog. Bound on the document rather than the
     overlay so it works even when focus has slipped outside the sheet, and
     gated on being top-of-stack so nested dialogs unwind one at a time. */
  const onKey = (e) => {
    if (e.key !== 'Escape') return;
    if (openModals[openModals.length - 1] !== entry) return;
    if (document.querySelector('.menu')) return; // a popover handles its own
    e.preventDefault();
    e.stopPropagation();
    close();
  };
  document.addEventListener('keydown', onKey, true);

  function close(result) {
    const i = openModals.indexOf(entry);
    if (i < 0) return; // already closed — don't fire onClose twice
    openModals.splice(i, 1);
    document.removeEventListener('keydown', onKey, true);
    overlay.classList.remove('on');
    release();
    setTimeout(() => overlay.remove(), 220);
    onClose?.(result);
  }

  return { el: sheet, overlay, close, body: bodyEl, foot: footEl };
}

export function topModal() {
  return openModals[openModals.length - 1] || null;
}

/** Promise-based confirm. Destructive actions default to a red primary. */
export function confirm({
  title = 'Are you sure?',
  message = '',
  confirmLabel = 'Confirm',
  cancelLabel = 'Cancel',
  danger = false,
} = {}) {
  return new Promise((resolve) => {
    let settled = false;
    const done = (v) => {
      if (settled) return;
      settled = true;
      resolve(v);
      m.close();
    };

    const m = modal({
      title,
      size: 'sm',
      body: el('div.t-body', { html: mdBlock(message) }),
      foot: frag(
        el('div.spacer'),
        el('button.btn', { type: 'button', text: cancelLabel, onclick: () => done(false) }),
        el(`button.btn.${danger ? 'btn-danger' : 'btn-primary'}`, {
          type: 'button',
          text: confirmLabel,
          autofocus: true,
          onclick: () => done(true),
        })
      ),
      onClose: () => {
        if (!settled) {
          settled = true;
          resolve(false);
        }
      },
    });
  });
}

/** Single-field prompt. */
export function promptText({ title, label, value = '', placeholder = '', confirmLabel = 'Save', multiline = false } = {}) {
  return new Promise((resolve) => {
    let settled = false;
    const input = multiline
      ? el('textarea.textarea', { placeholder, autofocus: true })
      : el('input.input', { type: 'text', placeholder, autofocus: true });
    input.value = value;

    const submit = () => {
      const v = input.value.trim();
      if (!v) {
        input.focus();
        return;
      }
      settled = true;
      resolve(v);
      m.close();
    };

    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && (!multiline || e.metaKey || e.ctrlKey)) {
        e.preventDefault();
        submit();
      }
    });

    const m = modal({
      title,
      size: 'sm',
      body: el('label.field', {}, label ? el('span', { text: label }) : null, input),
      foot: frag(
        el('div.spacer'),
        el('button.btn', { type: 'button', text: 'Cancel', onclick: () => m.close() }),
        el('button.btn.btn-primary', { type: 'button', text: confirmLabel, onclick: submit })
      ),
      onClose: () => {
        if (!settled) resolve(null);
      },
    });
  });
}

/* ------------------------------ popover menu ------------------------------ */

let activeMenu = null;

export function closeMenu() {
  if (!activeMenu) return;
  activeMenu.node.remove();
  document.removeEventListener('mousedown', activeMenu.onDoc, true);
  document.removeEventListener('keydown', activeMenu.onKey, true);
  window.removeEventListener('resize', activeMenu.close);
  window.removeEventListener('scroll', activeMenu.close, true);
  activeMenu.anchor?.setAttribute?.('aria-expanded', 'false');
  activeMenu = null;
}

/**
 * Open a popover menu anchored to an element.
 * Items: { label, icon, onClick, checked, danger, kbd } | 'separator' | { label, header:true }
 */
export function menu(anchor, items, opts = {}) {
  closeMenu();

  const node = el('div.menu', { role: 'menu' });
  const buttons = [];

  for (const item of items.flat()) {
    if (!item) continue;
    if (item === 'separator' || item.separator) {
      node.appendChild(el('div.menu-sep', { role: 'separator' }));
      continue;
    }
    if (item.header) {
      node.appendChild(el('div.menu-label', { text: item.label }));
      continue;
    }

    const btn = el(`button.menu-item${item.danger ? '.danger' : ''}`, {
      type: 'button',
      role: item.checked != null ? 'menuitemradio' : 'menuitem',
      'aria-checked': item.checked != null ? String(!!item.checked) : null,
      disabled: item.disabled || null,
      onclick: (e) => {
        e.stopPropagation();
        if (item.keepOpen !== true) closeMenu();
        item.onClick?.(e);
      },
    });

    if (item.checked != null) {
      btn.innerHTML = item.checked ? icon('check') : '<span style="width:14px"></span>';
    } else if (item.icon) {
      btn.innerHTML = icon(item.icon);
    } else if (item.color) {
      btn.appendChild(
        el('span', {
          style: {
            width: '10px',
            height: '10px',
            borderRadius: '3px',
            background: item.color,
            flex: 'none',
          },
        })
      );
    }

    btn.appendChild(el('span.truncate', { text: item.label }));
    if (item.kbd) btn.appendChild(el('span.kbd', { text: item.kbd }));
    node.appendChild(btn);
    buttons.push(btn);
  }

  document.body.appendChild(node);

  // Position within the viewport, flipping when there isn't room below.
  const rect = anchor.getBoundingClientRect
    ? anchor.getBoundingClientRect()
    : { left: anchor.x, top: anchor.y, bottom: anchor.y, right: anchor.x, width: 0, height: 0 };
  const mw = node.offsetWidth;
  const mh = node.offsetHeight;
  const pad = 8;

  let left = opts.align === 'right' ? rect.right - mw : rect.left;
  left = clamp(left, pad, window.innerWidth - mw - pad);

  let top = rect.bottom + 4;
  if (top + mh > window.innerHeight - pad) {
    top = rect.top - mh - 4;
    node.style.transformOrigin = 'bottom left';
  }
  top = clamp(top, pad, Math.max(pad, window.innerHeight - mh - pad));

  node.style.left = `${left}px`;
  node.style.top = `${top}px`;

  const onDoc = (e) => {
    if (!node.contains(e.target) && e.target !== anchor) closeMenu();
  };
  const onKey = (e) => {
    if (e.key === 'Escape') {
      e.stopPropagation();
      closeMenu();
      anchor.focus?.();
      return;
    }
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      const i = buttons.indexOf(document.activeElement);
      const next = e.key === 'ArrowDown' ? (i + 1) % buttons.length : (i - 1 + buttons.length) % buttons.length;
      buttons[next]?.focus();
    }
  };

  document.addEventListener('mousedown', onDoc, true);
  document.addEventListener('keydown', onKey, true);
  window.addEventListener('resize', closeMenu);
  window.addEventListener('scroll', closeMenu, true);

  anchor.setAttribute?.('aria-expanded', 'true');
  activeMenu = { node, onDoc, onKey, anchor, close: closeMenu };

  if (opts.focusFirst !== false) requestAnimationFrame(() => buttons[0]?.focus());
  return { close: closeMenu, node };
}

/* ----------------------------- virtual list ----------------------------- */

/**
 * Windowed renderer for long lists.
 *
 * Rows are assumed to be `rowHeight` tall. Only the visible slice plus an
 * overscan margin is in the DOM, so a 10,000-task list scrolls as smoothly as
 * a 10-task one. Below `threshold` items it renders everything, because the
 * windowing machinery costs more than it saves on short lists.
 */
export class VirtualList {
  constructor({ container, rowHeight = 44, overscan = 8, threshold = 80, renderRow }) {
    this.container = container;
    this.rowHeight = rowHeight;
    this.overscan = overscan;
    this.threshold = threshold;
    this.renderRow = renderRow;
    this.items = [];

    this.viewport = el('div.vlist');
    this.spacer = el('div.vlist-spacer');
    this.window = el('div.vlist-window');
    this.viewport.append(this.spacer, this.window);
    container.appendChild(this.viewport);

    this.scroller = this.findScroller(container);
    this.onScroll = () => this.paint();
    this.scroller.addEventListener('scroll', this.onScroll, { passive: true });

    this.onResize = debounce(() => this.paint(), 120);
    window.addEventListener('resize', this.onResize);
  }

  findScroller(node) {
    let cur = node.parentElement;
    while (cur && cur !== document.body) {
      const oy = getComputedStyle(cur).overflowY;
      if (oy === 'auto' || oy === 'scroll') return cur;
      cur = cur.parentElement;
    }
    return document.scrollingElement || document.documentElement;
  }

  setItems(items) {
    this.items = items;
    this.paint(true);
  }

  paint(force = false) {
    const n = this.items.length;

    if (n < this.threshold) {
      // Small list: render it all and get out of the way.
      this.spacer.style.height = '0px';
      this.window.style.transform = '';
      if (force || this.window.childElementCount !== n) {
        clear(this.window);
        const f = document.createDocumentFragment();
        this.items.forEach((item, i) => {
          const row = this.renderRow(item, i);
          if (row) f.appendChild(row);
        });
        this.window.appendChild(f);
      }
      return;
    }

    const total = n * this.rowHeight;
    this.spacer.style.height = `${total}px`;

    const viewTop = this.viewport.getBoundingClientRect().top;
    const scrollerTop = this.scroller.getBoundingClientRect?.().top ?? 0;
    const offset = Math.max(0, scrollerTop - viewTop);
    const height = this.scroller.clientHeight || window.innerHeight;

    const first = Math.max(0, Math.floor(offset / this.rowHeight) - this.overscan);
    const visible = Math.ceil(height / this.rowHeight) + this.overscan * 2;
    const last = Math.min(n, first + visible);

    if (!force && this.first === first && this.last === last) return;
    this.first = first;
    this.last = last;

    const f = document.createDocumentFragment();
    for (let i = first; i < last; i++) {
      const row = this.renderRow(this.items[i], i);
      if (row) f.appendChild(row);
    }
    clear(this.window);
    this.window.appendChild(f);
    this.window.style.transform = `translateY(${first * this.rowHeight}px)`;
  }

  destroy() {
    this.scroller.removeEventListener('scroll', this.onScroll);
    window.removeEventListener('resize', this.onResize);
    this.viewport.remove();
  }
}

/* ------------------------------- misc bits ------------------------------- */

export function emptyState({ icon: name = 'inbox', title, body, action } = {}) {
  return el(
    'div.empty',
    {},
    el('span', { html: icon(name, { size: 22 }) }),
    title ? el('div.empty-title', { text: title }) : null,
    body ? el('div.empty-body', { text: body }) : null,
    action || null
  );
}

export function spinner(size = 14) {
  return el('span', {
    html: `<svg width="${size}" height="${size}" viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <circle cx="8" cy="8" r="6" stroke="currentColor" stroke-width="2" opacity=".2"/>
      <path d="M14 8a6 6 0 0 0-6-6" stroke="currentColor" stroke-width="2" stroke-linecap="round">
        <animateTransform attributeName="transform" type="rotate" from="0 8 8" to="360 8 8" dur="0.7s" repeatCount="indefinite"/>
      </path></svg>`,
    style: { display: 'inline-flex' },
  });
}

/** Copy to clipboard with a fallback for non-secure contexts. */
export async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    const ta = el('textarea', { style: { position: 'fixed', opacity: '0' } });
    ta.value = text;
    document.body.appendChild(ta);
    ta.select();
    const ok = document.execCommand?.('copy');
    ta.remove();
    return !!ok;
  }
}

/** Announce something to screen readers without moving focus. */
let liveRegion = null;

export function announce(message) {
  if (!liveRegion) {
    liveRegion = el('div.sr', { 'aria-live': 'polite', 'aria-atomic': 'true' });
    document.body.appendChild(liveRegion);
  }
  liveRegion.textContent = '';
  requestAnimationFrame(() => {
    liveRegion.textContent = message;
  });
}

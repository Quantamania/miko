/* Icon set — inline SVG, 16px grid, 1.5 stroke, round caps.
 *
 * One consistent family, drawn on the same grid, replaces the emoji the old
 * build used. Emoji render differently on every OS, carry no weight
 * relationship to the type around them, and read as decoration rather than UI.
 */

const paths = {
  /* navigation */
  inbox: '<path d="M2 10h4l1 2h4l1-2h4"/><path d="M4.5 3h7l2.5 7v3.5A1.5 1.5 0 0 1 12.5 15h-9A1.5 1.5 0 0 1 2 13.5V10z"/>',
  today: '<rect x="2.5" y="3.5" width="11" height="10.5" rx="1.5"/><path d="M2.5 6.5h11M5.5 2v3M10.5 2v3"/><circle cx="8" cy="10.5" r="1.2" fill="currentColor" stroke="none"/>',
  upcoming: '<rect x="2.5" y="3.5" width="11" height="10.5" rx="1.5"/><path d="M2.5 6.5h11M5.5 2v3M10.5 2v3M5 9.5h2M5 12h2M9 9.5h2M9 12h2"/>',
  list: '<path d="M5.5 4h8M5.5 8h8M5.5 12h8M2.5 4h.01M2.5 8h.01M2.5 12h.01"/>',
  board: '<rect x="2" y="3" width="4" height="10" rx="1"/><rect x="7.5" y="3" width="4" height="6.5" rx="1"/><rect x="13" y="3" width="1" height="10" rx=".5"/>',
  calendar: '<rect x="2.5" y="3.5" width="11" height="10.5" rx="1.5"/><path d="M2.5 6.5h11M5.5 2v3M10.5 2v3"/>',
  workload: '<path d="M2.5 13V9M6.5 13V5M10.5 13V7M14 13h-13"/>',
  insights: '<path d="M2 12.5 6 8l3 2.5L14 4"/><path d="M10.5 4H14v3.5"/>',
  focus: '<circle cx="8" cy="8" r="5.5"/><circle cx="8" cy="8" r="2"/>',
  activity: '<path d="M1.5 8h3l2-4.5 3 9 2-4.5h3"/>',
  trash: '<path d="M3 4.5h10M6.5 4.5V3a1 1 0 0 1 1-1h1a1 1 0 0 1 1 1v1.5M4.5 4.5l.6 8A1 1 0 0 0 6.1 13.5h3.8a1 1 0 0 0 1-.94l.6-8"/>',
  settings: '<circle cx="8" cy="8" r="2.2"/><path d="M8 1.8v1.7M8 12.5v1.7M13.4 8h-1.7M4.3 8H2.6M11.8 4.2l-1.2 1.2M5.4 10.6l-1.2 1.2M11.8 11.8l-1.2-1.2M5.4 5.4 4.2 4.2"/>',
  templates: '<rect x="2.5" y="2.5" width="11" height="11" rx="1.5"/><path d="M2.5 6h11M6 6v7.5"/>',
  automation: '<path d="M8.8 1.5 3.5 9h4l-.3 5.5L12.5 7h-4z"/>',
  project: '<path d="M2 5.5A1.5 1.5 0 0 1 3.5 4h2.2l1.3 1.6h5.5A1.5 1.5 0 0 1 14 7.1v4.4a1.5 1.5 0 0 1-1.5 1.5h-9A1.5 1.5 0 0 1 2 11.5z"/>',
  label: '<path d="M8.4 2.3H13a.7.7 0 0 1 .7.7v4.6a1 1 0 0 1-.3.7l-5.4 5.4a1 1 0 0 1-1.4 0L2.3 9.4a1 1 0 0 1 0-1.4l5.4-5.4a1 1 0 0 1 .7-.3z"/><circle cx="10.8" cy="5.2" r=".9"/>',

  /* actions */
  plus: '<path d="M8 3.5v9M3.5 8h9"/>',
  minus: '<path d="M3.5 8h9"/>',
  check: '<path d="M3 8.5 6.2 11.5 13 4.5"/>',
  x: '<path d="M4 4l8 8M12 4l-8 8"/>',
  search: '<circle cx="7.2" cy="7.2" r="4.4"/><path d="M10.5 10.5 14 14"/>',
  filter: '<path d="M2.5 4h11l-4.2 5v4l-2.6 1.3V9z"/>',
  sort: '<path d="M4 3v10M4 13l-2-2M4 13l2-2M12 13V3M12 3l-2 2M12 3l2 2"/>',
  more: '<circle cx="3.5" cy="8" r="1.1" fill="currentColor" stroke="none"/><circle cx="8" cy="8" r="1.1" fill="currentColor" stroke="none"/><circle cx="12.5" cy="8" r="1.1" fill="currentColor" stroke="none"/>',
  edit: '<path d="M11.2 2.6a1.4 1.4 0 0 1 2 2l-7.6 7.6-2.7.7.7-2.7z"/>',
  copy: '<rect x="5.5" y="5.5" width="8" height="8" rx="1.3"/><path d="M10.5 5.5v-1a1.3 1.3 0 0 0-1.3-1.3H3.8A1.3 1.3 0 0 0 2.5 4.5v5.4a1.3 1.3 0 0 0 1.3 1.3h1"/>',
  link: '<path d="M6.8 9.2a2.6 2.6 0 0 0 3.7 0l2-2a2.6 2.6 0 0 0-3.7-3.7l-.8.8"/><path d="M9.2 6.8a2.6 2.6 0 0 0-3.7 0l-2 2a2.6 2.6 0 0 0 3.7 3.7l.8-.8"/>',
  undo: '<path d="M3 7h7a3.5 3.5 0 0 1 0 7H6.5"/><path d="M5.5 4 2.5 7l3 3"/>',
  redo: '<path d="M13 7H6a3.5 3.5 0 0 0 0 7h3.5"/><path d="M10.5 4l3 3-3 3"/>',
  archive: '<rect x="2" y="3" width="12" height="3.5" rx="1"/><path d="M3.2 6.5v6A1.5 1.5 0 0 0 4.7 14h6.6a1.5 1.5 0 0 0 1.5-1.5v-6M6.5 9.3h3"/>',
  restore: '<path d="M2.8 8a5.2 5.2 0 1 0 1.6-3.7"/><path d="M2.3 3v3h3"/>',
  download: '<path d="M8 2.5v8M4.8 7.5 8 10.7l3.2-3.2M2.5 13h11"/>',
  upload: '<path d="M8 10.7v-8M4.8 5.7 8 2.5l3.2 3.2M2.5 13h11"/>',
  play: '<path d="M5 3.4 12.5 8 5 12.6z"/>',
  pause: '<path d="M5.8 3.5v9M10.2 3.5v9"/>',
  stop: '<rect x="4.5" y="4.5" width="7" height="7" rx="1"/>',

  /* properties */
  flag: '<path d="M3.5 14V2.8M3.5 3.4h8.2l-1.6 2.8 1.6 2.8H3.5"/>',
  clock: '<circle cx="8" cy="8" r="5.6"/><path d="M8 4.8V8l2.2 1.6"/>',
  user: '<circle cx="8" cy="5.6" r="2.6"/><path d="M3 13.4a5 5 0 0 1 10 0"/>',
  users: '<circle cx="6.2" cy="5.8" r="2.3"/><path d="M2 13a4.3 4.3 0 0 1 8.4 0"/><path d="M10.4 3.7a2.3 2.3 0 0 1 0 4.4M11.5 13h2.5a3.6 3.6 0 0 0-2.3-3.4"/>',
  repeat: '<path d="M3 6.2A3.2 3.2 0 0 1 6.2 3h6.3M12.5 3l-2 -2M12.5 3l-2 2"/><path d="M13 9.8A3.2 3.2 0 0 1 9.8 13H3.5M3.5 13l2-2M3.5 13l2 2"/>',
  blocked: '<circle cx="8" cy="8" r="5.6"/><path d="M4 12 12 4"/>',
  chevronRight: '<path d="M6 3.5 10.5 8 6 12.5"/>',
  chevronLeft: '<path d="M10 3.5 5.5 8 10 12.5"/>',
  chevronDown: '<path d="M3.5 6 8 10.5 12.5 6"/>',
  chevronUp: '<path d="M3.5 10 8 5.5 12.5 10"/>',
  arrowUp: '<path d="M8 13V3M8 3 4 7M8 3l4 4"/>',
  arrowDown: '<path d="M8 3v10M8 13l-4-4M8 13l4-4"/>',
  arrowRight: '<path d="M3 8h10M13 8l-4-4M13 8l-4 4"/>',
  subtask: '<path d="M4 2.5v6.2a1.8 1.8 0 0 0 1.8 1.8H12"/><path d="M9.8 8.3 12 10.5l-2.2 2.2"/>',
  attach: '<path d="M12.5 7.5 8 12a3 3 0 0 1-4.2-4.2l5-5a2 2 0 0 1 2.8 2.8l-5 5a1 1 0 0 1-1.4-1.4L9 4.8"/>',
  comment: '<path d="M13.5 8.8a4.7 4.7 0 0 1-4.7 4.7H6l-3.5 2 .9-2.7A4.7 4.7 0 0 1 6 3.5h2.8a4.7 4.7 0 0 1 4.7 4.7z"/>',
  mail: '<rect x="2" y="3.5" width="12" height="9" rx="1.5"/><path d="m2.4 4.5 5.1 4a.8.8 0 0 0 1 0l5.1-4"/>',
  bell: '<path d="M11.8 6.5a3.8 3.8 0 1 0-7.6 0c0 4-1.7 5-1.7 5h11s-1.7-1-1.7-5z"/><path d="M9.2 13.8a1.4 1.4 0 0 1-2.4 0"/>',
  timer: '<circle cx="8" cy="9" r="4.8"/><path d="M8 6.5V9M6.3 1.8h3.4"/>',
  target: '<circle cx="8" cy="8" r="5.6"/><circle cx="8" cy="8" r="2.6"/><circle cx="8" cy="8" r=".6" fill="currentColor" stroke="none"/>',
  sparkle: '<path d="M8 2.2 9.3 6 13 7.3 9.3 8.6 8 12.4 6.7 8.6 3 7.3 6.7 6z"/><path d="M12.6 11.4l.5 1.3 1.3.5-1.3.5-.5 1.3-.5-1.3-1.3-.5 1.3-.5z"/>',

  /* status + feedback */
  circle: '<circle cx="8" cy="8" r="5.6"/>',
  circleDot: '<circle cx="8" cy="8" r="5.6"/><circle cx="8" cy="8" r="2.4" fill="currentColor" stroke="none"/>',
  circleCheck: '<circle cx="8" cy="8" r="5.6"/><path d="M5.5 8.2 7.2 9.9 10.6 6.3"/>',
  info: '<circle cx="8" cy="8" r="5.6"/><path d="M8 7.4v3.4M8 5.4h.01"/>',
  warning: '<path d="M7.1 2.9a1 1 0 0 1 1.8 0l4.6 8.6a1 1 0 0 1-.9 1.5H3.4a1 1 0 0 1-.9-1.5z"/><path d="M8 6.3v3M8 11.2h.01"/>',
  error: '<circle cx="8" cy="8" r="5.6"/><path d="M8 5v3.6M8 10.8h.01"/>',
  offline: '<path d="M2 2l12 12"/><path d="M4.6 8.6a5 5 0 0 1 1.6-1.1M8 4.2a8 8 0 0 1 5.3 2M2.7 6.2a8 8 0 0 1 2.2-1.4M6.4 11a2.4 2.4 0 0 1 3.2 0"/><path d="M8 13.5h.01"/>',
  cloud: '<path d="M4.6 12.5a3 3 0 0 1-.3-6 4 4 0 0 1 7.7-.6 2.8 2.8 0 0 1-.4 6.6z"/>',

  /* misc */
  sun: '<circle cx="8" cy="8" r="3"/><path d="M8 1.5v1.6M8 12.9v1.6M14.5 8h-1.6M3.1 8H1.5M12.6 3.4l-1.1 1.1M4.5 11.5l-1.1 1.1M12.6 12.6l-1.1-1.1M4.5 4.5 3.4 3.4"/>',
  moon: '<path d="M13.3 9.4A5.8 5.8 0 0 1 6.6 2.7a5.8 5.8 0 1 0 6.7 6.7z"/>',
  menu: '<path d="M2.5 4.5h11M2.5 8h11M2.5 11.5h11"/>',
  panel: '<rect x="2" y="3" width="12" height="10" rx="1.5"/><path d="M10 3v10"/>',
  command: '<path d="M5.5 2.5a1.75 1.75 0 1 1 0 3.5h5a1.75 1.75 0 1 1 0-3.5v11a1.75 1.75 0 1 1 0-3.5h-5a1.75 1.75 0 1 1 0 3.5z"/>',
  keyboard: '<rect x="1.5" y="4" width="13" height="8" rx="1.5"/><path d="M4 6.5h.01M6.5 6.5h.01M9 6.5h.01M11.5 6.5h.01M4 9.5h8"/>',
  eye: '<path d="M1.5 8s2.4-4.2 6.5-4.2S14.5 8 14.5 8s-2.4 4.2-6.5 4.2S1.5 8 1.5 8z"/><circle cx="8" cy="8" r="1.8"/>',
  lock: '<rect x="3.5" y="7" width="9" height="6.5" rx="1.4"/><path d="M5.8 7V5.2a2.2 2.2 0 0 1 4.4 0V7"/>',
  logo: '<path d="M2.5 13V3l5.5 6L13.5 3v10"/>',
};

const CACHE = new Map();

/**
 * Render an icon as an SVG string.
 * @param {string} name  key from `paths`
 * @param {object} [opts]  { size, cls, title }
 */
export function icon(name, opts = {}) {
  const d = paths[name];
  if (!d) {
    console.warn(`[miko] unknown icon "${name}"`);
    return '';
  }
  const size = opts.size || 16;
  const cls = opts.cls ? ` class="${opts.cls}"` : '';
  const key = `${name}:${size}:${opts.cls || ''}:${opts.title || ''}`;
  if (CACHE.has(key)) return CACHE.get(key);

  // Decorative by default — icon-only controls carry their label on the button.
  const a11y = opts.title
    ? `role="img" aria-label="${opts.title}"`
    : 'aria-hidden="true" focusable="false"';

  const svg =
    `<svg${cls} width="${size}" height="${size}" viewBox="0 0 16 16" fill="none" ` +
    `stroke="currentColor" stroke-width="1.5" stroke-linecap="round" ` +
    `stroke-linejoin="round" ${a11y}>${d}</svg>`;

  CACHE.set(key, svg);
  return svg;
}

/** Same, as a live DOM node. */
export function iconEl(name, opts) {
  const tpl = document.createElement('template');
  tpl.innerHTML = icon(name, opts);
  return tpl.content.firstElementChild;
}

export function hasIcon(name) {
  return Boolean(paths[name]);
}

export const STATUS_ICON = {
  todo: 'circle',
  in_progress: 'circleDot',
  blocked: 'blocked',
  done: 'circleCheck',
};

export const VIEW_ICON = {
  inbox: 'inbox',
  today: 'today',
  upcoming: 'upcoming',
  list: 'list',
  board: 'board',
  calendar: 'calendar',
  workload: 'workload',
  insights: 'insights',
  focus: 'focus',
  activity: 'activity',
  trash: 'trash',
  settings: 'settings',
  templates: 'templates',
  automations: 'automation',
};

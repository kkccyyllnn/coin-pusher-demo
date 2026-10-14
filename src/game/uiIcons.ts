/** Editable SVG artwork for interface controls. Game symbols keep their pixel atlas. */
export const UI_ICONS = {
  sweep: '<path d="M6 19 25 9l18 10-19 11Z" fill="#fff0df" stroke="#802721" stroke-width="2"/><path d="m6 19 18 11 19-11v9L24 39 6 28Z" fill="currentColor" stroke="#802721" stroke-width="2"/><path d="m12 18 13-6 11 6-12 7Z" fill="#ffb0a1"/><path d="M8 42h27m-4-4 5 4-5 4" stroke="#ffe8d6" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"/>',
  grapple: '<path d="M24 3v12" stroke="#e6f8ff" stroke-width="4"/><path d="M18 12h12v10H18Z" fill="#b9e7ff" stroke="#163d7c" stroke-width="2"/><path d="m18 20-9 8 2 11 8 4 3-6-6-3 1-6 5-3m8-5 9 8-2 11-8 4-3-6 6-3-1-6-5-3" fill="currentColor" stroke="#d8f5ff" stroke-width="2.5" stroke-linejoin="round"/><circle cx="24" cy="21" r="5" fill="#f1fbff" stroke="#2364a6" stroke-width="2"/>',
  reload: '<path d="M11 6h26v8l-7 10v8H18v-8l-7-10Z" fill="currentColor" stroke="#efe2ff" stroke-width="2.5" stroke-linejoin="round"/><path d="M11 12h26M18 25h12" stroke="#e4bdff" stroke-width="2"/><path d="M8 33v8h32v-8M24 28v11m-4-4 4 4 4-4" stroke="#f5eaff" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"/><circle cx="20" cy="10" r="3" fill="#ffe3b0"/><circle cx="28" cy="10" r="3" fill="#ffe3b0"/>',
  boost: '<path d="M5 16h15v16H5Z" fill="currentColor" stroke="#d8fff0" stroke-width="2.5" stroke-linejoin="round"/><path d="M20 21h12v6H20Z" fill="#d8fff0"/><path d="m30 13 13 11-13 11v-8h-5v-6h5Z" fill="#edfff5" stroke="#176f67" stroke-width="2" stroke-linejoin="round"/><path d="M7 10h10M7 38h10" stroke="#b4f6d6" stroke-width="2.5" stroke-linecap="round"/>',
  coin: '<ellipse cx="24" cy="27" rx="18" ry="19" fill="#b57113" stroke="#ffefb7" stroke-width="1.5"/><circle cx="24" cy="23" r="18" fill="#f9be44" stroke="#fff1b8" stroke-width="2"/><circle cx="24" cy="23" r="13" fill="#ffd76b" stroke="#bc8125" stroke-width="2"/><path d="M17 13a12 12 0 0 1 12-2" stroke="#fff6d3" stroke-width="3" stroke-linecap="round"/><path d="M23 16h3v14h-3m-4-10 5-4" stroke="#b77720" stroke-width="2" stroke-linejoin="round"/>',
  pause: '<rect x="10" y="7" width="10" height="34" rx="3" fill="currentColor"/><rect x="28" y="7" width="10" height="34" rx="3" fill="currentColor"/>',
  play: '<path d="m15 8 26 16-26 16Z" fill="currentColor" stroke="currentColor" stroke-width="3" stroke-linejoin="round"/>',
  collection: '<path d="M5 9c8-2 13-1 19 3 6-4 11-5 19-3v29c-8-2-13-1-19 3-6-4-11-5-19-3Z" fill="currentColor" fill-opacity=".15" stroke="currentColor" stroke-width="2.5" stroke-linejoin="round"/><path d="M24 12v29M10 15l9 3m-9 4 9 3m10-7 9-3m-9 10 9-3" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>',
  ticket: '<path d="M7 10h34v9a5 5 0 0 0 0 10v9H7v-9a5 5 0 0 0 0-10Z" fill="currentColor" stroke="#ffe9a5" stroke-width="2" stroke-linejoin="round"/><path d="M15 15h18v18H15Z" fill="#d49324" stroke="#fff1be" stroke-width="1.5"/><path d="m24 17 2.3 4.7 5.2.7-3.8 3.7.9 5.2-4.6-2.5-4.6 2.5.9-5.2-3.8-3.7 5.2-.7Z" fill="#fff0b0"/>',
  event: '<path d="m26 3-17 24h13l-1 18 18-26H26Z" fill="currentColor" stroke="currentColor" stroke-width="2" stroke-linejoin="round"/>',
} as const;

export type UiIconId = keyof typeof UI_ICONS;

export function uiIconMarkup(id: UiIconId): string {
  return `<svg viewBox="0 0 48 48" xmlns="http://www.w3.org/2000/svg" aria-hidden="true" focusable="false">${UI_ICONS[id]}</svg>`;
}

export function mountUiIcons(root: ParentNode = document): void {
  for (const element of root.querySelectorAll<HTMLElement>('[data-ui-icon]')) {
    const id = element.dataset.uiIcon as UiIconId;
    if (id in UI_ICONS) element.innerHTML = uiIconMarkup(id);
  }
}

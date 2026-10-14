import type { CabinetSkin } from './cosmetics';

/** One editable cabinet silhouette, coloured by the same skin table as the real machine. */
export function cabinetPreview(skin: CabinetSkin): SVGSVGElement {
  const { colors, ui } = skin;
  const coins = Array.from({ length: 20 }, (_, i) => {
    const x = 27 + (i % 5) * 16;
    const y = 92 + Math.floor(i / 5) * 5;
    return `<ellipse cx="${x}" cy="${y}" rx="6" ry="2" fill="${ui.coin}" stroke="#a97524" stroke-width=".7"/>`;
  }).join('');
  const wrapper = document.createElement('div');
  wrapper.innerHTML = `<svg class="cabinet-preview" data-cabinet-preview="${skin.id}" viewBox="0 0 120 140" xmlns="http://www.w3.org/2000/svg" aria-hidden="true" focusable="false">
    <path data-role="panel" d="M18 20h84v68l11 23H7l11-23Z" fill="${colors.panel}" stroke="${ui.edge}" stroke-width="2"/>
    <path data-role="trim" d="M17 6h86l5 15H12Z" fill="${colors.trim}" stroke="${ui.edge}" stroke-width="2"/>
    <rect x="21" y="9" width="78" height="10" rx="2" fill="${ui.panel}"/>
    <path data-ui-token="secondary" d="M24 12h29v3H24ZM18 26h3v47h-3Z" fill="${ui.secondary}"/>
    <path data-ui-token="accent" d="M66 12h27v3H66ZM99 26h3v47h-3Z" fill="${ui.accent}"/>
    <g fill="${ui.reward}" stroke="${ui.edge}" stroke-width="1"><rect x="28" y="28" width="14" height="20" rx="2"/><rect x="45" y="28" width="14" height="20" rx="2"/><rect x="62" y="28" width="14" height="20" rx="2"/><rect x="79" y="28" width="14" height="20" rx="2"/></g>
    <path data-role="pusherTop" d="M25 65h70l4 15H21Z" fill="${colors.pusherTop}" stroke="${ui.edge}" stroke-width="1"/>
    <path data-role="pusherFace" d="M21 80h78v8H21Z" fill="${colors.pusherFace}" stroke="${ui.edge}" stroke-width="1"/>
    <path data-role="floor" d="M21 88h78l12 24H9Z" fill="${colors.floor}"/>
    ${coins}
    <path data-role="rail" d="M17 79h4L9 112H5Zm82 0h4l12 33h-4ZM6 112h108v6H6Z" fill="${colors.rail}" stroke="${ui.edge}" stroke-width="1"/>
    <path d="M10 118h100l-3 15H13Z" fill="${colors.panel}" stroke="${ui.edge}" stroke-width="1.5"/>
    <rect x="21" y="120" width="78" height="4" rx="1" fill="${ui.panel}"/>
  </svg>`;
  return wrapper.firstElementChild as SVGSVGElement;
}

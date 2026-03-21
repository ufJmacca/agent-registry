const svgAttributes =
  'viewBox="0 0 64 64" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true" focusable="false"';

export function renderConsoleMark(): string {
  return `<svg class="console-mark" ${svgAttributes}>
    <rect x="10" y="10" width="44" height="44" rx="18" fill="currentColor" fill-opacity="0.08" />
    <path d="M21 39.5L32 19l11 20.5" stroke="currentColor" stroke-width="3.5" stroke-linecap="round" stroke-linejoin="round" />
    <path d="M25.5 33h13" stroke="currentColor" stroke-width="3.5" stroke-linecap="round" />
    <circle cx="32" cy="44" r="2.5" fill="currentColor" />
  </svg>`;
}

export function renderStatusMark(): string {
  return `<svg class="console-status-mark" ${svgAttributes}>
    <rect x="8" y="8" width="48" height="48" rx="20" fill="currentColor" fill-opacity="0.08" />
    <path d="M32 20v14" stroke="currentColor" stroke-width="3.5" stroke-linecap="round" />
    <circle cx="32" cy="42" r="2.75" fill="currentColor" />
    <path d="M20 50c5-5.333 12-8 12-8s7 2.667 12 8" stroke="currentColor" stroke-width="3" stroke-linecap="round" opacity="0.48" />
  </svg>`;
}

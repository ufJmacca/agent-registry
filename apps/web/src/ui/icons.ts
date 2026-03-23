function escapeAttribute(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

const iconSymbols = {
  "arrow-right": `<symbol id="icon-arrow-right" viewBox="0 0 24 24">
    <path d="M5 12h14" />
    <path d="m12 5 7 7-7 7" />
  </symbol>`,
  console: `<symbol id="icon-console" viewBox="0 0 24 24">
    <rect x="3.5" y="4.5" width="17" height="15" rx="3" />
    <path d="M8 9h8" />
    <path d="M8 13h4" />
    <path d="M15.5 13h.01" />
  </symbol>`,
  "sign-out": `<symbol id="icon-sign-out" viewBox="0 0 24 24">
    <path d="M14 7V5.75A2.75 2.75 0 0 0 11.25 3h-4.5A2.75 2.75 0 0 0 4 5.75v12.5A2.75 2.75 0 0 0 6.75 21h4.5A2.75 2.75 0 0 0 14 18.25V17" />
    <path d="M10 12h10" />
    <path d="m17 8 3.5 4L17 16" />
  </symbol>`,
} as const;

export type IconName = keyof typeof iconSymbols;

export function renderIconSpriteSheet(): string {
  return `<svg xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
    <defs>
      ${Object.values(iconSymbols).join("")}
    </defs>
  </svg>`;
}

export function renderIcon(
  name: IconName,
  options: {
    className?: string;
    title?: string;
  } = {},
): string {
  const className = options.className ?? "icon";
  const title = options.title;

  if (title === undefined) {
    return `<svg class="${escapeAttribute(className)}" aria-hidden="true">
      <use href="/assets/icons.svg#icon-${escapeAttribute(name)}"></use>
    </svg>`;
  }

  return `<svg class="${escapeAttribute(className)}" role="img" aria-label="${escapeAttribute(title)}">
    <use href="/assets/icons.svg#icon-${escapeAttribute(name)}"></use>
  </svg>`;
}

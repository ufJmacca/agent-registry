import { escapeHtml } from "../document.js";

import { joinClassNames, renderAttributes, type PrimitiveAttributes } from "./_shared.js";

type SurfaceTag = "article" | "aside" | "div" | "section";
type HeadingTag = "h1" | "h2" | "h3";

interface SectionFrameOptions {
  as?: SurfaceTag;
  attributes?: PrimitiveAttributes;
  body: string;
  className?: string;
  description?: string;
  eyebrow: string;
  headerClassName?: string;
  headerContent?: string;
  leadClassName?: string;
  title: string;
  titleTag?: HeadingTag;
}

interface PageHeroOptions {
  attributes?: PrimitiveAttributes;
  body: string;
  className?: string;
}

interface CardHeadOptions {
  className?: string;
  description?: string;
  eyebrow: string;
  leadClassName?: string;
  title: string;
  titleTag?: "h2" | "h3";
  trailingContent?: string;
}

interface StatTileOptions {
  as?: "article" | "div";
  className?: string;
  description?: string;
  descriptionMarkup?: string;
  eyebrow: string;
  includeBaseClass?: boolean;
  value?: string;
  valueMarkup?: string;
}

interface ActionClusterOptions {
  actions: string[];
  attributes?: PrimitiveAttributes;
  className?: string;
}

interface RecordListOptions {
  attributes?: PrimitiveAttributes;
  emptyState?: string;
  items: string[];
  listClassName?: string;
  wrapperTag?: "div" | "section";
}

interface EmptyStateOptions {
  as?: "article" | "div" | "section";
  body: string;
  className?: string;
  eyebrow: string;
  meta?: string;
  title: string;
  titleTag?: "h2" | "h3";
}

interface SidePanelOptions {
  as?: "aside" | "div";
  attributes?: PrimitiveAttributes;
  className?: string;
  sections: string[];
}

interface PillOptions {
  attributes?: PrimitiveAttributes;
  className?: string;
  href?: string;
}

export function renderPill(label: string, options: PillOptions = {}): string {
  const tag = options.href === undefined ? "span" : "a";

  return `<${tag}${renderAttributes({
    class: joinClassNames("pill", options.className),
    href: options.href,
    ...options.attributes,
  })}>${escapeHtml(label)}</${tag}>`;
}

export function renderPillList(values: string[], options: { emptyLabel?: string } = {}): string {
  if (values.length === 0) {
    return renderPill(options.emptyLabel ?? "none");
  }

  return values.map((value) => renderPill(value)).join("");
}

export function renderPageHero(options: PageHeroOptions): string {
  return `<section${renderAttributes({
    class: joinClassNames("page-hero", options.className),
    ...options.attributes,
  })}>${options.body}</section>`;
}

export function renderCardHead(options: CardHeadOptions): string {
  const titleTag = options.titleTag ?? "h2";

  return `<div${renderAttributes({
    class: joinClassNames("card-head", options.className),
  })}>
    <div${renderAttributes({
      class: joinClassNames("card-head__lead", "stack", options.leadClassName),
    })}>
      <span class="shell-eyebrow">${escapeHtml(options.eyebrow)}</span>
      <${titleTag}>${escapeHtml(options.title)}</${titleTag}>
      ${
        options.description === undefined
          ? ""
          : `<p class="meta">${escapeHtml(options.description)}</p>`
      }
    </div>
    ${options.trailingContent ?? ""}
  </div>`;
}

export function renderSectionFrame(options: SectionFrameOptions): string {
  const tag = options.as ?? "section";
  const titleTag = options.titleTag ?? "h2";

  return `<${tag}${renderAttributes({
    class: joinClassNames("section-frame", options.className),
    ...options.attributes,
  })}>
    <div${renderAttributes({
      class: joinClassNames("section-frame__header", options.headerClassName),
    })}>
      <div${renderAttributes({
        class: joinClassNames("section-frame__lead", "stack", options.leadClassName),
      })}>
        <span class="shell-eyebrow">${escapeHtml(options.eyebrow)}</span>
        <${titleTag}>${escapeHtml(options.title)}</${titleTag}>
        ${
          options.description === undefined
            ? ""
            : `<p class="meta">${escapeHtml(options.description)}</p>`
        }
      </div>
      ${options.headerContent ?? ""}
    </div>
    ${options.body}
  </${tag}>`;
}

export function renderStatTile(options: StatTileOptions): string {
  const tag = options.as ?? "div";

  return `<${tag}${renderAttributes({
    class: joinClassNames(
      options.includeBaseClass === false ? undefined : "stat-tile",
      options.className,
    ),
  })}>
    <span class="shell-eyebrow">${escapeHtml(options.eyebrow)}</span>
    <strong>${options.valueMarkup ?? escapeHtml(options.value ?? "")}</strong>
    ${
      options.descriptionMarkup !== undefined
        ? options.descriptionMarkup
        : options.description === undefined
          ? ""
          : `<p>${escapeHtml(options.description)}</p>`
    }
  </${tag}>`;
}

export function renderActionCluster(options: ActionClusterOptions): string {
  return `<div${renderAttributes({
    class: joinClassNames("action-cluster", "inline-actions", options.className),
    ...options.attributes,
  })}>${options.actions.join("")}</div>`;
}

export function renderRecordList(options: RecordListOptions): string {
  const tag = options.wrapperTag ?? "div";

  return `<${tag}${renderAttributes({
    class: joinClassNames(options.listClassName ?? "record-list"),
    ...options.attributes,
  })}>${options.items.length === 0 ? (options.emptyState ?? "") : options.items.join("")}</${tag}>`;
}

export function renderEmptyState(options: EmptyStateOptions): string {
  const tag = options.as ?? "div";
  const titleTag = options.titleTag ?? "h3";

  return `<${tag}${renderAttributes({
    class: joinClassNames("empty-state", "stack", options.className),
  })}>
    <span class="shell-eyebrow">${escapeHtml(options.eyebrow)}</span>
    <${titleTag}>${escapeHtml(options.title)}</${titleTag}>
    <p>${escapeHtml(options.body)}</p>
    ${options.meta === undefined ? "" : `<p class="meta">${escapeHtml(options.meta)}</p>`}
  </${tag}>`;
}

export function renderSidePanel(options: SidePanelOptions): string {
  const tag = options.as ?? "div";

  return `<${tag}${renderAttributes({
    class: joinClassNames("side-panel", options.className),
    ...options.attributes,
  })}>${options.sections.join("")}</${tag}>`;
}

import type { ServerResponse } from "node:http";

import { renderConsoleMark, renderStatusMark } from "./icons.js";

export interface HtmlDocumentOptions {
  body: string;
  chromeLabel?: string;
  chromeMeta?: string;
  pageClassName?: string;
  title: string;
}

export interface StatusPageOptions {
  linkHref?: string;
  linkLabel?: string;
  message: string;
  statusCode: number;
  title?: string;
}

function escapeHtml(value: unknown): string {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function joinClassNames(...values: Array<string | undefined>): string {
  return values.filter((value) => value !== undefined && value !== "").join(" ");
}

export function renderHtmlDocument(options: HtmlDocumentOptions): string {
  const pageClassName = joinClassNames("console-page", options.pageClassName);

  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <meta name="color-scheme" content="light" />
    <title>${escapeHtml(options.title)}</title>
    <link rel="preload" href="/assets/fonts/inter-variable.woff2" as="font" type="font/woff2" />
    <link rel="preload" href="/assets/fonts/manrope-variable.woff2" as="font" type="font/woff2" />
    <link rel="stylesheet" href="/assets/console.css" />
  </head>
  <body class="console-document" data-console-document="true">
    <div class="console-aura console-aura--primary" aria-hidden="true"></div>
    <div class="console-aura console-aura--secondary" aria-hidden="true"></div>
    <main class="console-main">
      <div class="console-shell">
        <header class="console-chrome">
          <div class="console-brand">
            ${renderConsoleMark()}
            <div class="console-brand-copy">
              <p class="console-kicker">${escapeHtml(options.chromeLabel ?? "Agent Registry Console")}</p>
              <p class="console-product">${escapeHtml(options.chromeMeta ?? "Technical Curator Foundation")}</p>
            </div>
          </div>
        </header>
        <div class="${pageClassName}">
          ${options.body}
        </div>
      </div>
    </main>
  </body>
</html>`;
}

export function writeHtmlDocument(
  response: ServerResponse,
  statusCode: number,
  options: HtmlDocumentOptions,
  headers: Record<string, string> = {},
): void {
  response.writeHead(statusCode, {
    "content-type": "text/html; charset=utf-8",
    ...headers,
  });
  response.end(renderHtmlDocument(options));
}

export function renderStatusPage(options: StatusPageOptions): string {
  return `<section class="console-status card stack">
    <div class="console-status__header">
      <div class="console-status__icon">
        ${renderStatusMark()}
      </div>
      <div class="stack">
        <p class="console-kicker">HTTP ${options.statusCode}</p>
        <h1>${escapeHtml(options.title ?? "Console Error")}</h1>
      </div>
    </div>
    <p>${escapeHtml(options.message)}</p>
    <div class="inline-actions">
      <a class="pill" href="${escapeHtml(options.linkHref ?? "/")}">${escapeHtml(options.linkLabel ?? "Return to sign-in")}</a>
    </div>
  </section>`;
}

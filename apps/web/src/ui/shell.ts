import type { ServerResponse } from "node:http";

import { writeHtmlDocument } from "./document.js";
import { renderConsoleMark } from "./icons.js";

export interface ShellNavigationItem {
  current?: boolean;
  href: string;
  label: string;
}

export interface PublicShellOptions {
  body: string;
  pageId: string;
  title: string;
}

export interface AuthenticatedShellOptions {
  body: string;
  navigation: ShellNavigationItem[];
  pageId: string;
  roles: string[];
  subjectId: string;
  tenantId: string;
  tenantLabel?: string;
  title: string;
}

function escapeHtml(value: unknown): string {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function renderBrand(copy: { kicker: string; meta: string }): string {
  return `<div class="console-brand">
    ${renderConsoleMark()}
    <div class="console-brand-copy">
      <p class="console-kicker">${escapeHtml(copy.kicker)}</p>
      <p class="console-product">${escapeHtml(copy.meta)}</p>
    </div>
  </div>`;
}

function renderNavigation(items: ShellNavigationItem[]): string {
  return items
    .map(
      (item) =>
        `<a class="console-nav__link" href="${escapeHtml(item.href)}"${item.current ? ' aria-current="page"' : ""}>${escapeHtml(item.label)}</a>`,
    )
    .join("");
}

export function writePublicShell(
  response: ServerResponse,
  statusCode: number,
  options: PublicShellOptions,
  headers: Record<string, string> = {},
): void {
  const landingActions =
    options.pageId === "sign-in"
      ? `<div class="console-public-topbar__actions">
           <a class="console-public-topbar__link" href="#setup-state">Setup State</a>
           <a class="console-public-topbar__cta" href="#registry-access">Console Access</a>
         </div>`
      : "";

  writeHtmlDocument(
    response,
    statusCode,
    {
      body: `<section class="console-public-shell" data-shell="public" data-page="${escapeHtml(options.pageId)}">
        <header class="console-public-topbar">
          ${renderBrand({
            kicker: "Agent Registry Console",
            meta: "Technical Curator Foundation",
          })}
          ${landingActions}
        </header>
        <div class="console-public-hero stack">
          <p class="console-kicker">Public Entry</p>
          <h1>Architectural Precision</h1>
          <p class="meta">Securely access the Technical Curator Registry. Manage, validate, and deploy high-performance intelligence agents with an editorial eye for technical detail.</p>
        </div>
        <div class="console-public-stage">
          ${options.body}
        </div>
      </section>`,
      pageClassName: "console-page--public",
      title: options.title,
    },
    headers,
  );
}

export function writeAuthenticatedShell(
  response: ServerResponse,
  statusCode: number,
  options: AuthenticatedShellOptions,
  headers: Record<string, string> = {},
): void {
  const tenantLabel = options.tenantLabel ?? options.tenantId;

  writeHtmlDocument(
    response,
    statusCode,
    {
      body: `<section class="console-auth-shell" data-shell="authenticated" data-page="${escapeHtml(options.pageId)}">
        <header class="console-topbar">
          ${renderBrand({
            kicker: "Agent Registry Console",
            meta: "Technical Curator Foundation",
          })}
          <div class="console-topbar__actions">
            <div class="console-session-summary" data-visual-mask="true">
              <p class="console-kicker">Tenant Context</p>
              <p class="console-session-summary__title">${escapeHtml(tenantLabel)}</p>
              <p class="console-session-summary__meta">${escapeHtml(options.tenantId)} · ${escapeHtml(options.subjectId)} · ${escapeHtml(options.roles.join(", ") || "no roles")}</p>
            </div>
            <form class="console-signout" action="/session/logout" method="post">
              <button class="button-secondary" type="submit">Sign Out</button>
            </form>
          </div>
        </header>
        <div class="console-workspace">
          <nav class="console-nav" aria-label="Primary navigation">
            <div class="console-nav__group">
              ${renderNavigation(options.navigation)}
            </div>
          </nav>
          <div class="console-content">
            ${options.body}
          </div>
        </div>
      </section>`,
      title: options.title,
    },
    headers,
  );
}

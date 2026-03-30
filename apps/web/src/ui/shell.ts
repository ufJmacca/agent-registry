import type { ResolvedPrincipal } from "@agent-registry/auth";

import { escapeHtml } from "./document.js";

export interface ShellNavItem {
  current?: boolean;
  href: string;
  label: string;
}

interface PublicShellOptions {
  body: string;
  page: string;
}

interface AuthenticatedShellOptions {
  body: string;
  navItems: ShellNavItem[];
  page: string;
  principal: Pick<ResolvedPrincipal, "roles" | "subjectId" | "tenantId">;
  tenantLabel?: string;
}

function renderShellNav(navItems: ShellNavItem[], variant: "mobile" | "rail"): string {
  return `<nav class="shell-nav shell-nav--${variant}" data-nav="${variant}" aria-label="Primary navigation">
    ${navItems
      .map(
        (item) =>
          `<a class="shell-nav__link${item.current ? " is-current" : ""}" href="${escapeHtml(item.href)}"${item.current ? ' aria-current="page"' : ""}>${escapeHtml(item.label)}</a>`,
      )
      .join("")}
  </nav>`;
}

export function renderPublicShell(options: PublicShellOptions): string {
  return `<div class="app-shell app-shell--public" data-shell="public" data-page="${escapeHtml(options.page)}">
    <header class="public-topbar">
      <div class="public-topbar__inner">
        <div class="public-topbar__brand">
          <a class="shell-brand__mark" href="/">Technical Curator</a>
          <p class="public-topbar__copy">Architectural precision for truthful agent operations.</p>
        </div>
        <nav class="public-topbar__nav" aria-label="Public sections">
          <a class="public-topbar__nav-link" href="#sign-in-hero">Overview</a>
          <a class="public-topbar__nav-link" href="#sign-in-companion">Setup</a>
        </nav>
        <div class="public-topbar__actions">
          <a class="public-topbar__action" href="#sign-in-access">Access</a>
          <a class="public-topbar__cta" href="/console">Console</a>
        </div>
      </div>
    </header>
    <div class="public-canvas">
      ${options.body}
    </div>
    <footer class="public-footer">
      <div class="public-footer__inner">
        <p class="public-footer__copy">© 2026 Technical Curator Registry. Architectural Precision.</p>
        <div class="public-footer__links">
          <a class="public-footer__link" href="#sign-in-access">Registry Access</a>
          <a class="public-footer__link" href="#sign-in-companion">Setup Status</a>
          <a class="public-footer__link" href="/console">Console</a>
        </div>
      </div>
    </footer>
  </div>`;
}

export function renderAuthenticatedShell(options: AuthenticatedShellOptions): string {
  const tenantLabel = options.tenantLabel ?? options.principal.tenantId;
  const roleLabel = options.principal.roles.join(", ") || "no roles";

  return `<div class="app-shell app-shell--authenticated" data-shell="authenticated" data-page="${escapeHtml(options.page)}">
    <header class="shell-topbar">
      <div class="shell-topbar__inner">
        <div class="shell-brand">
          <a class="shell-brand__mark" href="/console">Technical Curator</a>
          <div class="shell-brand__meta">
            <span class="shell-eyebrow">Tenant Workspace</span>
            <strong>${escapeHtml(tenantLabel)}</strong>
          </div>
        </div>
        <div class="shell-session" data-visual-dynamic="session-context">
          <div class="shell-session__copy">
            <span class="shell-eyebrow">Signed In</span>
            <p><strong>${escapeHtml(options.principal.subjectId)}</strong> · ${escapeHtml(roleLabel)}</p>
          </div>
          <form class="shell-logout" action="/session/logout" method="post">
            <button class="button-secondary" type="submit">Sign Out</button>
          </form>
        </div>
      </div>
    </header>
    <div class="shell-frame">
      <aside class="shell-rail">
        ${renderShellNav(options.navItems, "rail")}
      </aside>
      <div class="shell-canvas">
        <div class="shell-mobile-nav">
          ${renderShellNav(options.navItems, "mobile")}
        </div>
        <div class="shell-content">
          ${options.body}
        </div>
      </div>
    </div>
  </div>`;
}

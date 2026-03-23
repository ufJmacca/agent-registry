import { escapeHtml } from "../document.js";

export interface SignInMembershipOption {
  roles: string[];
  subjectId: string;
}

export interface SignInTenantOption {
  displayName: string;
  memberships: SignInMembershipOption[];
  tenantId: string;
}

interface SignInLandingOptions {
  accessPanel: string;
  companionPanel: string;
  emphasizeSetup: boolean;
}

interface SetupPendingOptions {
  accessDetail: string;
  accessMeta: string;
  companionBadges: string[];
  companionBody: string;
  companionTitle: string;
}

interface InteractiveSignInOptions {
  deploymentMode: "hosted" | "self-hosted";
  selectedTenant: SignInTenantOption;
  selfHostedTenant: SignInTenantOption;
  tenants: SignInTenantOption[];
}

function renderSignInLanding(options: SignInLandingOptions): string {
  const primaryPanel = options.emphasizeSetup ? options.companionPanel : options.accessPanel;
  const secondaryPanel = options.emphasizeSetup ? options.accessPanel : options.companionPanel;

  return `<div class="sign-in-landing">
    <section class="public-hero sign-in-hero card stack" data-visual-dynamic="sign-in-hero">
      <span class="shell-eyebrow">Agent Registry Console</span>
      <h1>Architectural Precision For Tenant Operations</h1>
      <p class="meta">Securely access the current console for truthful draft, review, environment, and active agent workflows inside the shared technical curator shell.</p>
    </section>
    <section class="public-grid sign-in-stage">
      <div class="stack sign-in-stage__primary">
        ${primaryPanel}
      </div>
      <div class="stack sign-in-stage__secondary">
        ${secondaryPanel}
      </div>
    </section>
  </div>`;
}

function renderStatusTiles(values: Array<{ label: string; value: string }>): string {
  return `<div class="sign-in-status-grid">
    ${values
      .map(
        (value) => `<div class="sign-in-status">
          <span class="shell-eyebrow">${escapeHtml(value.label)}</span>
          <strong>${escapeHtml(value.value)}</strong>
        </div>`,
      )
      .join("")}
  </div>`;
}

function renderSetupPendingPanel(options: SetupPendingOptions): string {
  return renderSignInLanding({
    accessPanel: `<section class="card stack sign-in-access sign-in-access--pending" data-visual-dynamic="sign-in-access">
      <span class="shell-eyebrow">Registry Access</span>
      <h2>Console Setup Pending</h2>
      <p>${escapeHtml(options.accessDetail)}</p>
      <p class="meta">${escapeHtml(options.accessMeta)}</p>
    </section>`,
    companionPanel: `<section class="card stack public-companion sign-in-companion" data-visual-dynamic="sign-in-companion">
      <div class="sign-in-companion__lead stack">
        <span class="sign-in-companion__index" aria-hidden="true">01</span>
        <span class="shell-eyebrow">Setup Status</span>
        <h2>${escapeHtml(options.companionTitle)}</h2>
        <p>${escapeHtml(options.companionBody)}</p>
      </div>
      <div class="sign-in-pill-row">
        ${options.companionBadges
          .map((badge) => `<div class="pill">${escapeHtml(badge)}</div>`)
          .join("")}
      </div>
    </section>`,
    emphasizeSetup: true,
  });
}

function renderHostedTenantOptions(
  tenants: SignInTenantOption[],
  selectedTenantId: string,
): string {
  return tenants
    .map(
      (tenant) =>
        `<option value="${escapeHtml(tenant.tenantId)}"${tenant.tenantId === selectedTenantId ? " selected" : ""}>${escapeHtml(tenant.displayName)} (${escapeHtml(tenant.tenantId)})</option>`,
    )
    .join("");
}

function renderSubjectOptions(tenant: SignInTenantOption): string {
  const options = tenant.memberships
    .map(
      (membership) =>
        `<option value="${escapeHtml(membership.subjectId)}">${escapeHtml(membership.subjectId)} [${escapeHtml(membership.roles.join(", ") || "no roles")}]</option>`,
    )
    .join("");

  if (options !== "") {
    return options;
  }

  return `<option value="" disabled selected>No memberships available for ${escapeHtml(tenant.displayName)}</option>`;
}

export function renderMissingSchemaSignInPage(): string {
  return renderSetupPendingPanel({
    accessDetail:
      "Registry access will become available after migrations and bootstrap data are loaded.",
    accessMeta:
      "The sign-in flow is intentionally withheld until the console can resolve truthful tenant memberships.",
    companionBadges: ["Schema missing", "Bootstrap required"],
    companionBody: "Run migrations and load bootstrap tenant data to enable console sign-in.",
    companionTitle: "Initialize The Console",
  });
}

export function renderMissingBootstrapSignInPage(): string {
  return renderSetupPendingPanel({
    accessDetail:
      "Sign-in will appear after at least one tenant and membership set has been bootstrapped.",
    accessMeta: "No internal bootstrap details are exposed here.",
    companionBadges: ["No tenants", "No memberships"],
    companionBody: "Bootstrap tenant and membership data to enable console sign-in.",
    companionTitle: "Bootstrap Tenant Data",
  });
}

export function renderInteractiveSignInPage(options: InteractiveSignInOptions): string {
  const visibleTenant =
    options.deploymentMode === "hosted" ? options.selectedTenant : options.selfHostedTenant;

  return renderSignInLanding({
    accessPanel: `<section class="card stack sign-in-access" data-visual-dynamic="sign-in-access">
      <div class="stack sign-in-panel__intro">
        <span class="shell-eyebrow">Registry Access</span>
        <h2>Mock Sign-In</h2>
        <p class="meta">Use truthful tenant memberships to enter the current console without changing any existing sign-in behavior.</p>
      </div>
      <form class="stack sign-in-form" action="/session" method="post">
        ${
          options.deploymentMode === "self-hosted"
            ? `<div class="stack sign-in-field sign-in-field--collapsed">
              <span class="sign-in-field__label">Tenant</span>
              <input type="hidden" name="tenantId" value="${escapeHtml(options.selfHostedTenant.tenantId)}" />
              <p class="sign-in-inline-copy">Single-tenant deployment</p>
              <p class="sign-in-tenant-summary"><strong>${escapeHtml(options.selfHostedTenant.displayName)}</strong> (${escapeHtml(options.selfHostedTenant.tenantId)})</p>
            </div>`
            : `<label class="stack sign-in-field">
              <span class="sign-in-field__label">Tenant</span>
              <select name="tenantId" onchange="window.location='/?tenantId='+encodeURIComponent(this.value)">
                ${renderHostedTenantOptions(options.tenants, options.selectedTenant.tenantId)}
              </select>
            </label>`
        }
        <label class="stack sign-in-field">
          <span class="sign-in-field__label">Subject</span>
          <select name="subjectId">
            ${renderSubjectOptions(visibleTenant)}
          </select>
        </label>
        <button type="submit">Sign In</button>
      </form>
      <p class="meta sign-in-note">The existing /session POST target and tenantId and subjectId fields remain unchanged.</p>
    </section>`,
    companionPanel: `<section class="card stack public-companion sign-in-companion" data-visual-dynamic="sign-in-companion">
      <div class="sign-in-companion__lead stack">
        <span class="sign-in-companion__index" aria-hidden="true">01</span>
        <span class="shell-eyebrow">Workspace State</span>
        <h2>${escapeHtml(visibleTenant.displayName)}</h2>
        <p>Current deployment mode: <strong>${escapeHtml(options.deploymentMode)}</strong>.</p>
      </div>
      ${renderStatusTiles([
        { label: "Tenant", value: visibleTenant.tenantId },
        { label: "Memberships", value: String(visibleTenant.memberships.length) },
        { label: "Selection", value: options.deploymentMode === "hosted" ? "Hosted switcher" : "Collapsed tenant" },
      ])}
      <p class="meta">Hosted tenant switching and self-hosted membership collapse continue to follow the existing console rules.</p>
    </section>`,
    emphasizeSetup: false,
  });
}

import { escapeHtml } from "../document.js";

interface EnvironmentManagementPageOptions {
  environmentKeys: string[];
  tenantId: string;
}

function renderEnvironmentForm(tenantId: string): string {
  return `<form class="environment-form" action="/tenants/${encodeURIComponent(tenantId)}/environments" method="post">
    <div class="environment-form__intro">
      <p>Register one environment key at a time so new publication targets appear without changing the existing environment flow.</p>
    </div>
    <label>Environment key
      <input name="environmentKey" placeholder="qa" />
    </label>
    <div class="environment-form__actions">
      <button type="submit">Add Environment</button>
      <p class="meta">Use short stable keys such as <code>qa</code>, <code>staging</code>, or <code>prod</code>.</p>
    </div>
  </form>`;
}

function renderEnvironmentInventory(
  environmentKeys: string[],
  state: "empty" | "populated",
): string {
  if (state === "empty") {
    return `<div class="environment-list" data-visual-dynamic="environment-list">
      <div class="environment-empty">
        <p>No environments have been configured yet.</p>
        <p class="meta">Add an environment to unlock publication targeting for this tenant.</p>
      </div>
    </div>`;
  }

  return `<div class="environment-list" data-visual-dynamic="environment-list">
    ${environmentKeys
      .map(
        (environmentKey, index) => `<article class="environment-entry">
          <div class="environment-entry__meta">
            <span class="shell-eyebrow">Environment ${String(index + 1).padStart(2, "0")}</span>
            <span class="pill">Tenant publication target</span>
          </div>
          <h3>${escapeHtml(environmentKey)}</h3>
          <p class="meta">Registered for truthful draft publication targeting and tenant operations.</p>
        </article>`,
      )
      .join("")}
  </div>`;
}

export function renderEnvironmentManagementPage(
  options: EnvironmentManagementPageOptions,
): string {
  const state = options.environmentKeys.length === 0 ? "empty" : "populated";

  return `<div class="environment-page" data-environment-layout="management" data-environment-state="${state}">
    <section class="hero card stack page-hero environment-hero">
      <span class="shell-eyebrow">Tenant Operations</span>
      <h1>Environment Management</h1>
      <div class="environment-hero__meta">
        <p class="meta">Tenant ${escapeHtml(options.tenantId)}</p>
        <span class="pill">${options.environmentKeys.length} configured</span>
      </div>
      <p>Configured environments stay primary, while creation remains a secondary panel that preserves the existing POST target and redirect behavior.</p>
    </section>
    <section class="environment-layout">
      <section class="card stack environment-panel environment-panel--inventory" data-environment-panel="inventory" data-environment-state="${state}">
        <div class="environment-panel__header">
          <span class="shell-eyebrow">Configured Inventory</span>
          <h2>Configured Environments</h2>
          <p class="meta">Use this tenant record as the source of truth for where versions can be published.</p>
        </div>
        ${renderEnvironmentInventory(options.environmentKeys, state)}
      </section>
      <aside class="card stack environment-panel environment-panel--creation" data-environment-panel="creation">
        <div class="environment-panel__header">
          <span class="shell-eyebrow">Secondary Action</span>
          <h2>Add Environment</h2>
          <p class="meta">Create a new environment key without changing field names, POST targets, or redirect behavior.</p>
        </div>
        ${renderEnvironmentForm(options.tenantId)}
      </aside>
    </section>
  </div>`;
}

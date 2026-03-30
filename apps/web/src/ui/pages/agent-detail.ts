import type { AgentAdminDetailRecord } from "@agent-registry/db";

import { escapeHtml } from "../document.js";
import { formatConsoleState } from "../primitives/index.js";

interface AgentDetailPageOptions {
  detail: AgentAdminDetailRecord;
  tenantId: string;
}

function renderOverlaySummary(
  label: string,
  overlay: {
    deprecated: boolean;
    disabled: boolean;
    requiredRoles: string[];
    requiredScopes: string[];
  },
): string {
  return `<article class="agent-detail-overlay-card stack">
    <h3>${escapeHtml(label)}</h3>
    <p>Deprecated: ${overlay.deprecated ? "yes" : "no"}</p>
    <p>Disabled: ${overlay.disabled ? "yes" : "no"}</p>
    <p>Required roles: ${escapeHtml(overlay.requiredRoles.join(", ") || "none")}</p>
    <p>Required scopes: ${escapeHtml(overlay.requiredScopes.join(", ") || "none")}</p>
  </article>`;
}

export function renderAgentDetailPage(options: AgentDetailPageOptions): string {
  const { detail, tenantId } = options;
  const activePublicationMarkup =
    detail.activeVersion === null
      ? `<div class="agent-detail-empty stack">
           <p>No active approved version is currently published.</p>
           <p class="meta">Approve a version to expose truthful publication health, endpoints, and per-environment controls.</p>
         </div>`
      : `<div class="agent-detail-publication-list">
           ${detail.activeVersion.publications
             .map(
               (publication) =>
                 `<article class="agent-detail-publication-card stack">
                   <div class="agent-detail-card-head">
                     <div class="stack">
                       <span class="shell-eyebrow">Environment Publication</span>
                       <h3>${escapeHtml(publication.environmentKey)}</h3>
                     </div>
                     <div class="pill">${escapeHtml(publication.healthStatus ?? "unknown")}</div>
                   </div>
                   <p class="meta">Version ${detail.activeVersion?.versionSequence ?? "n/a"} · ${escapeHtml(formatConsoleState(detail.activeVersion?.approvalState ?? "unknown"))}</p>
                   <p>Health endpoint: <code>${escapeHtml(publication.healthEndpointUrl)}</code></p>
                 </article>`,
             )
             .join("")}
         </div>`;
  const environmentControlMarkup =
    detail.activeVersion === null
      ? `<div class="agent-detail-empty stack">
           <p>No environment overlays can be applied until an approved version is active.</p>
           <p class="meta">Version history remains available while approval is pending.</p>
         </div>`
      : `<div class="agent-detail-control-list">
           ${detail.activeVersion.publications
             .map(
               (publication) =>
                 `<article class="agent-detail-control-card stack">
                   <div class="agent-detail-card-head">
                     <div class="stack">
                       <span class="shell-eyebrow">Environment Controls</span>
                       <h3>${escapeHtml(publication.environmentKey)}</h3>
                     </div>
                     <div class="pill">Health ${escapeHtml(publication.healthStatus ?? "unknown")}</div>
                   </div>
                   <p>Health endpoint: <code>${escapeHtml(publication.healthEndpointUrl)}</code></p>
                   <div class="inline-actions">
                     <form action="/tenants/${encodeURIComponent(tenantId)}/agents/${encodeURIComponent(detail.agentId)}/environments/${encodeURIComponent(publication.environmentKey)}/overlay/deprecate" method="post">
                       <button type="submit">Deprecate Environment</button>
                     </form>
                     <form action="/tenants/${encodeURIComponent(tenantId)}/agents/${encodeURIComponent(detail.agentId)}/environments/${encodeURIComponent(publication.environmentKey)}/overlay/disable" method="post">
                       <button class="button-secondary" type="submit">Disable Environment</button>
                     </form>
                   </div>
                 </article>`,
             )
             .join("")}
         </div>`;
  const versionHistoryMarkup =
    detail.versions.length === 0
      ? `<div class="agent-detail-empty stack">
           <p>No versions have been registered for this agent yet.</p>
         </div>`
      : `<div class="agent-detail-history-list">
           ${[...detail.versions]
             .reverse()
             .map(
               (version) =>
                 `<a class="agent-detail-history-item" href="/tenants/${encodeURIComponent(tenantId)}/agents/${encodeURIComponent(detail.agentId)}/versions/${encodeURIComponent(version.versionId)}">
                   <span class="shell-eyebrow">Version ${version.versionSequence}</span>
                   <strong>${escapeHtml(formatConsoleState(version.approvalState))}</strong>
                   <span class="meta">${version.versionId === detail.activeVersionId ? "Current active technical dossier" : "Open technical dossier"}</span>
                 </a>`,
             )
             .join("")}
         </div>`;
  const environmentOverlayCount = detail.overlay.environments.length;
  const activePublicationCount = detail.activeVersion?.publications.length ?? 0;

  return `<section class="card stack page-hero agent-detail-hero" data-visual-dynamic="agent-overview">
    <div class="agent-detail-hero__lead">
      <div class="agent-detail-signal">
        <span class="agent-detail-signal__pulse" aria-hidden="true"></span>
        <span class="shell-eyebrow">Active Agent Dossier</span>
      </div>
      <h1>${escapeHtml(detail.agentId)}</h1>
      <p class="meta">Truthful overlay state, published environments, and version history stay visible inside the shared technical curator shell.</p>
    </div>
    <div class="agent-detail-stats" aria-label="Agent detail summary">
      <div class="agent-detail-stat">
        <span class="shell-eyebrow">Tenant</span>
        <strong>${escapeHtml(tenantId)}</strong>
      </div>
      <div class="agent-detail-stat">
        <span class="shell-eyebrow">Active Version</span>
        <strong>${escapeHtml(detail.activeVersionId ?? "none")}</strong>
      </div>
      <div class="agent-detail-stat">
        <span class="shell-eyebrow">Published Environments</span>
        <strong>${activePublicationCount}</strong>
      </div>
      <div class="agent-detail-stat">
        <span class="shell-eyebrow">Overlay Environments</span>
        <strong>${environmentOverlayCount}</strong>
      </div>
    </div>
    <div class="agent-detail-pill-row">
      <span class="pill">Version history ${detail.versions.length}</span>
      <span class="pill">Agent overlay ${detail.overlay.agent.disabled ? "disabled" : detail.overlay.agent.deprecated ? "deprecated" : "clear"}</span>
      <span class="pill">Publication state ${escapeHtml(detail.activeVersion === null ? "no approved version" : formatConsoleState(detail.activeVersion.approvalState))}</span>
    </div>
  </section>
  <div class="agent-detail-grid">
    <section class="card stack agent-detail-panel" data-visual-dynamic="active-publications">
      <span class="shell-eyebrow">Published Surface</span>
      <h2>Active Publications</h2>
      <p class="meta">Current approved publications are shown exactly as they exist today, with no synthetic environments or metrics.</p>
      ${activePublicationMarkup}
    </section>
    <div class="agent-detail-side">
      <section class="card stack agent-detail-panel" data-visual-dynamic="overlay-state">
        <span class="shell-eyebrow">Policy Surface</span>
        <h2>Overlay Controls</h2>
        <p class="meta">Agent-level overlays remain obvious here while environment-level overlay state stays truthful below.</p>
        ${renderOverlaySummary("Agent overlay", detail.overlay.agent)}
        ${
          detail.overlay.environments.length === 0
            ? `<div class="agent-detail-empty stack">
                 <p>No environment overlays have been applied.</p>
               </div>`
            : `<div class="agent-detail-overlay-list">
                 ${detail.overlay.environments
                   .map((overlay) =>
                     renderOverlaySummary(`Environment overlay for ${overlay.environmentKey}`, overlay),
                   )
                   .join("")}
               </div>`
        }
        <div class="inline-actions">
          <form action="/tenants/${encodeURIComponent(tenantId)}/agents/${encodeURIComponent(detail.agentId)}/overlay/deprecate" method="post">
            <button type="submit">Deprecate Agent</button>
          </form>
          <form action="/tenants/${encodeURIComponent(tenantId)}/agents/${encodeURIComponent(detail.agentId)}/overlay/disable" method="post">
            <button class="button-secondary" type="submit">Disable Agent</button>
          </form>
        </div>
      </section>
      <section class="card stack agent-detail-panel" data-visual-dynamic="environment-controls">
        <span class="shell-eyebrow">Publication Actions</span>
        <h2>Environment Controls</h2>
        <p class="meta">Per-environment overlay actions continue to post to the current routes for each approved publication.</p>
        ${environmentControlMarkup}
      </section>
    </div>
  </div>
  <section class="card stack agent-detail-panel" data-visual-dynamic="version-history">
    <div class="agent-detail-section-head">
      <div class="stack">
        <span class="shell-eyebrow">Audit Trail</span>
        <h2>Version History</h2>
      </div>
      <p class="meta">Every version remains linked from the active detail page for direct dossier review.</p>
    </div>
    ${versionHistoryMarkup}
  </section>`;
}

import type { ResolvedPrincipal } from "@agent-registry/auth";

import { escapeHtml } from "../document.js";
import {
  renderActionCluster,
  renderPill,
  renderRecordList,
  renderStatTile,
} from "../primitives/index.js";

export interface DashboardVersionLink {
  agentId: string;
  approvalState: string;
  displayName: string;
  versionId: string;
  versionSequence: number;
}

export interface DashboardActiveAgentLink {
  agentId: string;
  displayName: string;
}

interface DashboardPageOptions {
  activeAgents: DashboardActiveAgentLink[];
  canPublish: boolean;
  isTenantAdmin: boolean;
  principal: Pick<ResolvedPrincipal, "roles" | "subjectId" | "tenantId">;
  tenantDisplayName: string;
  versions: DashboardVersionLink[];
}

function renderActionCard(action: {
  description: string;
  href: string;
  label: string;
  variant: "primary" | "secondary";
}): string {
  return `<a class="dashboard-action dashboard-action--${action.variant}" href="${escapeHtml(action.href)}">
    <span class="shell-eyebrow">${action.variant === "primary" ? "Publish Workflow" : "Tenant Operation"}</span>
    <strong>${escapeHtml(action.label)}</strong>
    <p>${escapeHtml(action.description)}</p>
  </a>`;
}

function renderVersionRow(options: {
  tenantId: string;
  version: DashboardVersionLink;
}): string {
  return `<a class="dashboard-record" href="/tenants/${encodeURIComponent(options.tenantId)}/agents/${encodeURIComponent(options.version.agentId)}/versions/${encodeURIComponent(options.version.versionId)}">
    <div class="dashboard-record__title">
      <strong>${escapeHtml(options.version.displayName)}</strong>
      <span class="dashboard-record__detail">v${options.version.versionSequence}</span>
    </div>
    <div class="dashboard-record__meta">
      <span class="dashboard-record__detail">Approval State</span>
      ${renderPill(options.version.approvalState)}
    </div>
  </a>`;
}

function renderAgentRow(options: {
  agent: DashboardActiveAgentLink;
  tenantId: string;
}): string {
  return `<a class="dashboard-record" href="/tenants/${encodeURIComponent(options.tenantId)}/agents/${encodeURIComponent(options.agent.agentId)}">
    <div class="dashboard-record__title">
      <strong>${escapeHtml(options.agent.displayName)}</strong>
      <span class="dashboard-record__detail">Active agent detail</span>
    </div>
    <div class="dashboard-record__meta">
      <span class="dashboard-record__detail">Current deployment</span>
      ${renderPill("Available")}
    </div>
  </a>`;
}

export function renderDashboardPage(options: DashboardPageOptions): string {
  const roleLabel = options.principal.roles.join(", ") || "No assigned roles";
  const actionCards: string[] = [];

  if (options.canPublish) {
    actionCards.push(
      renderActionCard({
        description: "Register a new draft with the current multipart submission flow.",
        href: `/tenants/${encodeURIComponent(options.principal.tenantId)}/drafts/new`,
        label: "New Draft Registration",
        variant: "primary",
      }),
    );
  }

  if (options.isTenantAdmin) {
    actionCards.push(
      renderActionCard({
        description: "Manage tenant environments using the existing environment catalog routes.",
        href: `/tenants/${encodeURIComponent(options.principal.tenantId)}/environments`,
        label: "Environment Management",
        variant: "secondary",
      }),
      renderActionCard({
        description: "Review pending versions with the live approval and rejection workflow.",
        href: `/tenants/${encodeURIComponent(options.principal.tenantId)}/review`,
        label: "Review Queue",
        variant: "secondary",
      }),
    );
  }

  return `<section class="dashboard-grid" data-dashboard-layout="bento">
    <article class="card dashboard-card dashboard-card--hero stack">
      <span class="shell-eyebrow">System Overview</span>
      <h1>Console Dashboard</h1>
      <p class="meta">Operate truthful draft, review, and environment workflows from the shared curator shell.</p>
      <div class="dashboard-metrics" aria-label="Dashboard summary metrics">
        ${renderStatTile({
          className: "dashboard-metric",
          description: options.isTenantAdmin
            ? "Across the tenant workspace."
            : "Available to this signed-in publisher.",
          eyebrow: "Visible Versions",
          includeBaseClass: false,
          value: versionsCount(options.versions),
        })}
        ${
          options.isTenantAdmin
            ? renderStatTile({
                className: "dashboard-metric",
                description: "Approved agents currently routed from this tenant.",
                eyebrow: "Active Agents",
                includeBaseClass: false,
                value: activeAgentsCount(options.activeAgents),
              })
            : renderStatTile({
                className: "dashboard-metric",
                description:
                  "Publisher workflows stay limited to current draft registration routes.",
                eyebrow: "Accessible Actions",
                includeBaseClass: false,
                value: String(actionCards.length),
              })
        }
      </div>
    </article>
    <article class="card dashboard-card dashboard-card--identity stack" data-visual-dynamic="dashboard-identity">
      <span class="shell-eyebrow">Signed-In Identity</span>
      <h2>Signed-In Identity</h2>
      <p><strong>${escapeHtml(options.principal.subjectId)}</strong></p>
      <p class="meta">Roles: ${escapeHtml(roleLabel)}</p>
    </article>
    <article class="card dashboard-card dashboard-card--tenant stack">
      <span class="shell-eyebrow">Tenant Context</span>
      <h2>Tenant Context</h2>
      <p><strong>${escapeHtml(options.tenantDisplayName)}</strong></p>
      <p class="meta">${escapeHtml(options.principal.tenantId)}</p>
    </article>
    <article class="card dashboard-card dashboard-card--actions stack" data-visual-dynamic="dashboard-actions">
      <span class="shell-eyebrow">Workspace Actions</span>
      <h2>Workspace Actions</h2>
      ${renderActionCluster({
        actions: actionCards,
        className: "dashboard-action-grid",
      })}
    </article>
    <article class="card dashboard-card dashboard-card--versions stack">
      <span class="shell-eyebrow">Version Register</span>
      <h2>Visible Versions</h2>
      ${renderRecordList({
        attributes: {
          "data-visual-dynamic": "dashboard-versions",
        },
        emptyState: '<p class="dashboard-empty">No versions are visible for this workspace yet.</p>',
        items: options.versions.map((version) =>
          renderVersionRow({
            tenantId: options.principal.tenantId,
            version,
          }),
        ),
        listClassName: "dashboard-record-list",
      })}
    </article>
    ${
      options.isTenantAdmin
        ? `<article class="card dashboard-card dashboard-card--active-agents stack">
             <span class="shell-eyebrow">Operational Inventory</span>
             <h2>Active Agents</h2>
             ${renderRecordList({
               attributes: {
                 "data-visual-dynamic": "dashboard-active-agents",
               },
               emptyState:
                 '<p class="dashboard-empty">No active agents are published in this tenant yet.</p>',
               items: options.activeAgents.map((agent) =>
                 renderAgentRow({
                   agent,
                   tenantId: options.principal.tenantId,
                 }),
               ),
               listClassName: "dashboard-record-list",
             })}
           </article>`
        : ""
    }
  </section>`;
}

function versionsCount(versions: DashboardVersionLink[]): string {
  return String(versions.length);
}

function activeAgentsCount(activeAgents: DashboardActiveAgentLink[]): string {
  return String(activeAgents.length);
}

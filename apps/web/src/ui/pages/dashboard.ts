import type { ResolvedPrincipal } from "@agent-registry/auth";

import { escapeHtml } from "../document.js";
import {
  renderActionCluster,
  renderCardHead,
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
    <span class="shell-eyebrow">${action.variant === "primary" ? "Primary Workflow" : "Supporting Route"}</span>
    <strong>${escapeHtml(action.label)}</strong>
    <p>${escapeHtml(action.description)}</p>
  </a>`;
}

function renderVersionRow(options: {
  isLatest: boolean;
  tenantId: string;
  version: DashboardVersionLink;
}): string {
  return `<a class="dashboard-record" href="/tenants/${encodeURIComponent(options.tenantId)}/agents/${encodeURIComponent(options.version.agentId)}/versions/${encodeURIComponent(options.version.versionId)}">
    <div class="dashboard-record__title">
      <div class="dashboard-record__heading">
        <strong>${escapeHtml(options.version.displayName)}</strong>
        <span class="dashboard-record__detail">v${options.version.versionSequence}</span>
      </div>
      <div class="dashboard-record__signals">
        ${options.isLatest ? renderPill("Latest") : ""}
        ${renderPill(options.version.approvalState)}
      </div>
    </div>
  </a>`;
}

function renderAgentRow(options: {
  agent: DashboardActiveAgentLink;
  tenantId: string;
}): string {
  return `<a class="dashboard-record" href="/tenants/${encodeURIComponent(options.tenantId)}/agents/${encodeURIComponent(options.agent.agentId)}">
    <div class="dashboard-record__title">
      <div class="dashboard-record__heading">
        <strong>${escapeHtml(options.agent.displayName)}</strong>
        <span class="dashboard-record__detail">Active agent detail</span>
      </div>
      <div class="dashboard-record__signals">
        ${renderPill("Published")}
      </div>
    </div>
    <p class="dashboard-record__detail">Current approved publications remain accessible through the tenant admin dossier.</p>
  </a>`;
}

export function renderDashboardPage(options: DashboardPageOptions): string {
  const roleLabel = options.principal.roles.join(", ") || "No assigned roles";
  const tenantId = options.principal.tenantId;
  const primaryActionHref = `/tenants/${encodeURIComponent(tenantId)}/drafts/new`;
  const actionCards: string[] = [];

  if (options.canPublish) {
    actionCards.push(
      renderActionCard({
        description: "Register a new draft with the current multipart submission flow.",
        href: primaryActionHref,
        label: "New Draft Registration",
        variant: "primary",
      }),
    );
  }

  if (options.isTenantAdmin) {
    actionCards.push(
      renderActionCard({
        description: "Manage tenant environments using the existing environment catalog routes.",
        href: `/tenants/${encodeURIComponent(tenantId)}/environments`,
        label: "Environment Management",
        variant: "secondary",
      }),
      renderActionCard({
        description: "Review pending versions with the live approval and rejection workflow.",
        href: `/tenants/${encodeURIComponent(tenantId)}/review`,
        label: "Review Queue",
        variant: "secondary",
      }),
    );
  }

  const heroMetrics = [
    renderStatTile({
      className: "dashboard-metric",
      description: options.isTenantAdmin
        ? "Across the tenant workspace."
        : "Available to this signed-in publisher.",
      eyebrow: "Visible Versions",
      includeBaseClass: false,
      value: String(options.versions.length),
    }),
    renderStatTile({
      className: "dashboard-metric",
      description: options.isTenantAdmin
        ? "Approved agents currently routed from this tenant."
        : "Publisher workflows stay limited to current draft registration routes.",
      eyebrow: options.isTenantAdmin ? "Active Agents" : "Accessible Actions",
      includeBaseClass: false,
      value: String(options.isTenantAdmin ? options.activeAgents.length : actionCards.length),
    }),
  ].join("");

  const heroActionMarkup = options.canPublish
    ? `<a class="dashboard-feature__cta" href="${escapeHtml(primaryActionHref)}">New Draft Registration</a>`
    : '<p class="dashboard-feature__note">Publishing workflows are unavailable for the current role.</p>';

  return `<section class="dashboard-overview stack">
    <header class="dashboard-intro">
      <div class="dashboard-intro__copy stack">
        <span class="shell-eyebrow">Agent Console</span>
        <h1>System Overview</h1>
        <p class="meta">Welcome back, <strong>${escapeHtml(options.principal.subjectId)}</strong>. You are managing the <strong>${escapeHtml(options.tenantDisplayName)}</strong> tenant workspace.</p>
      </div>
      <article class="card dashboard-card dashboard-card--identity stack" data-dashboard-panel="identity">
        <span class="shell-eyebrow">Signed-In Identity</span>
        <div class="dashboard-identity-body stack" data-visual-dynamic="dashboard-identity">
        <h2>${escapeHtml(options.principal.subjectId)}</h2>
        <p class="meta">${escapeHtml(roleLabel)}</p>
        <dl class="dashboard-context-list">
          <div>
            <dt>Tenant</dt>
            <dd>${escapeHtml(tenantId)}</dd>
          </div>
          <div>
            <dt>Access</dt>
            <dd>${escapeHtml(options.isTenantAdmin ? "Tenant administration and publishing" : "Publisher workflow access")}</dd>
          </div>
        </dl>
        </div>
      </article>
    </header>
    <section class="dashboard-grid" data-dashboard-layout="bento">
      <article class="card dashboard-card dashboard-card--hero stack" data-dashboard-panel="primary-feature">
        <div class="dashboard-feature__lead stack">
          <span class="shell-eyebrow">Primary Workflow</span>
          <h2>Draft Creation</h2>
          <p>Register a new draft with the current multipart submission flow, then continue review from the live version dossier once submission is ready.</p>
        </div>
        <div class="dashboard-metrics" aria-label="Dashboard summary metrics">
          ${heroMetrics}
        </div>
        ${heroActionMarkup}
      </article>
      <article class="card dashboard-card dashboard-card--tenant stack" data-dashboard-panel="tenant">
        <span class="shell-eyebrow">Tenant Context</span>
        <h2>${escapeHtml(options.tenantDisplayName)}</h2>
        <p class="meta">${escapeHtml(tenantId)}</p>
        <p>${options.isTenantAdmin ? "Tenant admins see the full version register and the active publication inventory for this workspace." : "Publishers see only versions they own while retaining direct access to the draft workflow."}</p>
      </article>
      <article class="card dashboard-card dashboard-card--actions stack" data-dashboard-panel="supporting-actions">
        ${renderCardHead({
          className: "dashboard-section-head",
          description: options.isTenantAdmin
            ? "Use the existing routes for draft registration, environment management, and live review."
            : "The shared dashboard keeps the current publisher workflow narrow and truthful.",
          eyebrow: "Workspace Actions",
          title: "Workspace Actions",
        })}
        ${renderActionCluster({
          actions: actionCards,
          attributes: {
            "data-visual-dynamic": "dashboard-actions",
          },
          className: "dashboard-action-grid",
        })}
      </article>
      <article class="card dashboard-card dashboard-card--versions stack" data-dashboard-panel="version-register">
        ${renderCardHead({
          className: "dashboard-section-head",
          description: "Visible versions stay linked directly to the existing version-detail dossier.",
          eyebrow: "Available Versions",
          title: "Visible Versions",
        })}
        ${renderRecordList({
          attributes: {
            "data-visual-dynamic": "dashboard-versions",
          },
          emptyState: '<p class="dashboard-empty">No versions are visible for this workspace yet.</p>',
          items: options.versions.map((version, index) =>
            renderVersionRow({
              isLatest: index === 0,
              tenantId,
              version,
            }),
          ),
          listClassName: "dashboard-record-list",
        })}
      </article>
      ${
        options.isTenantAdmin
          ? `<article class="card dashboard-card dashboard-card--active-agents stack" data-dashboard-panel="active-agents">
               ${renderCardHead({
                 className: "dashboard-section-head",
                 description:
                   "Approved agents stay visible here only when both agent and environment overlays remain enabled.",
                 eyebrow: "Operational Inventory",
                 title: "Active Agents",
               })}
               ${renderRecordList({
                 attributes: {
                   "data-visual-dynamic": "dashboard-active-agents",
                 },
                 emptyState:
                   '<p class="dashboard-empty">No active agents are published in this tenant yet.</p>',
                 items: options.activeAgents.map((agent) =>
                   renderAgentRow({
                     agent,
                     tenantId,
                   }),
                 ),
                 listClassName: "dashboard-record-list",
               })}
             </article>`
          : ""
      }
    </section>
  </section>`;
}

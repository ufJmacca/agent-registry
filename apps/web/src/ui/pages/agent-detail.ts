import type { AgentAdminDetailRecord } from "@agent-registry/db";

import { escapeHtml } from "../document.js";
import {
  formatConsoleState,
  renderCardHead,
  renderEmptyState,
  renderPageHero,
  renderPill,
  renderRecordList,
  renderSectionFrame,
  renderSidePanel,
  renderStatTile,
} from "../primitives/index.js";

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
    ${renderCardHead({
      eyebrow: "Overlay State",
      title: label,
      titleTag: "h3",
    })}
    <p>Deprecated: ${overlay.deprecated ? "yes" : "no"}</p>
    <p>Disabled: ${overlay.disabled ? "yes" : "no"}</p>
    <p>Required roles: ${escapeHtml(overlay.requiredRoles.join(", ") || "none")}</p>
    <p>Required scopes: ${escapeHtml(overlay.requiredScopes.join(", ") || "none")}</p>
  </article>`;
}

function renderActivePublications(detail: AgentAdminDetailRecord): string {
  if (detail.activeVersion === null) {
    return renderEmptyState({
      body: "Approve a version to expose truthful publication health, endpoints, and per-environment controls.",
      className: "agent-detail-empty",
      eyebrow: "Published Surface",
      title: "No active approved version is currently published.",
    });
  }

  return renderRecordList({
    items: detail.activeVersion.publications.map(
      (publication) =>
        `<article class="agent-detail-publication-card stack">
          ${renderCardHead({
            eyebrow: "Environment Publication",
            title: publication.environmentKey,
            titleTag: "h3",
            trailingContent: renderPill(publication.healthStatus ?? "unknown"),
          })}
          <p class="meta">Version ${detail.activeVersion?.versionSequence ?? "n/a"} · ${escapeHtml(formatConsoleState(detail.activeVersion?.approvalState ?? "unknown"))}</p>
          <p>Health endpoint: <code>${escapeHtml(publication.healthEndpointUrl)}</code></p>
        </article>`,
    ),
    listClassName: "record-list record-list--publication-cards agent-detail-publication-list",
  });
}

function renderEnvironmentControls(
  detail: AgentAdminDetailRecord,
  tenantId: string,
): string {
  if (detail.activeVersion === null) {
    return renderEmptyState({
      body: "Version history remains available while approval is pending.",
      className: "agent-detail-empty",
      eyebrow: "Publication Actions",
      title: "No environment overlays can be applied until an approved version is active.",
    });
  }

  return renderRecordList({
    items: detail.activeVersion.publications.map(
      (publication) =>
        `<article class="agent-detail-control-card stack">
          ${renderCardHead({
            eyebrow: "Environment Controls",
            title: publication.environmentKey,
            titleTag: "h3",
            trailingContent: renderPill(`Health ${publication.healthStatus ?? "unknown"}`),
          })}
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
    ),
    listClassName: "record-list record-list--environment-controls agent-detail-control-list",
  });
}

function renderVersionHistory(detail: AgentAdminDetailRecord, tenantId: string): string {
  if (detail.versions.length === 0) {
    return renderEmptyState({
      body: "Version history becomes available as soon as technical dossiers are registered for this agent.",
      className: "agent-detail-empty",
      eyebrow: "Audit Trail",
      title: "No versions have been registered for this agent yet.",
    });
  }

  return renderRecordList({
    items: [...detail.versions]
      .reverse()
      .map(
        (version) =>
          `<a class="agent-detail-history-item" href="/tenants/${encodeURIComponent(tenantId)}/agents/${encodeURIComponent(detail.agentId)}/versions/${encodeURIComponent(version.versionId)}">
            <span class="shell-eyebrow">Version ${version.versionSequence}</span>
            <strong>${escapeHtml(formatConsoleState(version.approvalState))}</strong>
            <span class="meta">${version.versionId === detail.activeVersionId ? "Current active technical dossier" : "Open technical dossier"}</span>
          </a>`,
      ),
    listClassName: "record-list record-list--history agent-detail-history-list",
  });
}

export function renderAgentDetailPage(options: AgentDetailPageOptions): string {
  const { detail, tenantId } = options;
  const environmentOverlayCount = detail.overlay.environments.length;
  const activePublicationCount = detail.activeVersion?.publications.length ?? 0;
  const overlayEnvironmentMarkup =
    detail.overlay.environments.length === 0
      ? renderEmptyState({
          body: "Agent-level overlay controls remain available above even when no environment-specific policies have been applied.",
          className: "agent-detail-empty",
          eyebrow: "Environment Overlay State",
          title: "No environment overlays have been applied.",
        })
      : renderRecordList({
          items: detail.overlay.environments.map((overlay) =>
            renderOverlaySummary(`Environment overlay for ${overlay.environmentKey}`, overlay),
          ),
          listClassName: "record-list record-list--overlay-state agent-detail-overlay-list",
        });

  return `<div class="agent-detail-layout" data-agent-detail-layout="dossier">
    ${renderPageHero({
      attributes: {
        "data-visual-dynamic": "agent-overview",
      },
      body: `<div class="agent-detail-hero__lead">
        <div class="agent-detail-signal">
          <span class="agent-detail-signal__pulse" aria-hidden="true"></span>
          <span class="shell-eyebrow">Active Agent Dossier</span>
        </div>
        <h1>${escapeHtml(detail.agentId)}</h1>
        <p class="meta">Truthful overlay state, published environments, and version history stay visible inside the shared technical curator shell.</p>
      </div>
      <div class="agent-detail-stats" aria-label="Agent detail summary">
        ${renderStatTile({
          className: "agent-detail-stat",
          eyebrow: "Tenant",
          value: tenantId,
        })}
        ${renderStatTile({
          className: "agent-detail-stat",
          eyebrow: "Active Version",
          value: detail.activeVersionId ?? "none",
        })}
        ${renderStatTile({
          className: "agent-detail-stat",
          eyebrow: "Published Environments",
          value: String(activePublicationCount),
        })}
        ${renderStatTile({
          className: "agent-detail-stat",
          eyebrow: "Overlay Environments",
          value: String(environmentOverlayCount),
        })}
      </div>
      <div class="agent-detail-pill-row">
        ${renderPill(`Version history ${detail.versions.length}`)}
        ${renderPill(`Agent overlay ${detail.overlay.agent.disabled ? "disabled" : detail.overlay.agent.deprecated ? "deprecated" : "clear"}`)}
        ${renderPill(`Publication state ${detail.activeVersion === null ? "no approved version" : formatConsoleState(detail.activeVersion.approvalState)}`)}
      </div>`,
      className: "card stack agent-detail-hero page-hero--dossier",
    })}
    <div class="agent-detail-grid">
      ${renderSectionFrame({
        attributes: {
          "data-visual-dynamic": "active-publications",
        },
        body: renderActivePublications(detail),
        className: "card stack agent-detail-panel",
        description: "Current approved publications are shown exactly as they exist today, with no synthetic environments or metrics.",
        eyebrow: "Published Surface",
        title: "Active Publications",
      })}
      ${renderSidePanel({
        attributes: {
          "data-agent-detail-side": "stack",
        },
        className: "agent-detail-side",
        sections: [
          renderSectionFrame({
            attributes: {
              "data-visual-dynamic": "overlay-state",
            },
            body: `${renderOverlaySummary("Agent overlay", detail.overlay.agent)}
              ${overlayEnvironmentMarkup}
              <div class="inline-actions">
                <form action="/tenants/${encodeURIComponent(tenantId)}/agents/${encodeURIComponent(detail.agentId)}/overlay/deprecate" method="post">
                  <button type="submit">Deprecate Agent</button>
                </form>
                <form action="/tenants/${encodeURIComponent(tenantId)}/agents/${encodeURIComponent(detail.agentId)}/overlay/disable" method="post">
                  <button class="button-secondary" type="submit">Disable Agent</button>
                </form>
              </div>`,
            className: "card stack agent-detail-panel",
            description: "Agent-level overlays remain obvious here while environment-level overlay state stays truthful below.",
            eyebrow: "Policy Surface",
            title: "Overlay Controls",
          }),
          renderSectionFrame({
            attributes: {
              "data-visual-dynamic": "environment-controls",
            },
            body: renderEnvironmentControls(detail, tenantId),
            className: "card stack agent-detail-panel",
            description: "Per-environment overlay actions continue to post to the current routes for each approved publication.",
            eyebrow: "Publication Actions",
            title: "Environment Controls",
          }),
        ],
      })}
    </div>
    ${renderSectionFrame({
      attributes: {
        "data-visual-dynamic": "version-history",
      },
      body: renderVersionHistory(detail, tenantId),
      className: "card stack agent-detail-panel",
      description: "Every version remains linked from the active detail page for direct dossier review.",
      eyebrow: "Audit Trail",
      title: "Version History",
    })}
  </div>`;
}
